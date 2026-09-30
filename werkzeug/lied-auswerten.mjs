import { pipeline, env, Tensor } from '@huggingface/transformers';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { trackPitch, normalize } from '../js/pitch.js';
import { analyse, buildAbc } from '../js/analyse.js';
import { keyName, chordName, chordKey, chordTones, mod12 } from '../js/musik.js';
import { bestCapo } from '../js/gitarre.js';
import { cleanWords, wordsToText } from '../js/transkript.js';

const HIER = dirname(fileURLToPath(import.meta.url));
const VAULT = '/Users/sven/Documents/05 OBSEDIAN/second_brain/01 PRIVAT/Projekte/Akkorderkennung';
env.cacheDir = join(HIER, '.modelle');

const MODELLE = {
  turbo: 'onnx-community/whisper-large-v3-turbo_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
};
const SPRACHEN = { de: 'german', tr: 'turkish', en: 'english' };
const SPRACHNAME = { de: 'Deutsch', tr: 'Türkisch', en: 'Englisch' };

function args() {
  const a = process.argv.slice(2);
  const o = { datei: null, sprache: 'auto', modell: 'turbo', trennen: true, name: null, ziel: VAULT };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--sprache') o.sprache = a[++i];
    else if (a[i] === '--modell') o.modell = a[++i];
    else if (a[i] === '--ohne-trennung') o.trennen = false;
    else if (a[i] === '--name') o.name = a[++i];
    else if (a[i] === '--ziel') o.ziel = a[++i];
    else o.datei = a[i];
  }
  if (!o.datei) { console.error('Aufruf: node lied-auswerten.mjs <audiodatei> [--sprache auto|de|tr|en] [--modell turbo|small|base] [--ohne-trennung] [--name "Titel"]'); process.exit(1); }
  o.datei = resolve(o.datei);
  o.name = o.name || basename(o.datei, extname(o.datei)).replace(/^[0-9a-f]{8}-/, '').replace(/_/g, ' ');
  return o;
}

const log = (...m) => console.log(new Date().toLocaleTimeString('de-DE'), ...m);

function lade16k(datei) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', datei, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.length >> 1);
  for (let i = 0; i < x.length; i++) x[i] = raw.readInt16LE(i * 2) / 32768;
  return x;
}

function trenne(datei, tmp) {
  const py = join(HIER, '.venv', 'bin', 'python');
  if (!existsSync(py)) return null;
  const stem = basename(datei, extname(datei));
  const aus = join(tmp, 'htdemucs', stem);
  if (!existsSync(join(aus, 'vocals.wav'))) {
    execFileSync(py, ['-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs', '-o', tmp, datei], { stdio: 'inherit' });
  }
  return { gesang: join(aus, 'vocals.wav'), begleitung: join(aus, 'no_vocals.wav') };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function chromagramm(x, sr = 16000, N = 4096, hop = 2048) {
  const frames = [];
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const map = [];
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    if (f < 70 || f > 2000) continue;
    map.push([k, mod12(Math.round(69 + 12 * Math.log2(f / 440)))]);
  }
  for (let s = 0; s + N <= x.length; s += hop) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * win[i];
    fft(re, im);
    const c = new Array(12).fill(0);
    let e = 0;
    for (const [k, pc] of map) { const m = Math.hypot(re[k], im[k]); c[pc] += m; e += m; }
    frames.push({ t: (s + N / 2) / sr, c, e });
  }
  return frames;
}

const VORLAGEN = [];
for (let root = 0; root < 12; root++) {
  for (const qual of ['', 'm', '7']) {
    const v = new Array(12).fill(0);
    chordTones({ root, qual }).forEach((pc, i) => { const w = i === 3 ? 0.7 : 1; v[pc] += w; v[mod12(pc + 7)] += 0.3 * w; v[mod12(pc + 4)] += 0.1 * w; });
    const m = v.reduce((a, b) => a + b, 0) / 12;
    const c = v.map((y) => y - m);
    const n = Math.hypot(...c);
    VORLAGEN.push({ root, qual, v: c.map((y) => y / n) });
  }
}

function akkordAusChroma(c, tonartTöne) {
  const m = c.reduce((a, b) => a + b, 0) / 12;
  const z = c.map((y) => y - m);
  const n = Math.hypot(...z) || 1;
  let best = null, bs = -1;
  for (const t of VORLAGEN) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += (z[i] / n) * t.v[i];
    if (t.qual === '7') s -= 0.05;
    if (!tonartTöne.includes(t.root)) s -= 0.04;
    if (s > bs) { bs = s; best = t; }
  }
  return { chord: { root: best.root, qual: best.qual }, score: bs };
}

