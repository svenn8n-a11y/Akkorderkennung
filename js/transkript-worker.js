import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';

env.allowLocalModels = false;

let asr = null;
let loadedModel = null;

function load(model, onProgress) {
  if (!asr || loadedModel !== model) {
    loadedModel = model;
    asr = pipeline('automatic-speech-recognition', model, {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      device: 'wasm',
      progress_callback: (x) => {
        if (x.status === 'progress_total') onProgress(x.progress);
      },
    }).catch((err) => { asr = null; throw err; });
  }
  return asr;
}

self.onmessage = async (e) => {
  const { id, audio, onlyLoad, model } = e.data;
  try {
    const run = await load(model, (p) => self.postMessage({ id, type: 'laden', progress: p }));
    self.postMessage({ id, type: 'geladen' });
    if (onlyLoad) return;
    const SR = 16000, WIN = 30 * SR, STEP = 26 * SR;
    const words = [];
    self.postMessage({ id, type: 'erkennen', progress: 0 });
    for (let off = 0; off < audio.length; off += STEP) {
      const last = off + WIN >= audio.length;
      const seg = audio.subarray(off, Math.min(audio.length, off + WIN));
      const out = await run(seg, { language: 'german', task: 'transcribe', return_timestamps: 'word' });
      const t0 = off / SR;
      const from = off ? t0 + 2 : 0;
      const to = last ? Infinity : t0 + 28;
      for (const c of out.chunks || []) {
        const end = t0 + (c.timestamp[1] ?? c.timestamp[0]);
        let start = t0 + c.timestamp[0];
        if (c.timestamp[0] < 0.2 && end - start > 1) start = end - 0.8;
        const text = c.text.trim();
        if (text && start >= from && start < to) words.push({ text, start, end });
      }
      self.postMessage({ id, type: 'erkennen', progress: Math.min(1, (off + WIN) / audio.length) });
      if (last) break;
    }
    self.postMessage({ id, type: 'fertig', words });
  } catch (err) {
    self.postMessage({ id, type: 'fehler', message: String(err?.message || err) });
  }
};
