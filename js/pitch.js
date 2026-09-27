import { freqToMidi } from './musik.js';

export const MIN_F = 65;
export const MAX_F = 1100;

export function yin(buf, sr, start = 0, size = buf.length, threshold = 0.15) {
  const tauMin = Math.floor(sr / MAX_F);
  const tauMax = Math.min(Math.ceil(sr / MIN_F), Math.floor(size / 2));
  const w = size - tauMax;
  if (w < tauMax) return null;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = start, j = start + tau, e = start + w; i < e; i++, j++) {
      const x = buf[i] - buf[j];
      s += x * x;
    }
    d[tau] = s;
  }
  let running = 0;
  const cm = new Float32Array(tauMax + 1);
  cm[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cm[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cm[t] < threshold) {
      while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = tauMin;
    for (let t = tauMin; t <= tauMax; t++) if (cm[t] < cm[best]) best = t;
    tau = best;
  }
  let better = tau;
  if (tau > 1 && tau < tauMax) {
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
    const den = a + c - 2 * b;
    if (den !== 0) better = tau + (a - c) / (2 * den);
  }
  return { freq: sr / better, conf: 1 - cm[tau] };
}

export function rms(buf, start = 0, size = buf.length) {
  let s = 0;
  for (let i = start, e = start + size; i < e; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / size);
}

export const ANALYSE_SR = 16000;
export const HOP = 192;
export const WIN = 768;

export async function toMono16k(audioBuffer) {
  const len = Math.ceil((audioBuffer.duration) * ANALYSE_SR);
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Off) {
    try {
      const off = new Off(1, len, ANALYSE_SR);
      const src = off.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(off.destination);
      src.start();
      const out = await off.startRendering();
      return out.getChannelData(0);
    } catch (e) { /* fällt auf manuelles Umrechnen zurück */ }
  }
  const input = audioBuffer.getChannelData(0);
  const ratio = audioBuffer.sampleRate / ANALYSE_SR;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let k = a; k < b; k++) s += input[k];
    out[i] = b > a ? s / (b - a) : 0;
  }
  return out;
}

export async function trackPitch(samples, onProgress) {
  const n = Math.max(0, Math.floor((samples.length - WIN) / HOP) + 1);
  const midi = new Float32Array(n);
  const conf = new Float32Array(n);
  const level = new Float32Array(n);
  const chunk = 200;
  for (let f = 0; f < n; f++) {
    const start = f * HOP;
    level[f] = rms(samples, start, WIN);
    if (level[f] < 0.002) { midi[f] = NaN; conf[f] = 0; }
    else {
      const r = yin(samples, ANALYSE_SR, start, WIN);
      if (r && r.freq >= MIN_F && r.freq <= MAX_F) { midi[f] = freqToMidi(r.freq); conf[f] = r.conf; }
      else { midi[f] = NaN; conf[f] = 0; }
    }
    if (f % chunk === chunk - 1) {
      onProgress && onProgress(f / n);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress && onProgress(1);
  return { hop: HOP / ANALYSE_SR, win: WIN / ANALYSE_SR, midi: Array.from(midi), conf: Array.from(conf), level: Array.from(level) };
}
