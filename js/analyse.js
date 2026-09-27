import { mod12, chordTones, chordKey, parseChordKey, spellPc, keySignature, NATURAL, allKeys } from './musik.js';

const median = (arr) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function extractNotes(track) {
  const { hop, win } = track;
  const n = track.midi.length;
  if (!n) return { notes: [], offset: 0 };
  const lv = [...track.level].sort((a, b) => a - b);
  const p95 = lv[Math.floor(lv.length * 0.95)] || 0;
  const gate = Math.max(0.006, p95 * 0.12);
  const voiced = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = track.midi[i];
    voiced[i] = Number.isFinite(m) && track.conf[i] > 0.78 && track.level[i] > gate;
  }
  const raw = track.midi.map((m, i) => (voiced[i] ? m : NaN));
  const sm = raw.map((m, i) => {
    if (!Number.isFinite(m)) return NaN;
    const w = [];
    for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n && Number.isFinite(raw[k])) w.push(raw[k]);
    return median(w);
  });
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(sm[i])) continue;
    const w = [];
    for (let k = i - 7; k <= i + 7; k++) if (k >= 0 && k < n && Number.isFinite(sm[k])) w.push(sm[k]);
    const med = median(w);
    const d = sm[i] - med;
    if (Math.abs(d - 12) < 1) sm[i] -= 12;
    else if (Math.abs(d + 12) < 1) sm[i] += 12;
  }
  let sx = 0, sy = 0;
  for (const m of sm) if (Number.isFinite(m)) { const a = 2 * Math.PI * (m - Math.round(m)); sx += Math.cos(a); sy += Math.sin(a); }
  const offset = sx || sy ? Math.atan2(sy, sx) / (2 * Math.PI) : 0;
  const tuned = sm.map((m) => (Number.isFinite(m) ? m - offset : NaN));

  const r = tuned.map((m) => (Number.isFinite(m) ? Math.round(m) : null));
  const modeR = r.map((v, i) => {
    if (v === null) return null;
    const cnt = new Map();
    for (let k = i - 3; k <= i + 3; k++) if (k >= 0 && k < n && r[k] !== null) cnt.set(r[k], (cnt.get(r[k]) || 0) + 1);
    let best = v, bc = 0;
    for (const [p, c] of cnt) if (c > bc || (c === bc && p === v)) { best = p; bc = c; }
    return best;
  });

  let runs = [];
  let cur = null;
  const maxGap = 2;
  for (let i = 0; i < n; i++) {
    const p = modeR[i];
    if (p === null) continue;
    if (cur && p === cur.p && i - cur.last <= maxGap + 1) { cur.last = i; cur.vals.push(tuned[i]); cur.lv = Math.max(cur.lv, track.level[i]); }
    else { cur = { p, first: i, last: i, vals: [tuned[i]], lv: track.level[i] }; runs.push(cur); }
  }
  const minFrames = Math.max(2, Math.round(0.08 / hop));
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < runs.length; k++) {
      const a = runs[k];
      if (a.last - a.first + 1 >= minFrames) continue;
      const prev = runs[k - 1], next = runs[k + 1];
      const nearPrev = prev && a.first - prev.last <= maxGap + 1;
      const nearNext = next && next.first - a.last <= maxGap + 1;
      let target = null;
      if (nearPrev && nearNext) target = Math.abs(prev.p - a.p) <= Math.abs(next.p - a.p) ? prev : next;
      else if (nearPrev) target = prev;
      else if (nearNext) target = next;
      if (target) {
        target.first = Math.min(target.first, a.first);
        target.last = Math.max(target.last, a.last);
      }
      runs.splice(k, 1);
      changed = true;
      break;
    }
    for (let k = 0; k + 1 < runs.length; k++) {
      const a = runs[k], b = runs[k + 1];
      if (a.p === b.p && b.first - a.last <= maxGap + 1) {
        a.last = b.last; a.vals = a.vals.concat(b.vals);
        runs.splice(k + 1, 1);
        changed = true;
        break;
      }
    }
  }
  const lvl = track.level;
  const split = [];
  for (const ru of runs) {
    let peak = 0, from = ru.first;
    for (let i = ru.first; i <= ru.last; i++) {
      peak = Math.max(peak, lvl[i]);
      if (i - from < minFrames || ru.last - i < minFrames) continue;
      if (lvl[i] > lvl[i - 1] || lvl[i] > lvl[i + 1]) continue;
      let after = 0;
      for (let k = i + 1; k <= Math.min(ru.last, i + 8); k++) after = Math.max(after, lvl[k]);
      if (lvl[i] < 0.55 * peak && lvl[i] < 0.6 * after) {
        split.push({ ...ru, first: from, last: i - 1 });
        from = i + 1;
        peak = 0;
      }
    }
    split.push({ ...ru, first: from, last: ru.last });
  }
  runs = split;
  const t = (f) => f * hop + win / 2;
  const notes = runs.map((ru) => {
    const vals = [];
    for (let i = ru.first; i <= ru.last; i++) if (Number.isFinite(tuned[i])) vals.push(tuned[i]);
    const core = vals.slice(Math.floor(vals.length * 0.2), Math.ceil(vals.length * 0.8) || 1);
    const mp = median(core.length ? core : vals);
    return { start: t(ru.first) - hop / 2, end: t(ru.last) + hop / 2, midi: Math.round(mp), dev: mp - Math.round(mp) };
  });
  return { notes, offset };
}

