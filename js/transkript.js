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
      else if (m.type === 'erkennen') job.onStatus({ phase: 'erkennen', progress: m.progress });
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
