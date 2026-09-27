export const MODELS = {
  small: { id: 'onnx-community/whisper-small_timestamped', mb: 250, name: 'groß, für Lieder', next: 'base' },
  base: { id: 'onnx-community/whisper-base_timestamped', mb: 77, name: 'mittel', next: 'tiny' },
  tiny: { id: 'onnx-community/whisper-tiny_timestamped', mb: 41, name: 'klein', next: null },
};

export const LANGUAGES = { auto: 'Automatisch', de: 'Deutsch', tr: 'Türkisch', en: 'Englisch' };

let worker = null;
let seq = 0;
const jobs = new Map();
const TIMEOUT = 150000;

function kill(reason) {
  if (worker) worker.terminate();
  worker = null;
  for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(new Error(reason)); }
  jobs.clear();
}

function arm(job) {
  clearTimeout(job.timer);
  job.timer = setTimeout(() => kill('Die Texterkennung reagiert nicht mehr. Vermutlich hat das Gerät sie wegen Speichermangel beendet.'), TIMEOUT);
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./transkript-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      const job = jobs.get(m.id);
      if (!job) return;
      arm(job);
      const done = (fn) => { clearTimeout(job.timer); jobs.delete(m.id); fn(); };
      if (m.type === 'laden') job.onStatus({ phase: 'laden', progress: m.progress });
      else if (m.type === 'geladen') { job.onStatus({ phase: 'geladen' }); if (job.onlyLoad) done(() => job.resolve(null)); }
      else if (m.type === 'erkennen') job.onStatus({ phase: 'erkennen', progress: m.progress });
      else if (m.type === 'sprache') job.onStatus({ phase: 'sprache', code: m.code });
      else if (m.type === 'fertig') done(() => job.resolve({ words: m.words, code: m.code }));
      else if (m.type === 'fehler') done(() => job.reject(new Error(m.message)));
    };
    worker.onerror = (e) => kill('Texterkennung abgestürzt: ' + (e.message || 'unbekannter Fehler'));
    worker.onmessageerror = () => kill('Texterkennung: Nachricht nicht lesbar');
  }
  return worker;
}

export function releaseTranscriber() {
  if (worker && !jobs.size) { worker.terminate(); worker = null; }
}

export function transcribe(samples16k, model, language, onStatus = () => {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const job = { resolve, reject, onStatus };
    jobs.set(id, job);
    arm(job);
    const copy = new Float32Array(samples16k);
    try { getWorker().postMessage({ id, audio: copy, model, language }, [copy.buffer]); }
    catch (err) { kill('Texterkennung ließ sich nicht starten: ' + err.message); }
  });
}

const JUNK = /untertitel|amara\.org|zdf|swr|vielen dank f(ü|ue)rs zuschauen|copyright/i;

export function cleanWords(words, track) {
  const lv = [...track.level].sort((a, b) => a - b);
  const gate = Math.max(0.004, (lv[Math.floor(lv.length * 0.95)] || 0) * 0.08);
  const hop = track.hop;
  words = words.map((w, i) => {
    const next = words[i + 1];
    if (w.end - w.start > 1.5 && next && next.start - w.end < 0.1) return { ...w, start: w.end - 0.8 };
    return w;
  });
  return words.filter((w) => {
    if (JUNK.test(w.text)) return false;
    const a = Math.max(0, Math.floor((w.start - 0.3) / hop)), b = Math.min(track.level.length - 1, Math.ceil((w.end + 0.3) / hop));
    for (let i = a; i <= b; i++) if (track.level[i] > gate) return true;
    return false;
  });
}

export function wordsToText(words) {
  const lines = [];
  let line = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (line.length && prev && (w.start - prev.end > 0.9 || /[.!?]$/.test(prev.text) || (line.length >= 5 && /,$/.test(prev.text)) || line.length >= 9)) {
      lines.push(line.join(' '));
      line = [];
    }
    line.push(w.text);
  });
  if (line.length) lines.push(line.join(' '));
  return lines.join('\n');
}