export function estimateTempo(notes) {
  if (notes.length < 4) return { bpm: 90, t0: notes.length ? notes[0].start : 0 };
  const on = notes.map((n) => n.start);
  let best = { score: -1, bpm: 90, t0: on[0] };
  for (let bpm = 56; bpm <= 170; bpm += 0.5) {
    const unit = 60 / bpm / 2;
    let sx = 0, sy = 0;
    for (const o of on) { const a = (2 * Math.PI * o) / unit; sx += Math.cos(a); sy += Math.sin(a); }
    const R = Math.hypot(sx, sy) / on.length;
    const prior = Math.exp(-Math.pow(Math.log2(bpm / 96), 2) / (2 * 0.4 * 0.4));
    const score = R * (0.55 + 0.45 * prior);
    if (score > best.score) {
      let ph = Math.atan2(sy, sx) / (2 * Math.PI) * unit;
      best = { score, bpm, ph, unit };
    }
  }
  const unit = best.unit;
  let t0 = best.ph;
  const k = Math.round((on[0] - t0) / unit);
  t0 = t0 + k * unit;
  return { bpm: Math.round(best.bpm), t0, fit: best.score };
}

export function alignOrigin(notes, bpm, grid) {
  const unit = 60 / bpm / (grid === 16 ? 4 : 2);
  if (!notes.length) return 0;
  let sx = 0, sy = 0;
  for (const n of notes) { const a = (2 * Math.PI * n.start) / unit; sx += Math.cos(a); sy += Math.sin(a); }
  let t0 = (Math.atan2(sy, sx) / (2 * Math.PI)) * unit;
  t0 += Math.round((notes[0].start - t0) / unit) * unit;
  return t0;
}

export function quantize(notes, bpm, t0, grid, shiftBeats, meter, barOrigin = null) {
  const per16 = grid === 16 ? 1 : 2;
  const unit = 60 / bpm / (grid === 16 ? 4 : 2);
  const q = [];
  for (const n of notes) {
    let s = Math.round((n.start - t0) / unit);
    let e = Math.round((n.end - t0) / unit);
    if (e <= s) e = s + 1;
    if (q.length) {
      const p = q[q.length - 1];
      if (s <= p.s) { if (e - s > p.e - p.s) { p.midi = n.midi; } p.e = Math.max(p.e, e); continue; }
      if (p.e > s) p.e = s;
    }
    q.push({ s, e, midi: n.midi, t: n.start, te: n.end });
  }
  const base = barOrigin !== null ? Math.round((barOrigin - t0) / unit) : q.length ? q[0].s : 0;
  const kept = q.filter((x) => x.s >= base);
  const shift16 = shiftBeats * 4;
  const out = kept.map((x) => ({ s16: (x.s - base) * per16 + shift16, d16: (x.e - x.s) * per16, midi: x.midi, t: x.t, te: x.te }));
  const barLen = meter * 4;
  const last = out.length ? out[out.length - 1].s16 + out[out.length - 1].d16 : barLen;
  const total16 = Math.max(barLen, Math.ceil(last / barLen) * barLen);
  const originSec = t0 + base * unit - shift16 * (60 / bpm / 4);
  return { notes16: out, total16, barLen, originSec, sec16: 60 / bpm / 4 };
}