async function transkribiere(x, modell, sprache) {
  const asr = await pipeline('automatic-speech-recognition', modell, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } });
  let code = sprache;
  if (sprache === 'auto') {
    const { input_features } = await asr.processor(x.subarray(0, 30 * 16000));
    const gc = asr.model.generation_config;
    const out = await asr.model({ input_features, decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]) });
    const V = out.logits.dims.at(-1), base = out.logits.data.length - V;
    let bv = -Infinity;
    for (const c of Object.keys(SPRACHEN)) { const v = out.logits.data[base + gc.lang_to_id[`<|${c}|>`]]; if (v > bv) { bv = v; code = c; } }
  }
  log(`Sprache: ${SPRACHNAME[code]}`);
  const SR = 16000, WIN = 30 * SR, STEP = 26 * SR, words = [];
  for (let off = 0; off < x.length; off += STEP) {
    const last = off + WIN >= x.length;
    const out = await asr(x.subarray(off, Math.min(x.length, off + WIN)), { language: SPRACHEN[code], task: 'transcribe', return_timestamps: 'word' });
    const t0 = off / SR, from = off ? t0 + 2 : 0, to = last ? Infinity : t0 + 28;
    for (const c of out.chunks || []) {
      const end = t0 + (c.timestamp[1] ?? c.timestamp[0]);
      let start = t0 + c.timestamp[0];
      if (c.timestamp[0] < 0.2 && end - start > 1) start = end - 0.8;
      const text = c.text.trim();
      if (text && start >= from && start < to) words.push({ text, start, end });
    }
    log(`Text: ${Math.min(100, Math.round(((off + WIN) / x.length) * 100))} %`);
    if (last) break;
  }
  return { words, code };
}

function anker(an) {
  const notes = an.q.notes16, map = new Map(), pre = new Map(), tail = [];
  const add = (m, i, sl) => { if (!m.has(i)) m.set(i, []); m.get(i).push(sl); };
  let prev = null;
  for (const sl of an.slots) {
    const k = chordKey(sl.chord);
    if (k === prev) continue;
    prev = k;
    const end = sl.start16 + sl.len16;
    const idx = notes.findIndex((n) => n.syl && n.s16 >= sl.start16 && n.s16 < end);
    if (idx >= 0) { add(map, idx, sl); continue; }
    let j = -1;
    for (let q = notes.length - 1; q >= 0; q--) if (notes[q].syl && notes[q].s16 <= sl.start16) { j = q; break; }
    const nextSyl = notes.findIndex((n) => n.syl && n.s16 >= end);
    const sung = j >= 0 && notes.some((n, q) => q >= j && (nextSyl < 0 || q < nextSyl) && n.s16 <= sl.start16 && n.s16 + n.d16 > sl.start16);
    if (sung) add(map, j, sl); else if (nextSyl >= 0) add(pre, nextSyl, sl); else tail.push(sl);
  }
  return { map, pre, tail };
}

function akkordblatt(an, label) {
  const out = [];
  const { map, pre, tail } = anker(an);
  let cl = '', tl = '', line = -1, first = true;
  const flush = () => { if (cl.trim() || tl.trim()) out.push(cl.replace(/\s+$/, ''), tl.replace(/\s+$/, '')); cl = ''; tl = ''; };
  an.q.notes16.forEach((n, i) => {
    if (!n.syl) return;
    if (pre.has(i)) { flush(); out.push('', `[${first ? 'Vorspiel' : 'Zwischenspiel'}]  ${pre.get(i).map((s) => label(s.chord)).join('  ')}`, ''); line = -1; }
    first = false;
    if (n.syl.line !== line) { flush(); line = n.syl.line; }
    const ch = (map.get(i) || []).map((s) => label(s.chord)).join(' ');
    if (ch) {
      if (cl.length > tl.length) tl = tl.padEnd(cl.length, ' ');
      cl = cl.padEnd(tl.length, ' ') + ch + ' ';
    }
    tl += n.syl.text + (n.syl.wordEnd ? ' ' : '');
  });
  flush();
  if (tail.length) out.push('', `[Nachspiel]  ${tail.map((s) => label(s.chord)).join('  ')}`);
  return out.join('\n');
}

