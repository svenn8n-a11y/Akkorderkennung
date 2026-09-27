let worker = null;
let seq = 0;
const jobs = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./transkript-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const job = jobs.get(e.data.id);
      if (!job) return;
      const m = e.data;
      if (m.type === 'laden') job.onStatus({ phase: 'laden', progress: m.progress });
      else if (m.type === 'geladen') { job.onStatus({ phase: 'geladen' }); if (job.onlyLoad) { jobs.delete(m.id); job.resolve(null); } }
      else if (m.type === 'erkennen') job.onStatus({ phase: 'erkennen' });
      else if (m.type === 'fertig') { jobs.delete(m.id); job.resolve(m.words); }
      else if (m.type === 'fehler') { jobs.delete(m.id); job.reject(new Error(m.message)); }
    };
    worker.onerror = (e) => {
      for (const job of jobs.values()) job.reject(new Error(e.message || 'Texterkennung abgestürzt'));
      jobs.clear();
      worker = null;
    };
  }
  return worker;
}

export function transcribe(samples16k, onStatus = () => {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject, onStatus });
    const copy = new Float32Array(samples16k);
    getWorker().postMessage({ id, audio: copy }, [copy.buffer]);
  });
}

export function preloadModel(onStatus = () => {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject, onStatus, onlyLoad: true });
    getWorker().postMessage({ id, onlyLoad: true });
  });
}

const JUNK = /untertitel|amara\.org|zdf|swr|vielen dank f(ü|ue)rs zuschauen|copyright/i;

export function cleanWords(words, notes) {
  return words.filter((w) => {
    if (JUNK.test(w.text)) return false;
    if (!notes.length) return true;
    return notes.some((n) => n.end > w.start - 0.4 && n.start < w.end + 0.4);
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