const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / 12, mb = b.reduce((x, y) => x + y, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
}

export function detectKey(notes16) {
  const h = new Array(12).fill(0);
  notes16.forEach((n, i) => { h[mod12(n.midi)] += n.d16 * (i === notes16.length - 1 ? 2 : 1); });
  if (notes16.length) h[mod12(notes16[0].midi)] += 1;
  let best = { tonic: 0, mode: 'dur' }, bs = -2;
  for (const k of allKeys()) {
    const prof = k.mode === 'dur' ? KK_MAJ : KK_MIN;
    const rot = prof.map((_, i) => prof[mod12(i - k.tonic)]);
    const c = corr(h, rot);
    if (c > bs) { bs = c; best = k; }
  }
  return best;
}

function candidates(key) {
  const t = key.tonic;
  if (key.mode === 'dur')
    return [
      { root: t, qual: '', prior: 0.15, deg: 'I' },
      { root: mod12(t + 5), qual: '', prior: 0.08, deg: 'IV' },
      { root: mod12(t + 7), qual: '', prior: 0.08, deg: 'V' },
      { root: mod12(t + 9), qual: 'm', prior: 0.05, deg: 'vi' },
      { root: mod12(t + 2), qual: 'm', prior: 0.03, deg: 'ii' },
      { root: mod12(t + 4), qual: 'm', prior: 0.0, deg: 'iii' },
    ];
  return [
    { root: t, qual: 'm', prior: 0.15, deg: 'i' },
    { root: mod12(t + 5), qual: 'm', prior: 0.07, deg: 'iv' },
    { root: mod12(t + 7), qual: '', prior: 0.08, deg: 'V' },
    { root: mod12(t + 7), qual: 'm', prior: 0.02, deg: 'v' },
    { root: mod12(t + 3), qual: '', prior: 0.05, deg: 'III' },
    { root: mod12(t + 8), qual: '', prior: 0.05, deg: 'VI' },
    { root: mod12(t + 10), qual: '', prior: 0.05, deg: 'VII' },
  ];
}

function metricWeight(pos16, slotLen) {
  if (pos16 % slotLen === 0) return 1.6;
  if (pos16 % 4 === 0) return 1.2;
  return 1.0;
}

export function suggestChords(q, key, perBar, overrides = {}) {
  const slotLen = q.barLen / perBar;
  const nSlots = Math.round(q.total16 / slotLen);
  const cands = candidates(key);
  const emis = [];
  for (let s = 0; s < nSlots; s++) {
    const a = s * slotLen, b = a + slotLen;
    const w = new Array(12).fill(0);
    let tot = 0;
    for (const n of q.notes16) {
      const ns = n.s16, ne = n.s16 + n.d16;
      const ov = Math.min(b, ne) - Math.max(a, ns);
      if (ov <= 0) continue;
      const wt = ov * metricWeight(Math.max(a, ns) - a, slotLen);
      w[mod12(n.midi)] += wt;
      tot += wt;
    }
    emis.push(cands.map((c) => {
      if (!tot) return 0;
      const tones = chordTones(c);
      let sc = 0;
      for (let pc = 0; pc < 12; pc++) {
        if (!w[pc]) continue;
        const idx = tones.indexOf(pc);
        sc += w[pc] * (idx === 0 ? 1.0 : idx === 1 ? 1.0 : idx === 2 ? 0.9 : -1.0);
      }
      return sc / tot;
    }));
  }
  const trans = (a, b) => {
    if (a === b) return 0.05;
    const ca = cands[a], cb = cands[b];
    if (ca.deg.toUpperCase() === 'V' && (cb.deg === 'I' || cb.deg === 'i')) return 0.15;
    if (ca.deg.toUpperCase() === 'IV' && cb.deg === 'V') return 0.05;
    if (ca.deg.toUpperCase() === 'IV' && (cb.deg === 'I' || cb.deg === 'i')) return 0.05;
    return 0;
  };
  const N = cands.length;
  const score = [], back = [];
  for (let s = 0; s < nSlots; s++) {
    score.push(new Array(N).fill(-1e9));
    back.push(new Array(N).fill(0));
    for (let j = 0; j < N; j++) {
      let base = emis[s][j] + cands[j].prior;
      if (s === 0 && j === 0) base += 0.1;
      if (s === nSlots - 1 && j === 0) base += 0.15;
      if (s === 0) { score[s][j] = base; continue; }
      for (let i = 0; i < N; i++) {
        const v = score[s - 1][i] + trans(i, j) + base;
        if (v > score[s][j]) { score[s][j] = v; back[s][j] = i; }
      }
    }
  }
  const path = new Array(nSlots).fill(0);
  if (nSlots) {
    let bj = 0;
    for (let j = 1; j < N; j++) if (score[nSlots - 1][j] > score[nSlots - 1][bj]) bj = j;
    path[nSlots - 1] = bj;
    for (let s = nSlots - 1; s > 0; s--) path[s - 1] = back[s][path[s]];
  }
  return path.map((j, s) => {
    const ranked = cands
      .map((c, i) => ({ c, v: emis[s][i] + c.prior }))
      .sort((x, y) => y.v - x.v)
      .map((x) => ({ root: x.c.root, qual: x.c.qual }));
    const auto = { root: cands[j].root, qual: cands[j].qual };
    const alts = [auto, ...ranked.filter((c) => chordKey(c) !== chordKey(auto))];
    const ov = overrides[s];
    const chord = ov !== undefined ? parseChordKey(ov) : auto;
    return { index: s, start16: s * slotLen, len16: slotLen, chord, auto, alts, manual: ov !== undefined };
  });
}

