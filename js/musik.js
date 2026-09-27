export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
export const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const MAJOR_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };

export const mod12 = (n) => ((n % 12) + 12) % 12;

let germanNames = false;
export function setGermanNames(on) { germanNames = !!on; }
export function isGermanNames() { return germanNames; }

export function keyFifths(key) {
  const majorPc = key.mode === 'moll' ? mod12(key.tonic + 3) : key.tonic;
  return MAJOR_FIFTHS[majorPc];
}

export function keySignature(key) {
  const f = keyFifths(key);
  const sig = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  if (f > 0) SHARP_ORDER.slice(0, f).forEach((l) => (sig[l] = 1));
  if (f < 0) FLAT_ORDER.slice(0, -f).forEach((l) => (sig[l] = -1));
  return sig;
}

export function spellPc(pc, key) {
  pc = mod12(pc);
  const sig = keySignature(key);
  for (const l of LETTERS) if (mod12(NATURAL[l] + sig[l]) === pc) return { letter: l, alter: sig[l] };
  const f = keyFifths(key);
  const tries = f >= 0 ? [1, -1] : [-1, 1];
  for (const d of tries)
    for (const l of LETTERS) if (mod12(NATURAL[l] + sig[l] + d) === pc) return { letter: l, alter: sig[l] + d };
  for (const l of LETTERS) if (NATURAL[l] === pc) return { letter: l, alter: 0 };
  return { letter: 'C', alter: 0 };
}

export function letterName(letter, alter) {
  if (germanNames) {
    if (letter === 'B' && alter === -1) return 'B';
    if (letter === 'B' && alter === 0) return 'H';
    if (letter === 'B' && alter === 1) return 'His';
  }
  const acc = alter > 0 ? '#'.repeat(alter) : alter < 0 ? 'b'.repeat(-alter) : '';
  return letter + acc;
}

export function pcName(pc, key) {
  const s = spellPc(pc, key || { tonic: 0, mode: 'dur' });
  return letterName(s.letter, s.alter);
}

export function midiName(midi, key) {
  const s = spellPc(mod12(midi), key || { tonic: 0, mode: 'dur' });
  const oct = Math.floor((midi - NATURAL[s.letter] - s.alter) / 12) - 1;
  return letterName(s.letter, s.alter) + oct;
}

function germanKeyLetter(letter, alter) {
  if (letter === 'B') return alter === -1 ? 'B' : alter === 0 ? 'H' : 'His';
  const base = letter;
  if (alter > 0) return base + 'is'.repeat(alter);
  if (alter < 0) return (letter === 'E' || letter === 'A' ? base + 's' : base + 'es') + 'es'.repeat(-alter - 1);
  return base;
}

export function keyName(key) {
  const sp = spellPc(key.tonic, key);
  const n = germanNames ? germanKeyLetter(sp.letter, sp.alter) : letterName(sp.letter, sp.alter);
  return key.mode === 'moll' ? `${n}-Moll` : `${n}-Dur`;
}

export function chordName(ch, key) {
  if (!ch) return '–';
  return pcName(ch.root, key) + (ch.qual === 'm' ? 'm' : ch.qual === '7' ? '7' : '');
}

const GUITAR = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
export function guitarChordName(ch) {
  if (!ch) return '–';
  let n = GUITAR[mod12(ch.root)];
  if (germanNames) n = n === 'B' ? 'H' : n === 'Bb' ? 'B' : n;
  return n + (ch.qual === 'm' ? 'm' : ch.qual === '7' ? '7' : '');
}

export function chordTones(ch) {
  const third = ch.qual === 'm' ? 3 : 4;
  const t = [ch.root, mod12(ch.root + third), mod12(ch.root + 7)];
  if (ch.qual === '7') t.push(mod12(ch.root + 10));
  return t;
}

export function chordKey(ch) { return ch ? `${ch.root}:${ch.qual}` : '-'; }
export function parseChordKey(k) {
  if (!k || k === '-') return null;
  const [r, q] = k.split(':');
  return { root: +r, qual: q };
}

export function allKeys() {
  const out = [];
  for (let pc = 0; pc < 12; pc++) out.push({ tonic: pc, mode: 'dur' });
  for (let pc = 0; pc < 12; pc++) out.push({ tonic: pc, mode: 'moll' });
  return out;
}

export function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
export function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
