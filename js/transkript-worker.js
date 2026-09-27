import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';

env.allowLocalModels = false;

const MODEL = 'onnx-community/whisper-base_timestamped';
let asr = null;

function load(onProgress) {
  if (!asr) {
    asr = pipeline('automatic-speech-recognition', MODEL, {
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
  const { id, audio, onlyLoad } = e.data;
  try {
    const run = await load((p) => self.postMessage({ id, type: 'laden', progress: p }));
    self.postMessage({ id, type: 'geladen' });
    if (onlyLoad) return;
    self.postMessage({ id, type: 'erkennen' });
    const out = await run(audio, {
      language: 'german',
      task: 'transcribe',
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const words = (out.chunks || [])
      .map((c) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] }))
      .filter((w) => w.text);
    self.postMessage({ id, type: 'fertig', words });
  } catch (err) {
    self.postMessage({ id, type: 'fehler', message: String(err?.message || err) });
  }
};