const VOWELS = 'aeiouäöüyıâîûAEIOUÄÖÜYIÂÎÛİ';
const GROUPS = ['sch', 'ch', 'ck', 'ph', 'qu', 'th'];
function isVowel(c) { return VOWELS.includes(c); }

export function syllabify(word) {
  const lower = word.toLowerCase();
  const units = [];
  for (let i = 0; i < word.length;) {
    const g = GROUPS.find((x) => lower.startsWith(x, i));
    if (g) { units.push(word.slice(i, i + g.length)); i += g.length; continue; }
    units.push(word[i]); i++;
  }
  const isV = units.map((u) => u.length === 1 && isVowel(u));
  const nuclei = [];
  for (let i = 0; i < units.length; i++) {
    if (!isV[i]) continue;
    if (nuclei.length && nuclei[nuclei.length - 1].end === i - 1) {
      const pair = (units[i - 1] + units[i]).toLowerCase();
      if (['ei', 'ai', 'au', 'eu', 'äu', 'ie', 'ee', 'aa', 'oo', 'ey', 'ay'].includes(pair) && nuclei[nuclei.length - 1].end - nuclei[nuclei.length - 1].start === 0) {
        nuclei[nuclei.length - 1].end = i;
        continue;
      }
    }
    nuclei.push({ start: i, end: i });
  }
  if (nuclei.length <= 1) return [word];
  const cuts = [];
  for (let k = 0; k + 1 < nuclei.length; k++) {
    const gapStart = nuclei[k].end + 1, gapEnd = nuclei[k + 1].start;
    const cons = gapEnd - gapStart;
    cuts.push(cons <= 1 ? gapStart : gapEnd - 1);
  }
  const out = [];
  let prev = 0;
  for (const c of cuts) { out.push(units.slice(prev, c).join('')); prev = c; }
  out.push(units.slice(prev).join(''));
  return out.filter((s) => s.length);
}

export function parseLyrics(text, autoSplit) {
  const lines = [];
  (text || '').split(/\r?\n/).forEach((ln) => {
    const words = ln.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const toks = [];
    for (const w of words) {
      const parts = w.split('-').filter(Boolean);
      const syl = [];
      for (const p of parts) (autoSplit ? syllabify(p) : [p]).forEach((s) => syl.push(s));
      syl.forEach((s, i) => toks.push({ text: s, wordStart: i === 0, wordEnd: i === syl.length - 1 }));
    }
    lines.push(toks);
  });
  return lines;
}