async function main() {
  const o = args();
  const tmp = join(HIER, '.tmp', o.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'lied');
  mkdirSync(tmp, { recursive: true });
  log(`Lied: ${o.name}`);

  let gesangDatei = o.datei, begleitDatei = null;
  if (o.trennen) {
    log('Trenne Gesang und Begleitung (Demucs) …');
    const t = trenne(o.datei, tmp);
    if (t) { gesangDatei = t.gesang; begleitDatei = t.begleitung; } else log('Demucs nicht installiert, werte die Mischung aus.');
  }

  const gesang = normalize(lade16k(gesangDatei));
  const dauer = gesang.length / 16000;
  log(`Dauer ${Math.floor(dauer / 60)}:${String(Math.round(dauer % 60)).padStart(2, '0')}, Tonhöhe wird verfolgt …`);
  const track = await trackPitch(gesang);

  log('Texterkennung …');
  const { words, code } = await transkribiere(gesang, MODELLE[o.modell] || o.modell, o.sprache);
  const clean = cleanWords(words, track);
  const text = wordsToText(clean);

  const settings = { lyrics: text, autoSplit: true, perBar: 2, overrides: {} };
  let an = analyse(track, settings, clean);
  let akkordQuelle = 'aus der Melodie abgeleitet';
  if (begleitDatei) {
    log('Akkorde aus der Begleitung …');
    const beg = lade16k(begleitDatei);
    const frames = chromagramm(beg);
    const skala = (an.key.mode === 'moll' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((d) => mod12(an.key.tonic + d));
    const eMax = Math.max(...frames.map((f) => f.e)) || 1;
    let prev = null;
    for (const sl of an.slots) {
      const a = an.q.originSec + sl.start16 * an.q.sec16, b = a + sl.len16 * an.q.sec16;
      const c = new Array(12).fill(0);
      let e = 0;
      for (const f of frames) if (f.t >= a && f.t < b) { f.c.forEach((v, i) => (c[i] += v)); e += f.e; }
      if (e < eMax * 0.05) { if (prev) settings.overrides[sl.index] = chordKey(prev); continue; }
      const r = akkordAusChroma(c, skala);
      if (r.score > 0.45) { settings.overrides[sl.index] = chordKey(r.chord); prev = r.chord; }
    }
    an = analyse(track, settings, clean);
    akkordQuelle = 'aus der Begleitung herausgehört';
  }

  const capo = bestCapo(an.slots.map((s) => s.chord));
  const label = (c) => chordName(c, an.key);
  const blatt = akkordblatt(an, label);
  const abc = buildAbc({ events: an.events, q: an.q, slots: an.slots, key: an.key, meter: an.meter, bpm: an.bpm, barsPerLine: 4, octaveUp: an.octaveUp, chordLabel: label, title: o.name });
  const akkorde = [...new Map(an.slots.filter((s) => s.chord).map((s) => [chordKey(s.chord), s.chord])).values()].map(label);
  const heute = new Date().toISOString().slice(0, 10);
  const datei = `Lied ${o.name}`;
  const md = `---
tags: [privat, musik, lied, akkorderkennung]
erstellt: ${heute}
status: entwurf
---

# ${o.name}

Automatisch ausgewertet am ${heute} mit dem Akkorderkennung-Werkzeug. Übergeordnet: [[00 Projekt-Hub Akkorderkennung]]

| | |
|---|---|
| Tonart | ${keyName(an.key)} |
| Tempo | ${an.bpm} BPM, ${an.meter}/4 |
| Sprache | ${SPRACHNAME[code]} |
| Akkorde | ${akkorde.join(', ')} (${akkordQuelle}) |
| Kapo-Tipp | ${capo ? `${capo}. Bund, dann Griffe wie in ${keyName({ tonic: mod12(an.key.tonic - capo), mode: an.key.mode })}` : 'ohne Kapodaster'} |
| Quelle | \`${o.datei}\` |

## Akkordblatt

\`\`\`
${blatt}
\`\`\`

## Liedtext (erkannt, bitte korrigieren)

${text.split('\n').map((l) => l + '  ').join('\n')}

## Noten

Notenbild: [[${datei} Noten.html]] (im Browser öffnen). ABC-Quelltext zum Weiterbearbeiten:

\`\`\`abc
${abc}
\`\`\`

## Stand der Erkennung

- Gesang ${begleitDatei ? 'vor der Auswertung von der Begleitung getrennt (Demucs)' : 'aus der Mischung ausgewertet'}
- ${an.notes.length} Töne erkannt, ${clean.length} Wörter (${words.length - clean.length} verworfen)
- Texterkennung: Whisper ${o.modell}. Verhörer sind bei Gesang normal, der Text ist ein Entwurf.
`;
  const abcjs = readFileSync(join(HIER, '..', 'vendor', 'abcjs-basic-min.js'), 'utf8');
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${o.name} Noten</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;max-width:900px;margin-inline:auto;color:#15202b;background:#fffefb}h1{margin:0 0 4px}p{color:#5a6776;margin:0 0 16px}pre{background:#f3f5f7;padding:14px;border-radius:8px;overflow-x:auto;font:15px/1.35 ui-monospace,Menlo,monospace}.abcjs-chord{fill:#b3361f;font-weight:700}@media print{pre{background:none}}</style></head>
<body><h1>${o.name}</h1><p>${keyName(an.key)} · ${an.bpm} BPM · ${an.meter}/4 · Akkorde ${akkordQuelle}${capo ? ` · Kapo-Tipp ${capo}. Bund` : ''}</p>
<h2>Akkordblatt</h2><pre>${blatt.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>
<h2>Noten</h2><div id="noten"></div>
<script>${abcjs}</script><script>ABCJS.renderAbc('noten', ${JSON.stringify(abc)}, { responsive: 'resize', add_classes: true });</script></body></html>`;
  mkdirSync(o.ziel, { recursive: true });
  writeFileSync(join(o.ziel, `${datei}.md`), md);
  writeFileSync(join(o.ziel, `${datei} Noten.html`), html);
  log(`Fertig: ${join(o.ziel, datei)}.md und Noten.html`);
  log(`${keyName(an.key)}, ${an.bpm} BPM, Akkorde ${akkorde.join(' ')}, ${clean.length} Wörter`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('Fehler:', e); process.exit(1); });
