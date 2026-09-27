import { yin, rms } from './pitch.js';
import { freqToMidi, midiToFreq, mod12, chordTones } from './musik.js';
import { shapeFor } from './gitarre.js';

let ctx = null;
export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('kein-mikro');
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

export function stopStream(stream) { stream?.getTracks().forEach((t) => t.stop()); }

function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* nächster Typ */ }
  }
  return '';
}

export class Recorder {
  constructor(stream) {
    this.stream = stream;
    this.chunks = [];
    const mime = pickMime();
    if (mime === null) throw new Error('kein-recorder');
    this.rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    this.rec.ondataavailable = (e) => e.data && e.data.size && this.chunks.push(e.data);
  }
  start() { this.rec.start(1000); this.startedAt = performance.now(); }
  stop() {
    return new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/mp4' }));
      this.rec.stop();
    });
  }
}

export class LiveInput {
  constructor(stream, fftSize = 2048) {
    const c = audioCtx();
    this.src = c.createMediaStreamSource(stream);
    this.an = c.createAnalyser();
    this.an.fftSize = fftSize;
    this.an.smoothingTimeConstant = 0;
    this.src.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize);
    this.sr = c.sampleRate;
  }
  pitch() {
    this.an.getFloatTimeDomainData(this.buf);
    const level = rms(this.buf);
    if (level < 0.008) return { level, midi: null };
    const size = Math.min(this.buf.length, 2048);
    const r = yin(this.buf, this.sr, this.buf.length - size, size);
    if (!r || r.conf < 0.8) return { level, midi: null };
    return { level, midi: freqToMidi(r.freq), freq: r.freq, conf: r.conf };
  }
  close() { try { this.src.disconnect(); } catch (e) { /* schon getrennt */ } }
}

const TEMPLATES = [];
for (let root = 0; root < 12; root++) {
  for (const qual of ['', 'm', '7']) {
    const v = new Array(12).fill(0);
    chordTones({ root, qual }).forEach((pc, i) => {
      const w = i === 3 ? 0.7 : 1;
      v[pc] += w; v[mod12(pc + 7)] += 0.35 * w; v[mod12(pc + 4)] += 0.15 * w;
    });
    const m = v.reduce((a, b) => a + b, 0) / 12;
    const c = v.map((x) => x - m);
    const n = Math.hypot(...c);
    TEMPLATES.push({ root, qual, v: c.map((x) => x / n) });
  }
}

export class ChordListener {
  constructor(stream) {
    const c = audioCtx();
    this.src = c.createMediaStreamSource(stream);
    this.an = c.createAnalyser();
    this.an.fftSize = 16384;
    this.an.smoothingTimeConstant = 0.5;
    this.src.connect(this.an);
    this.freq = new Float32Array(this.an.frequencyBinCount);
    this.time = new Float32Array(2048);
    this.sr = c.sampleRate;
    this.chroma = new Array(12).fill(0);
    this.map = [];
    const binHz = this.sr / this.an.fftSize;
    for (let k = 1; k < this.freq.length; k++) {
      const f = k * binHz;
      if (f < 75 || f > 1800) continue;
      this.map.push([k, mod12(Math.round(freqToMidi(f)))]);
    }
  }
  read() {
    this.an.getFloatTimeDomainData(this.time);
    const level = rms(this.time);
    this.an.getFloatFrequencyData(this.freq);
    const ch = new Array(12).fill(0);
    for (const [k, pc] of this.map) {
      const db = this.freq[k];
      if (db < -90) continue;
      ch[pc] += Math.pow(10, db / 20);
    }
    const mx = Math.max(...ch) || 1;
    for (let i = 0; i < 12; i++) this.chroma[i] = 0.6 * this.chroma[i] + 0.4 * (ch[i] / mx);
    if (level < 0.01) return { level, chord: null, chroma: this.chroma };
    const m = this.chroma.reduce((a, b) => a + b, 0) / 12;
    const c = this.chroma.map((x) => x - m);
    const n = Math.hypot(...c) || 1;
    let best = null, bs = -1, second = -1;
    for (const t of TEMPLATES) {
      let s = 0;
      for (let i = 0; i < 12; i++) s += (c[i] / n) * t.v[i];
      if (t.qual === '7') s -= 0.04;
      if (s > bs) { second = bs; bs = s; best = t; } else if (s > second) second = s;
    }
    return { level, chord: bs > 0.6 ? { root: best.root, qual: best.qual } : null, score: bs, chroma: this.chroma };
  }
  close() { try { this.src.disconnect(); } catch (e) { /* schon getrennt */ } }
}

const pluckCache = new Map();
function pluck(midi) {
  const c = audioCtx();
  const key = midi + ':' + c.sampleRate;
  if (pluckCache.has(key)) return pluckCache.get(key);
  const sr = c.sampleRate, len = Math.floor(sr * 2.2);
  const buf = c.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const period = sr / midiToFreq(midi);
  const N = Math.max(2, Math.round(period));
  const line = new Float32Array(N);
  for (let i = 0; i < N; i++) line[i] = Math.random() * 2 - 1;
  let prev = 0;
  for (let i = 0; i < N; i++) { const v = 0.5 * (line[i] + prev); prev = line[i]; line[i] = v; }
  const decay = 0.996;
  for (let i = 0; i < len; i++) {
    const j = i % N;
    const next = line[(j + 1) % N];
    const v = line[j];
    d[i] = v;
    line[j] = decay * 0.5 * (v + next);
  }
  pluckCache.set(key, buf);
  return buf;
}

const STRINGS = [40, 45, 50, 55, 59, 64];

export class Player {
  constructor() { this.nodes = []; this.playing = false; }