export function lyricWords(lines) {
  const words = [];
  lines.forEach((l, li) => l.forEach((t) => {
    if (t.wordStart || !words.length) words.push({ syl: [], line: li });
    words[words.length - 1].syl.push(t.text);
  }));
  return words;
}

export function assignTimedLyrics(notes16, lines, timed) {
  const words = lyricWords(lines);
  notes16.forEach((n) => { n.syl = null; });
  let last = -1, placed = 0;
  words.forEach((w, wi) => {
    const ts = timed[wi].start, te = Math.max(timed[wi].end, ts + 0.05);
    let cands = [];
    for (let j = last + 1; j < notes16.length; j++) {
      const t = notes16[j].t;
      if (t >= te - 0.03) break;
      if (t >= ts - 0.12) cands.push(j);
    }
    if (!cands.length) {
      const j = notes16.findIndex((n, k) => k > last && n.t >= ts - 0.3);
      if (j >= 0 && notes16[j].t < te + 0.5) cands = [j];
    }
    if (!cands.length) {
      if (last >= 0 && notes16[last].syl) {
        const prev = notes16[last].syl;
        notes16[last].syl = { ...prev, text: prev.text + (prev.wordEnd ? ' ' : '') + w.syl.join(''), wordEnd: true };
        placed++;
      }
      return;
    }
    const k = cands.length;
    const groups = w.syl.length <= k ? w.syl.map((x) => [x]) : [...w.syl.slice(0, k - 1).map((x) => [x]), w.syl.slice(k - 1)];
    groups.forEach((g, gi) => {
      notes16[cands[gi]].syl = { text: g.join(''), wordStart: gi === 0, wordEnd: gi === groups.length - 1, line: w.line };
    });
    placed++;
    last = cands[k - 1];
  });
  return { used: notes16.filter((n) => n.syl).length, total: words.length, notes: notes16.length, timed: true, placed };
}

export function assignLyrics(notes16, lines) {
  const flat = [];
  lines.forEach((l, li) => l.forEach((t) => flat.push({ ...t, line: li })));
  notes16.forEach((n, i) => { n.syl = flat[i] || null; });
  return { used: Math.min(flat.length, notes16.length), total: flat.length, notes: notes16.length };
}

export function buildEvents(q) {
  const ev = [];
  let pos = 0;
  for (const n of q.notes16) {
    if (n.s16 > pos) ev.push({ s16: pos, d16: n.s16 - pos, midi: null });
    ev.push({ s16: n.s16, d16: n.d16, midi: n.midi, syl: n.syl, onsetIdx: ev.length });
    pos = n.s16 + n.d16;
  }
  if (pos < q.total16) ev.push({ s16: pos, d16: q.total16 - pos, midi: null });
  return ev;
}

const LENGTHS = [16, 12, 8, 6, 4, 3, 2, 1];

function abcPitch(midi, key, state) {
  const s = spellPc(mod12(midi), key);
  const oct = Math.floor((midi - NATURAL[s.letter] - s.alter) / 12) - 1;
  const id = s.letter + oct;
  const sig = keySignature(key);
  const current = id in state ? state[id] : sig[s.letter];
  let acc = '';
  if (current !== s.alter) {
    acc = s.alter === 0 ? '=' : s.alter > 0 ? '^'.repeat(s.alter) : '_'.repeat(-s.alter);
    state[id] = s.alter;
  }
  let name;
  if (oct >= 5) name = s.letter.toLowerCase() + "'".repeat(oct - 5);
  else name = s.letter + ','.repeat(Math.max(0, 4 - oct));
  return acc + name;
}

function abcKey(key) {
  const s = spellPc(key.tonic, key);
  const acc = s.alter > 0 ? '#' : s.alter < 0 ? 'b' : '';
  return s.letter + acc + (key.mode === 'moll' ? 'm' : '');
}

