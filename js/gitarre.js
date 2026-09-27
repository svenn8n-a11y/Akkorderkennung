import { mod12 } from './musik.js';

const OPEN = {
  '0:': [-1, 3, 2, 0, 1, 0],
  '2:': [-1, -1, 0, 2, 3, 2],
  '4:': [0, 2, 2, 1, 0, 0],
  '7:': [3, 2, 0, 0, 0, 3],
  '9:': [-1, 0, 2, 2, 2, 0],
  '9:m': [-1, 0, 2, 2, 1, 0],
  '2:m': [-1, -1, 0, 2, 3, 1],
  '4:m': [0, 2, 2, 0, 0, 0],
  '0:7': [-1, 3, 2, 3, 1, 0],
  '2:7': [-1, -1, 0, 2, 1, 2],
  '4:7': [0, 2, 0, 1, 0, 0],
  '7:7': [3, 2, 0, 0, 0, 1],
  '9:7': [-1, 0, 2, 0, 2, 0],
  '11:7': [-1, 2, 1, 2, 0, 2],
};

export function hasOpenShape(ch) { return !!OPEN[`${mod12(ch.root)}:${ch.qual}`]; }

export function shapeFor(ch) {
  const k = `${mod12(ch.root)}:${ch.qual}`;
  if (OPEN[k]) return { frets: OPEN[k], barre: 0 };
  const fE = mod12(ch.root - 4) || 12;
  const fA = mod12(ch.root - 9) || 12;
  const eShape = ch.qual === 'm' ? [0, 2, 2, 0, 0, 0] : ch.qual === '7' ? [0, 2, 0, 1, 0, 0] : [0, 2, 2, 1, 0, 0];
  const aShape = ch.qual === 'm' ? [-1, 0, 2, 2, 1, 0] : ch.qual === '7' ? [-1, 0, 2, 0, 2, 0] : [-1, 0, 2, 2, 2, 0];
  const useE = fE <= fA;
  const f = useE ? fE : fA;
  const shape = useE ? eShape : aShape;
  return { frets: shape.map((x) => (x < 0 ? -1 : x + f)), barre: f, barreFrom: useE ? 0 : 1 };
}

export function bestCapo(chords) {
  const uniq = [...new Map(chords.filter(Boolean).map((c) => [`${c.root}:${c.qual}`, c])).values()];
  if (!uniq.length) return 0;
  let best = 0, bestScore = -1;
  for (let capo = 0; capo <= 7; capo++) {
    const score = uniq.filter((c) => hasOpenShape({ root: c.root - capo, qual: c.qual })).length - capo * 0.01;
    if (score > bestScore + 1e-9) { bestScore = score; best = capo; }
  }
  return best;
}

export function diagramSvg(ch, label) {
  const { frets, barre, barreFrom } = shapeFor(ch);
  const played = frets.filter((f) => f > 0);
  const minF = played.length ? Math.min(...played) : 1;
  const maxF = played.length ? Math.max(...played) : 1;
  const base = maxF <= 4 ? 1 : minF;
  const W = 92, H = 118, x0 = 18, y0 = 36, sx = 12, sy = 16, rows = 4;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="griff" role="img" aria-label="Griffbild ${label}">`;
  s += `<text x="${W / 2 + 2}" y="14" class="griff-name" text-anchor="middle">${label}</text>`;
  if (base === 1) s += `<rect x="${x0 - 1}" y="${y0 - 3}" width="${sx * 5 + 2}" height="3" class="griff-sattel"/>`;
  else s += `<text x="${x0 - 5}" y="${y0 + sy * 0.7}" class="griff-bund" text-anchor="end">${base}</text>`;
  for (let i = 0; i < 6; i++) s += `<line x1="${x0 + i * sx}" y1="${y0}" x2="${x0 + i * sx}" y2="${y0 + rows * sy}" class="griff-linie"/>`;
  for (let r = 0; r <= rows; r++) s += `<line x1="${x0}" y1="${y0 + r * sy}" x2="${x0 + 5 * sx}" y2="${y0 + r * sy}" class="griff-linie"/>`;
  if (barre) {
    const r = barre - base;
    s += `<rect x="${x0 + barreFrom * sx - 4}" y="${y0 + r * sy + sy / 2 - 4}" width="${(5 - barreFrom) * sx + 8}" height="8" rx="4" class="griff-punkt"/>`;
  }
  frets.forEach((f, i) => {
    const x = x0 + i * sx;
    if (f < 0) s += `<text x="${x}" y="${y0 - 7}" class="griff-mark" text-anchor="middle">×</text>`;
    else if (f === 0) s += `<circle cx="${x}" cy="${y0 - 10}" r="3.2" class="griff-leer"/>`;
    else if (!(barre && f === barre)) s += `<circle cx="${x}" cy="${y0 + (f - base) * sy + sy / 2}" r="4.6" class="griff-punkt"/>`;
  });
  return s + '</svg>';
}