  playSynth({ events, slots, sec16, fromS16 = 0, speed = 1, melody = true, chords = true, click = false, barLen = 16, onEnd }) {
    this.stop();
    const c = audioCtx();
    const master = c.createGain();
    master.gain.value = 0.9;
    master.connect(c.destination);
    this.master = master;
    const step = sec16 / speed;
    const t0 = c.currentTime + 0.12;
    const at = (s16) => t0 + (s16 - fromS16) * step;
    if (melody) {
      for (const ev of events) {
        if (ev.midi === null || ev.s16 + ev.d16 <= fromS16) continue;
        const s = Math.max(ev.s16, fromS16);
        const start = at(s), end = at(ev.s16 + ev.d16) - 0.02;
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = midiToFreq(ev.midi);
        const g = c.createGain();
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(0.28, start + 0.02);
        g.gain.setTargetAtTime(0.18, start + 0.03, 0.15);
        g.gain.setTargetAtTime(0, Math.max(start + 0.04, end), 0.03);
        o.connect(g).connect(master);
        o.start(start);
        o.stop(end + 0.2);
        this.nodes.push(o);
      }
    }
    if (chords) {
      for (const sl of slots) {
        if (!sl.chord) continue;
        for (let b = 0; b < sl.len16; b += 4) {
          const pos = sl.start16 + b;
          if (pos < fromS16) continue;
          const { frets } = shapeFor(sl.chord);
          const accent = b === 0 ? 0.32 : 0.2;
          frets.forEach((f, i) => {
            if (f < 0) return;
            const src = c.createBufferSource();
            src.buffer = pluck(STRINGS[i] + f);
            const g = c.createGain();
            const st = at(pos) + i * 0.012;
            g.gain.setValueAtTime(accent, st);
            g.gain.setTargetAtTime(0, at(pos + 4) - 0.01, 0.05);
            src.connect(g).connect(master);
            src.start(st);
            src.stop(at(pos + 4) + 0.3);
            this.nodes.push(src);
          });
        }
      }
    }
    const endS16 = Math.max(...events.map((e) => e.s16 + e.d16), fromS16);
    if (click) {
      for (let b = Math.ceil(fromS16 / 4) * 4; b < endS16; b += 4) this.nodes.push(metronomeClick(at(b), b % barLen === 0, master));
    }
    this.playing = true;
    this.pos = () => fromS16 + (c.currentTime - t0) / step;
    this.timer = setTimeout(() => { this.stop(); onEnd && onEnd(); }, (at(endS16) - c.currentTime + 0.3) * 1000);
  }

  playOriginal({ audioEl, originSec, sec16, fromS16 = 0, speed = 1, onEnd, onError }) {
    this.stop();
    this.audioEl = audioEl;
    audioEl.playbackRate = speed;
    audioEl.preservesPitch = true;
    audioEl.webkitPreservesPitch = true;
    audioEl.currentTime = Math.max(0, originSec + fromS16 * sec16);
    audioEl.onended = () => { this.stop(); onEnd && onEnd(); };
    const p = audioEl.play();
    if (p && p.catch) p.catch((err) => { this.stop(); onError && onError(err); });
    this.playing = true;
    this.pos = () => (audioEl.currentTime - originSec) / sec16;
  }

  stop() {
    clearTimeout(this.timer);
    this.nodes.forEach((n) => { try { n.stop(); } catch (e) { /* schon gestoppt */ } });
    this.nodes = [];
    if (this.master) { try { this.master.disconnect(); } catch (e) { /* schon getrennt */ } this.master = null; }
    if (this.audioEl) { this.audioEl.pause(); this.audioEl.onended = null; this.audioEl = null; }
    this.playing = false;
    this.pos = null;
  }
}

let clickBuf = null;
export function metronomeClick(time, accent, dest) {
  const c = audioCtx();
  if (!clickBuf) {
    clickBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.03), c.sampleRate);
    const d = clickBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.004));
  }
  const src = c.createBufferSource();
  src.buffer = clickBuf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = accent ? 3200 : 2200;
  f.Q.value = 1.2;
  const g = c.createGain();
  g.gain.value = accent ? 1.6 : 1.0;
  src.connect(f).connect(g).connect(dest || c.destination);
  src.start(time);
  return src;
}

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

export function buildMidi({ events, slots, bpm }) {
  const T = 120;
  const list = [];
  for (const ev of events) {
    if (ev.midi === null) continue;
    list.push([ev.s16 * T, 0x90, ev.midi, 96]);
    list.push([(ev.s16 + ev.d16) * T - 1, 0x80, ev.midi, 0]);
  }
  for (const sl of slots) {
    if (!sl.chord) continue;
    const base = 48 + sl.chord.root;
    const notes = chordTones(sl.chord).map((pc) => { let m = 48 + pc; if (m < base) m += 12; return m; });
    notes.forEach((m) => {
      list.push([sl.start16 * T, 0x91, m, 64]);
      list.push([(sl.start16 + sl.len16) * T - 1, 0x81, m, 0]);
    });
  }
  list.sort((a, b) => a[0] - b[0] || (a[1] & 0xf0) - (b[1] & 0xf0));
  const tr = [];
  const mpq = Math.round(60000000 / bpm);
  tr.push(0, 0xff, 0x51, 3, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255);
  tr.push(0, 0xc0, 0, 0, 0xc1, 25);
  let last = 0;
  for (const [t, st, n, v] of list) { tr.push(...vlq(t - last), st, n, v); last = t; }
  tr.push(0, 0xff, 0x2f, 0);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (T * 4) >> 8, (T * 4) & 255];
  const len = tr.length;
  const trackHead = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255];
  return new Blob([new Uint8Array([...head, ...trackHead, ...tr])], { type: 'audio/midi' });
}