const cleanSyl = (t) => t.replace(/[-_*|~\\"%]/g, '').trim() || '~';

export function buildAbc({ events, q, slots, key, meter, bpm, barsPerLine, octaveUp, chordLabel, title }) {
  const barLen = q.barLen;
  const cuts = new Set();
  for (let b = 0; b <= q.total16; b += barLen) cuts.add(b);
  slots.forEach((s) => cuts.add(s.start16));
  const chordAt = new Map();
  let prevKey = null;
  slots.forEach((s) => {
    const k = chordKey(s.chord);
    if (k !== prevKey || s.start16 % (barLen * barsPerLine) === 0) chordAt.set(s.start16, chordLabel(s.chord));
    prevKey = k;
  });
  const shift = octaveUp ? 12 : 0;
  const lines = [];
  let music = '', words = '';
  let state = {};
  let barCount = 0;
  const flush = () => {
    lines.push(music.trim());
    if (words.replace(/[\s*]/g, '').length) lines.push('w: ' + words.trim());
    music = ''; words = '';
  };
  for (const ev of events) {
    let pos = ev.s16, left = ev.d16, first = true;
    while (left > 0) {
      let nextCut = pos + 1;
      while (!cuts.has(nextCut) && nextCut < pos + left) nextCut++;
      const len = LENGTHS.find((l) => l <= Math.min(left, nextCut - pos));
      if (pos % barLen === 0 && pos > 0) {
        music += '| ';
        barCount++;
        state = {};
        if (barCount % barsPerLine === 0) { music += '\n'; flush(); }
      }
      if (chordAt.has(pos)) { music += `"${chordAt.get(pos)}"`; chordAt.delete(pos); }
      if (ev.midi === null) music += `z${len === 1 ? '' : len} `;
      else {
        const tie = left - len > 0 ? '-' : '';
        music += `${abcPitch(ev.midi + shift, key, state)}${len === 1 ? '' : len}${tie} `;
        if (first && ev.syl) words += cleanSyl(ev.syl.text) + (ev.syl.wordEnd ? ' ' : '-');
        else words += '* ';
      }
      pos += len; left -= len; first = false;
    }
  }
  music += '|]';
  flush();
  const header = [
    'X:1',
    title ? `T:${title.replace(/\n/g, ' ')}` : '',
    `M:${meter}/4`,
    'L:1/16',
    '%%vocalfont Helvetica 13',
    '%%gchordfont Helvetica 14 bold',
    `Q:1/4=${bpm}`,
    `K:${abcKey(key)}${octaveUp ? ' clef=treble-8' : ''}`,
  ].filter(Boolean);
  return header.concat(lines.filter(Boolean)).join('\n');
}

export function analyse(track, settings, timedWords = null) {
  const { notes: raw, offset } = extractNotes(track);
  const tr = settings.transpose || 0;
  const notes = raw.map((n) => ({ ...n, midi: n.midi + tr }));
  const tempo = estimateTempo(notes);
  const bpm = settings.bpm || tempo.bpm;
  const grid = settings.grid || 8;
  const meter = settings.meter || 4;
  const t0 = settings.bpm ? alignOrigin(notes, bpm, grid) : tempo.t0;
  const barOrigin = Number.isFinite(settings.barOrigin) ? settings.barOrigin : null;
  const q = quantize(notes, bpm, t0, grid, settings.shiftBeats || 0, meter, barOrigin);
  const keyAuto = detectKey(q.notes16);
  const key = settings.key ? { tonic: mod12(settings.key.tonic + tr), mode: settings.key.mode } : keyAuto;
  const overrides = {};
  for (const [slot, k] of Object.entries(settings.overrides || {})) {
    const ch = parseChordKey(k);
    overrides[slot] = ch ? chordKey({ root: mod12(ch.root + tr), qual: ch.qual }) : '-';
  }
  const perBar = meter === 3 ? 1 : settings.perBar || 2;
  const slots = suggestChords(q, key, perBar, overrides);
  const lyricLines = parseLyrics(settings.lyrics || '', settings.autoSplit !== false);
  const nWords = lyricWords(lyricLines).length;
  const lyr = timedWords && timedWords.length && nWords === timedWords.length
    ? assignTimedLyrics(q.notes16, lyricLines, timedWords)
    : { ...assignLyrics(q.notes16, lyricLines), mismatch: !!(timedWords && timedWords.length && nWords) };
  const events = buildEvents(q);
  const pitches = q.notes16.map((n) => n.midi);
  const medianPitch = pitches.length ? median(pitches) : 67;
  return { transpose: tr, notes, offset, bpmAuto: tempo.bpm, bpm, grid, meter, q, key, keyAuto, perBar, slots, lyricLines, lyr, events, octaveUp: medianPitch < 62 };
}
