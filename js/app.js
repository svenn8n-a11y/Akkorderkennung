import { audioCtx, openMic, stopStream, Recorder, LiveInput, ChordListener, Player, metronomeClick, buildMidi } from './audio.js';
import { toMono16k, trackPitch, normalize } from './pitch.js';
import { analyse, buildAbc } from './analyse.js';
import { midiName, keyName, chordName, chordKey, allKeys, setGermanNames, pcName, guitarChordName, mod12 } from './musik.js';
import { diagramSvg, bestCapo } from './gitarre.js';
import { transcribe, cleanWords, wordsToText, MODELS, LANGUAGES } from './transkript.js';
import { listSongs, getSong, saveSong, deleteSong, persist, pref, setPref } from './speicher.js';

const $ = (id) => document.getElementById(id);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  screen: 'aufnahme',
  song: null,
  an: null,
  view: 'blatt',
  fontScale: pref('schrift', 1),
  startS16: 0,
};
setGermanNames(pref('deutsch', false));
document.documentElement.style.setProperty('--fs', state.fontScale);

function toast(text, ms = 3200) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  clearTimeout(undoTimer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtDate = (ms) => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/* Navigation */

function go(screen) {
  if (state.screen === screen) return;
  leaveScreen(state.screen);
  state.screen = screen;
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.dataset.screen !== screen));
  document.querySelectorAll('#tabs button').forEach((b) => b.toggleAttribute('aria-current', b.dataset.go === screen));
  document.querySelectorAll('#tabs button[aria-current]').forEach((b) => b.setAttribute('aria-current', 'page'));
  document.querySelector('.app').classList.toggle('im-song', screen === 'song');
  $('tabs').hidden = screen === 'song';
  window.scrollTo(0, 0);
  if (screen === 'songs') renderList();
  if (screen === 'aufnahme') requestAnimationFrame(() => drawTrail($('recSpur'), [], 8));
  if (screen === 'stimmen') requestAnimationFrame(() => drawTrail($('tunerSpur'), [], 8));
}

function leaveScreen(screen) {
  if (screen === 'stimmen') stopTuner();
  if (screen === 'gitarre') stopGitarre();
  if (screen === 'song') { stopPlayback(); stopDiktat(); }
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-go]');
  if (!b) return;
  if (rec) { toast('Erst die Aufnahme beenden.'); return; }
  go(b.dataset.go);
});

window.addEventListener('popstate', () => { if (state.screen === 'song') go('songs'); });

/* Tonspur zeichnen */

function drawTrail(canvas, points, windowSec) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const now = performance.now() / 1000;
  const vis = points.filter((p) => now - p.t < windowSec && p.midi !== null);
  const mids = vis.map((p) => p.midi).sort((a, b) => a - b);
  const center = mids.length ? Math.round(mids[mids.length >> 1]) : 60;
  const span = 14;
  const lo = center - span / 2;
  const y = (m) => h - ((m - lo) / span) * h;
  g.font = '10px -apple-system, system-ui, sans-serif';
  for (let m = Math.ceil(lo); m <= lo + span; m++) {
    const isC = ((m % 12) + 12) % 12 === 0;
    g.strokeStyle = css.getPropertyValue('--line');
    g.lineWidth = isC ? 1.5 : 0.6;
    g.beginPath(); g.moveTo(0, y(m)); g.lineTo(w, y(m)); g.stroke();
    if (isC || m === center) { g.fillStyle = css.getPropertyValue('--muted'); g.fillText(midiName(m), 4, y(m) - 3); }
  }
  g.strokeStyle = css.getPropertyValue('--hl');
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.beginPath();
  let prev = null;
  for (const p of points) {
    if (now - p.t > windowSec) { prev = null; continue; }
    if (p.midi === null) { prev = null; continue; }
    const x = w - ((now - p.t) / windowSec) * w;
    if (prev && p.t - prev.t < 0.15) g.lineTo(x, y(p.midi)); else g.moveTo(x, y(p.midi));
    prev = p;
  }
  g.stroke();
}

/* Metronom */

const metroState = { on: pref('metroAn', false), bpm: pref('metroBpm', 90), meter: pref('metroMeter', 4), countIn: pref('metroVorzaehlen', true), id: null, beat: 0, next: 0, taps: [] };

function renderMetro() {
  $('optMetronom').checked = metroState.on;
  $('metroEinst').hidden = !metroState.on;
  $('metroBpm').value = metroState.bpm;
  $('metroTakt').value = String(metroState.meter);
  $('metroVorzaehlen').checked = metroState.countIn;
  const dots = $('metroPunkte');
  if (dots.children.length !== metroState.meter) {
    dots.innerHTML = '';
    for (let i = 0; i < metroState.meter; i++) dots.append(document.createElement('span'));
  }
}

function flashBeat(beatInBar, when) {
  const c = audioCtx();
  setTimeout(() => {
    [...$('metroPunkte').children].forEach((d, i) => d.classList.toggle('an', i === beatInBar));
  }, Math.max(0, (when - c.currentTime) * 1000));
}

function metroStart(onDownbeat) {
  metroStop();
  const c = audioCtx();
  metroState.next = c.currentTime + 0.12;
  metroState.beat = 0;
  metroState.id = setInterval(() => {
    const spb = 60 / metroState.bpm;
    while (metroState.next < c.currentTime + 0.2) {
      const inBar = metroState.beat % metroState.meter;
      metronomeClick(metroState.next, inBar === 0);
      flashBeat(inBar, metroState.next);
      if (onDownbeat) onDownbeat(metroState.beat, metroState.next);
      metroState.next += spb;
      metroState.beat++;
    }
  }, 25);
}

function metroStop() {
  clearInterval(metroState.id);
  metroState.id = null;
  [...$('metroPunkte').children].forEach((d) => d.classList.remove('an'));
}

function setMetro(changes) {
  Object.assign(metroState, changes);
  metroState.bpm = Math.min(220, Math.max(40, Math.round(metroState.bpm)));
  setPref('metroBpm', metroState.bpm);
  setPref('metroMeter', metroState.meter);
  setPref('metroVorzaehlen', metroState.countIn);
  renderMetro();
  if (metroState.id && !rec) metroStart();
}

$('optMetronom').addEventListener('change', (e) => {
  metroState.on = e.target.checked;
  setPref('metroAn', metroState.on);
  if (!metroState.on && !rec) { metroStop(); $('metroProbe').textContent = 'Probehören'; }
  renderMetro();
});
$('metroProbe').addEventListener('click', () => {
  if (rec) return;
  if (metroState.id) { metroStop(); $('metroProbe').textContent = 'Probehören'; }
  else { metroStart(); $('metroProbe').textContent = 'Stopp'; }
});
$('metroBpm').addEventListener('change', (e) => setMetro({ bpm: +e.target.value || 90 }));
$('metroMinus').addEventListener('click', () => setMetro({ bpm: metroState.bpm - 1 }));
$('metroPlus').addEventListener('click', () => setMetro({ bpm: metroState.bpm + 1 }));
$('metroTakt').addEventListener('change', (e) => setMetro({ meter: +e.target.value }));
$('metroVorzaehlen').addEventListener('change', (e) => setMetro({ countIn: e.target.checked }));
$('metroTap').addEventListener('click', () => {
  const now = performance.now();
  metroState.taps = metroState.taps.filter((t) => now - t < 2500);
  metroState.taps.push(now);
  if (metroState.taps.length >= 3) {
    const d = metroState.taps.slice(1).map((t, i) => t - metroState.taps[i]);
    setMetro({ bpm: 60000 / (d.reduce((a, b) => a + b, 0) / d.length) });
  }
});
renderMetro();

/* Aufnahme */

let rec = null;

async function startRecording() {
  try {
    audioCtx();
    const stream = await openMic();
    const live = new LiveInput(stream);
    const recorder = new Recorder(stream);
    rec = { stream, live, recorder, points: [], t0: performance.now(), started: false };
    try { rec.wake = await navigator.wakeLock?.request('screen'); } catch (e) { /* ohne Wachhalten */ }
    $('recKnopf').classList.add('laeuft');
    $('recKnopf').setAttribute('aria-label', 'Aufnahme beenden');
    if (metroState.on) {
      rec.metro = { bpm: metroState.bpm, meter: metroState.meter };
      const countBeats = metroState.countIn ? metroState.meter : 0;
      const c = audioCtx();
      metroStart((beat, when) => {
        if (!rec || rec.started) return;
        const wait = Math.max(0, (when - c.currentTime) * 1000);
        if (beat < countBeats) {
          setTimeout(() => { if (rec && !rec.started) { $('recNote').textContent = String(countBeats - beat); $('recCents').textContent = 'Vorzählen …'; } }, wait);
        } else if (beat === countBeats) {
          rec.started = true;
          setTimeout(() => beginRecording(), wait);
        }
      });
      $('recHinweis').textContent = countBeats ? 'Ein Takt Vorzählen, dann läuft die Aufnahme.' : 'Aufnahme startet mit dem nächsten Schlag.';
    } else {
      beginRecording();
    }
    loopRecording();
  } catch (err) {
    rec = null;
    micError(err);
  }
}

function beginRecording() {
  if (!rec) return;
  rec.started = true;
  rec.recorder.start();
  rec.t0 = performance.now();
  $('recHinweis').textContent = 'Aufnahme läuft. Tippen zum Beenden.';
  $('recNote').textContent = '–';
  $('recCents').textContent = 'Sing einfach los';
}

function micError(err) {
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'))
    toast('Kein Zugriff aufs Mikrofon. In den Einstellungen des Browsers für diese Seite erlauben.', 6000);
  else if (err && err.message === 'kein-mikro')
    toast('Dieser Browser gibt das Mikrofon nicht frei. Die Seite muss über https laufen.', 6000);
  else toast('Mikrofon ließ sich nicht starten: ' + (err?.message || err), 6000);
}

function loopRecording() {
  if (!rec) return;
  const p = rec.live.pitch();
  const now = performance.now() / 1000;
  rec.points.push({ t: now, midi: p.midi });
  if (rec.points.length > 1200) rec.points.splice(0, 200);
  if (p.midi !== null && rec.recorder.rec.state === 'recording') {
    const r = Math.round(p.midi);
    $('recNote').textContent = midiName(r);
    const c = Math.round((p.midi - r) * 100);
    $('recCents').textContent = c === 0 ? 'genau' : `${c > 0 ? '+' : ''}${c} Cent`;
  }
  if (rec.recorder.rec.state === 'recording') $('recZeit').textContent = fmtTime((performance.now() - rec.t0) / 1000);
  drawTrail($('recSpur'), rec.points, 8);
  rec.raf = requestAnimationFrame(loopRecording);
}

async function stopRecording() {
  const r = rec;
  rec = null;
  cancelAnimationFrame(r.raf);
  metroStop();
  const recording = r.recorder.rec.state === 'recording';
  const blob = recording ? await r.recorder.stop() : null;
  r.live.close();
  stopStream(r.stream);
  try { await r.wake?.release(); } catch (e) { /* schon freigegeben */ }
  $('recKnopf').classList.remove('laeuft');
  $('recKnopf').setAttribute('aria-label', 'Aufnahme starten');
  $('recHinweis').textContent = 'Tippen zum Aufnehmen, nochmal tippen zum Beenden.';
  $('recNote').textContent = '–';
  $('recCents').textContent = 'Sing einfach los';
  $('recZeit').textContent = '0:00';
  $('metroProbe').textContent = 'Probehören';
  if (!blob) return;
  const recSeconds = r.recorder.seconds();
  await processAudio(blob, { ...(r.metro ? { bpm: r.metro.bpm, meter: r.metro.meter, barOrigin: 0 } : {}), recSeconds });
}

$('recKnopf').addEventListener('click', () => (rec ? stopRecording() : startRecording()));

$('dateiLaden').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await processAudio(f, { name: f.name.replace(/\.[^.]+$/, '') });
});

function decode(ab) {
  const c = audioCtx();
  return new Promise((resolve, reject) => {
    const p = c.decodeAudioData(ab, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

function overlay(text, frac) {
  $('overlay').hidden = text === null;
  if (text !== null) { $('overlayText').textContent = text; $('overlayBalken').style.width = `${Math.round((frac || 0) * 100)}%`; }
}

async function processAudio(blob, extra = {}) {
  overlay('Melodie wird ausgewertet …', 0);
  try {
    const buf = await decode(await blob.arrayBuffer());
    const mono = normalize(await toMono16k(buf));
    const track = await trackPitch(mono, (f) => overlay('Melodie wird ausgewertet …', f));
    const now = Date.now();
    const settings = { bpm: extra.bpm || null, lyrics: '', autoSplit: true, overrides: {} };
    if (extra.meter) settings.meter = extra.meter;
    if (Number.isFinite(extra.barOrigin)) settings.barOrigin = extra.barOrigin;
    const song = {
      id: 's' + now,
      name: extra.name || 'Idee ' + fmtDate(now),
      created: now,
      duration: buf.duration,
      audio: blob,
      mime: blob.type || 'audio/mp4',
      track,
      settings,
    };
    const an = analyse(track, song.settings);
    song.meta = meta(an);
    await saveSong(song);
    persist();
    overlay(null);
    if (extra.recSeconds > 3 && buf.duration < extra.recSeconds * 0.6)
      toast(`Achtung: Aufgenommen wurden ${Math.round(extra.recSeconds)} s, lesbar waren nur ${Math.round(buf.duration)} s. Die Aufnahme wurde nicht vollständig gelesen, bitte kurz Bescheid geben.`, 8000);
    else if (!an.notes.length) toast('Keine Töne erkannt. Die Aufnahme ist trotzdem gespeichert. Näher ans Mikro und etwas lauter singen.', 6000);
    await openSong(song.id);
    if (an.notes.length && pref('textAuto', true)) startTranscription(song, mono);
  } catch (err) {
    overlay(null);
    toast('Die Aufnahme ließ sich nicht auswerten: ' + (err?.message || err), 6000);
  }
}

/* Texterkennung */

const tx = { running: null };

function textBanner(html, buttons = []) {
  const b = $('textBanner');
  b.hidden = html === null;
  if (html === null) return;
  b.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'banner-text';
  p.innerHTML = html;
  b.append(p);
  if (buttons.length) {
    const row = document.createElement('div');
    row.className = 'banner-knoepfe';
    buttons.forEach(([label, fn, cls]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'knopf' + (cls ? ' ' + cls : '');
      btn.textContent = label;
      btn.addEventListener('click', fn);
      row.append(btn);
    });
    b.append(row);
  }
}

function bannerProgress(label, frac) {
  textBanner(`<b>${label}</b><div class="balken"><div style="width:${frac === null ? 100 : Math.round(frac * 100)}%" class="${frac === null ? 'laeuft' : ''}"></div></div>`);
}

function modelKey() {
  const v = pref('modell', 'base');
  return v === 'gross' ? 'base' : v === 'klein' ? 'tiny' : MODELS[v] ? v : 'base';
}
function modelReady(k = modelKey()) {
  if (pref('modellGeladen_' + k, false)) return true;
  if (k === 'base') return pref('modellGeladen_gross', false) || pref('modellGeladen', false);
  if (k === 'tiny') return pref('modellGeladen_klein', false);
  return false;
}

async function saveTextStatus(songId, status) {
  const target = state.song && state.song.id === songId ? state.song : await getSong(songId);
  if (!target) return;
  target.textStatus = { ...status, at: Date.now() };
  await saveSong(target);
  if (state.song && state.song.id === songId) renderTextStatus();
}

async function startTranscription(song, mono = null, force = false, replace = false) {
  if (tx.running) return;
  const k = modelKey();
  const mb = MODELS[k].mb;
  if (!modelReady(k) && !force) {
    textBanner(`Soll die App den gesungenen Text erkennen? Dafür lädt sie <b>einmalig ein Sprachmodell (ca. ${mb} MB)</b>, am besten im WLAN. Danach funktioniert es ohne Download.`,
      [['Jetzt laden und erkennen', () => startTranscription(song, mono, true, replace), 'haupt'], ['Später', () => textBanner(null)]]);
    return;
  }
  tx.running = song.id;
  let phase = 'vorbereiten';
  try {
    if (!mono) {
      bannerProgress('Aufnahme wird vorbereitet …', null);
      mono = normalize(await toMono16k(await decode(await song.audio.arrayBuffer())));
    }
    phase = 'laden';
    bannerProgress(modelReady(k) ? 'Sprachmodell wird gestartet …' : `Sprachmodell wird geladen (einmalig ${mb} MB) …`, modelReady(k) ? null : 0);
    const lang = song.settings.textSprache || pref('sprache', 'auto');
    let detected = null;
    const { words, code } = await transcribe(mono, MODELS[k].id, lang, (st) => {
      if (st.phase === 'sprache') detected = st.code;
      if (st.phase === 'laden' && !modelReady(k)) bannerProgress(`Sprachmodell wird geladen (einmalig ${mb} MB) … ${Math.round(st.progress || 0)} %`, (st.progress || 0) / 100);
      if (st.phase === 'geladen') setPref('modellGeladen_' + k, true);
      if (st.phase === 'erkennen') { phase = 'erkennen'; bannerProgress(`Text wird erkannt … ${Math.round((st.progress || 0) * 100)} %`, Math.max(0.03, st.progress || 0)); }
    });
    const fresh = await getSong(song.id);
    if (!fresh) return;
    const clean = cleanWords(words, fresh.track);
    const target = state.song && state.song.id === fresh.id ? state.song : fresh;
    target.words = clean;
    target.wordsText = wordsToText(clean);
    target.textStatus = { ok: true, model: k, lang: code || detected, raw: words.length, kept: clean.length, at: Date.now() };
    if (replace || !target.settings.lyrics || !target.settings.lyrics.trim()) target.settings.lyrics = target.wordsText;
    await saveSong(target);
    if (state.song && state.song.id === fresh.id) {
      $('songText').value = target.settings.lyrics;
      recompute();
      showRecognized();
    }
    if (!clean.length) textBanner(`Die Texterkennung ist durchgelaufen, hat aber keine Wörter gefunden (roh: ${words.length}). Du kannst den Text im Reiter „Text“ eintragen.`, [['Schließen', () => textBanner(null)]]);
    else { textBanner(null); toast(`${clean.length} Wörter erkannt und eingesetzt.`, 2500); }
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 160);
    await saveTextStatus(song.id, { ok: false, model: k, phase, error: msg });
    tx.running = null;
    const next = MODELS[k].next;
    if (next) {
      setPref('modell', next);
      $('optModell').value = next;
      textBanner(`Das Sprachmodell „${MODELS[k].name}“ lief auf diesem Gerät nicht (${msg}). Die App nimmt jetzt „${MODELS[next].name}“ (${MODELS[next].mb} MB).`,
        [['Mit kleinem Modell erkennen', () => startTranscription(song, null, true, replace), 'haupt'], ['Schließen', () => textBanner(null)]]);
    } else {
      textBanner(`Die Texterkennung hat nicht geklappt (${phase}): ${msg}`,
        [['Nochmal versuchen', () => startTranscription(song, null, true, replace)], ['Schließen', () => textBanner(null)]]);
    }
  } finally {
    tx.running = null;
  }
}

function showRecognized() {
  const s = state.song;
  const differs = s.wordsText && s.settings.lyrics.trim() !== s.wordsText.trim();
  $('autoText').hidden = !differs;
  $('autoTextInhalt').textContent = s.wordsText || '';
}

function meta(an) {
  return { key: keyName(an.key), bpm: an.bpm, notes: an.notes.length };
}

/* Liste */

async function renderList() {
  const songs = await listSongs();
  const ul = $('songListe');
  ul.innerHTML = '';
  $('songLeer').hidden = songs.length > 0;
  for (const s of songs) {
    const li = document.createElement('li');
    li.className = 'wisch';
    const del = document.createElement('button');
    del.className = 'wisch-loeschen';
    del.type = 'button';
    del.textContent = 'Löschen';
    del.tabIndex = -1;
    del.addEventListener('click', () => deleteWithUndo(s));
    const b = document.createElement('button');
    b.className = 'wisch-inhalt';
    b.innerHTML = '<span class="n"></span><span class="m"></span><span class="k"></span>';
    b.querySelector('.n').textContent = s.name;
    b.querySelector('.m').textContent = `${fmtDate(s.created)} · ${fmtTime(s.duration || 0)}${s.meta ? ` · ${s.meta.bpm} BPM` : ''}`;
    b.querySelector('.k').textContent = s.meta ? s.meta.key.replace('-Dur', '').replace('-Moll', 'm') : '';
    b.addEventListener('click', () => {
      if (li.dataset.gewischt) return;
      if (li.classList.contains('offen')) { closeSwipes(); return; }
      openSong(s.id);
    });
    b.addEventListener('keydown', (e) => { if (e.key === 'Delete' || e.key === 'Backspace') deleteWithUndo(s); });
    li.append(del, b);
    attachSwipe(li, b);
    ul.append(li);
  }
  try {
    const est = await navigator.storage?.estimate?.();
    const pers = await navigator.storage?.persisted?.();
    $('speicherInfo').textContent =
      'Deine Aufnahmen liegen nur auf diesem Gerät.' +
      (est ? ` Belegt: ${(est.usage / 1e6).toFixed(1)} MB.` : '') +
      (pers ? ' Der Speicher ist dauerhaft freigegeben.' : ' Tipp: App zum Home-Bildschirm hinzufügen, dann löscht der Browser nichts von selbst. Wichtige Ideen zusätzlich über „Teilen“ sichern.');
  } catch (e) { /* ohne Speicherinfo */ }
}

const SWIPE_W = 96;

function closeSwipes(except) {
  document.querySelectorAll('#songListe li.offen').forEach((li) => {
    if (li === except) return;
    li.classList.remove('offen');
    li.querySelector('.wisch-inhalt').style.transform = '';
  });
}

function attachSwipe(li, content) {
  let x0 = 0, y0 = 0, dx = 0, mode = null, base = 0, active = false;
  const begin = (x, y) => {
    x0 = x; y0 = y; dx = 0; mode = null; active = true;
    base = li.classList.contains('offen') ? -SWIPE_W : 0;
    delete li.dataset.gewischt;
  };
  const move = (x, y, e) => {
    if (!active) return;
    const mx = x - x0, my = y - y0;
    if (!mode) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      mode = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (mode === 'x') { closeSwipes(li); li.classList.add('zieht'); }
    }
    if (mode !== 'x') return;
    if (e.cancelable) e.preventDefault();
    dx = Math.max(-SWIPE_W * 1.4, Math.min(0, base + mx));
    content.style.transform = `translateX(${dx}px)`;
  };
  const finish = () => {
    if (!active) return;
    active = false;
    li.classList.remove('zieht');
    if (mode !== 'x') return;
    li.dataset.gewischt = '1';
    setTimeout(() => delete li.dataset.gewischt, 350);
    const open = dx < -SWIPE_W / 2;
    li.classList.toggle('offen', open);
    content.style.transform = open ? `translateX(${-SWIPE_W}px)` : '';
  };
  if ('ontouchstart' in window) {
    content.addEventListener('touchstart', (e) => begin(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    content.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
    content.addEventListener('touchend', finish);
    content.addEventListener('touchcancel', finish);
  } else {
    content.addEventListener('pointerdown', (e) => { if (e.button === 0) { begin(e.clientX, e.clientY); content.setPointerCapture(e.pointerId); } });
    content.addEventListener('pointermove', (e) => move(e.clientX, e.clientY, e));
    content.addEventListener('pointerup', finish);
    content.addEventListener('pointercancel', finish);
  }
}

let undoTimer = null;
async function deleteWithUndo(song) {
  const full = await getSong(song.id);
  await deleteSong(song.id);
  if (state.song && state.song.id === song.id) state.song = null;
  if (state.screen === 'songs') renderList();
  const t = $('toast');
  t.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = `„${song.name}“ gelöscht.`;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'toast-knopf';
  undo.textContent = 'Rückgängig';
  undo.addEventListener('click', async () => {
    clearTimeout(undoTimer);
    t.hidden = true;
    if (full) await saveSong(full);
    if (state.screen === 'songs') renderList();
  });
  t.append(label, undo);
  t.hidden = false;
  clearTimeout(toast.timer);
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => (t.hidden = true), 6000);
}

const closeOutside = (e) => { if (!e.target.closest('#songListe li.offen')) closeSwipes(); };
document.addEventListener('touchstart', closeOutside, { passive: true });
document.addEventListener('mousedown', closeOutside);

$('optModell').value = modelKey();
$('optModell').addEventListener('change', (e) => setPref('modell', e.target.value));
$('optDeutsch').checked = pref('deutsch', false);
$('optDeutsch').addEventListener('change', (e) => {
  setPref('deutsch', e.target.checked);
  setGermanNames(e.target.checked);
  renderList();
});

/* Song-Ansicht */

async function openSong(id) {
  const song = await getSong(id);
  if (!song) return;
  state.song = song;
  state.startS16 = 0;
  song.settings.overrides = song.settings.overrides || {};
  const a = $('audioEl');
  if (a.dataset.url) URL.revokeObjectURL(a.dataset.url);
  a.dataset.url = URL.createObjectURL(song.audio);
  a.src = a.dataset.url;
  $('songName').value = song.name;
  $('songText').value = song.settings.lyrics || '';
  $('optSilben').checked = song.settings.autoSplit !== false;
  $('textSprache').value = song.settings.textSprache || pref('sprache', 'auto');
  showRecognized();
  textBanner(null);
  if (tx.running === song.id) bannerProgress('Text wird erkannt …', null);
  $('textDiktat').hidden = !SR;
  $('loeschenFrage').hidden = true;
  $('songEinst').open = false;
  if (state.screen !== 'song') history.pushState({ song: id }, '');
  go('song');
  recompute();
  setView(state.view);
}

function recompute() {
  const s = state.song;
  state.an = analyse(s.track, s.settings, s.words);
  s.meta = meta(state.an);
  renderSong();
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => state.song && saveSong(state.song), 400);
}

function capoFor() {
  const s = state.song.settings;
  return Number.isInteger(s.capo) ? s.capo : 0;
}

function gripLabel(ch) {
  if (!ch) return '–';
  const capo = capoFor();
  if (!capo) return chordName(ch, state.an.key);
  return guitarChordName({ root: ch.root - capo, qual: ch.qual });
}

function renderSong() {
  const an = state.an, s = state.song;
  const capo = capoFor();
  const info = $('songInfo');
  info.innerHTML = '';
  const add = (label, val) => { const sp = document.createElement('span'); sp.innerHTML = `${label} <b></b>`; sp.querySelector('b').textContent = val; info.append(sp); };
  add('Tempo', `${an.bpm} BPM`);
  add('Takt', `${an.meter}/4`);
  add('Töne', String(an.notes.length));
  add('Länge', fmtTime(s.duration || 0));
  renderTonart();
  const tip = bestCapo(an.slots.map((x) => x.chord));
  $('kapoInfo').textContent = capo
    ? `Du greifst wie in ${keyName({ tonic: mod12(an.key.tonic - capo), mode: an.key.mode })}, es klingt in ${keyName(an.key)}.`
    : tip ? `Tipp: Kapo im ${tip}. Bund, dann einfachere Griffe` : 'ohne Kapodaster';
  renderGriffe();
  renderEinst();
  renderBlatt();
  if (state.view === 'noten') renderNoten();
  renderTextStatus();
}

function renderTonart() {
  const an = state.an, t = an.transpose;
  const base = { tonic: mod12(an.key.tonic - t), mode: an.key.mode };
  const sel = $('tonartWahl');
  sel.innerHTML = '';
  for (let d = -5; d <= 6; d++) {
    const k = { tonic: mod12(base.tonic + d), mode: base.mode };
    sel.append(new Option(`${keyName(k)}${d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d})`}`, String(d)));
  }
  sel.value = String(t);
  $('tonartHinweis').hidden = !t;
}

function transposeTo(t) {
  state.song.settings.transpose = Math.max(-5, Math.min(6, t));
  recompute();
  saveSoon();
  if (player.playing && $('spielModus').value.startsWith('original')) startPlayback(currentPos());
}
$('tonartWahl').addEventListener('change', (e) => transposeTo(+e.target.value));
$('tonartRunter').addEventListener('click', () => transposeTo((state.song.settings.transpose || 0) - 1));
$('tonartHoch').addEventListener('click', () => transposeTo((state.song.settings.transpose || 0) + 1));

function renderGriffe() {
  const seen = new Map();
  state.an.slots.forEach((sl) => sl.chord && seen.set(chordKey(sl.chord), sl.chord));
  const capo = capoFor();
  $('griffe').innerHTML = [...seen.values()].map((ch) => {
    const grip = { root: ch.root - capo, qual: ch.qual };
    return diagramSvg(grip, gripLabel(ch));
  }).join('') || '<p class="klein">Noch keine Akkorde.</p>';
}

function renderEinst() {
  const an = state.an, set = state.song.settings;
  const k = $('setKey');
  k.innerHTML = '';
  const tr = an.transpose;
  k.append(new Option(`Automatisch (${keyName(an.keyAuto)})`, ''));
  allKeys().forEach((key) => {
    const shown = { tonic: mod12(key.tonic + tr), mode: key.mode };
    k.append(new Option(keyName(shown), `${key.tonic}:${key.mode}`));
  });
  k.value = set.key ? `${set.key.tonic}:${set.key.mode}` : '';
  $('setBpm').value = an.bpm;
  $('setMeter').value = String(an.meter);
  $('setGrid').value = String(an.grid);
  $('setPerBar').value = String(an.perBar);
  $('setPerBar').disabled = an.meter === 3;
  const c = $('setCapo');
  c.innerHTML = '';
  const tip = bestCapo(an.slots.map((x) => x.chord));
  c.append(new Option('Ohne Kapodaster', '0'));
  for (let i = 1; i <= 9; i++) c.append(new Option(`${i}. Bund${i === tip ? ' (Tipp)' : ''}`, String(i)));
  c.value = String(Number.isInteger(set.capo) ? set.capo : 0);
  $('shiftWert').textContent = `${set.shiftBeats || 0} ${set.shiftBeats === 1 ? 'Schlag' : 'Schläge'}`;
}

function changeSetting(fn, keepOverrides = false) {
  fn(state.song.settings);
  if (!keepOverrides) state.song.settings.overrides = {};
  recompute();
  saveSoon();
}

$('setKey').addEventListener('change', (e) => changeSetting((s) => {
  if (!e.target.value) delete s.key;
  else { const [t, m] = e.target.value.split(':'); s.key = { tonic: +t, mode: m }; }
}));
$('setBpm').addEventListener('change', (e) => changeSetting((s) => { const v = Math.round(+e.target.value); if (v >= 40 && v <= 220) s.bpm = v; }));
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
  const inp = $(b.dataset.for);
  inp.value = Math.min(220, Math.max(40, (+inp.value || 90) + +b.dataset.step));
  inp.dispatchEvent(new Event('change'));
}));
$('setMeter').addEventListener('change', (e) => changeSetting((s) => { s.meter = +e.target.value; }));
$('setGrid').addEventListener('change', (e) => changeSetting((s) => { s.grid = +e.target.value; }));
$('setPerBar').addEventListener('change', (e) => changeSetting((s) => { s.perBar = +e.target.value; }));
$('setCapo').addEventListener('change', (e) => changeSetting((s) => { if (e.target.value === '0') delete s.capo; else s.capo = +e.target.value; }, true));
$('shiftMinus').addEventListener('click', () => changeSetting((s) => { s.shiftBeats = Math.max(0, (s.shiftBeats || 0) - 1); }));
$('shiftPlus').addEventListener('click', () => changeSetting((s) => { s.shiftBeats = Math.min(7, (s.shiftBeats || 0) + 1); }));
$('setReset').addEventListener('click', () => changeSetting((s) => {
  for (const k of ['key', 'bpm', 'meter', 'grid', 'perBar', 'capo', 'shiftBeats', 'transpose']) delete s[k];
}));

$('songName').addEventListener('input', (e) => { state.song.name = e.target.value.trim() || 'Ohne Namen'; saveSoon(); });
$('songZurueck').addEventListener('click', () => history.back());

/* Ansichten */

function setView(v) {
  state.view = v;
  [['blatt', 'tabBlatt', 'ansichtBlatt'], ['noten', 'tabNoten', 'ansichtNoten'], ['text', 'tabText', 'ansichtText']].forEach(([name, tab, sec]) => {
    $(tab).setAttribute('aria-selected', String(name === v));
    $(sec).hidden = name !== v;
  });
  if (v === 'noten') renderNoten();
}
$('tabBlatt').addEventListener('click', () => setView('blatt'));
$('tabNoten').addEventListener('click', () => setView('noten'));
$('tabText').addEventListener('click', () => setView('text'));

function anchorsForSlots() {
  const an = state.an;
  const notes = an.q.notes16;
  const map = new Map();
  const pre = new Map();
  const tail = [];
  const add = (m, i, sl) => { if (!m.has(i)) m.set(i, []); m.get(i).push(sl); };
  let prev = null;
  an.slots.forEach((sl) => {
    const k = chordKey(sl.chord);
    const changed = k !== prev;
    prev = k;
    if (!changed) return;
    const end = sl.start16 + sl.len16;
    const idx = notes.findIndex((n) => n.syl && n.s16 >= sl.start16 && n.s16 < end);
    if (idx >= 0) { add(map, idx, sl); return; }
    let j = -1;
    for (let q = notes.length - 1; q >= 0; q--) if (notes[q].syl && notes[q].s16 <= sl.start16) { j = q; break; }
    const nextSyl = notes.findIndex((n) => n.syl && n.s16 >= end);
    const sung = j >= 0 && notes.some((n, q) => q >= j && (nextSyl < 0 || q < nextSyl) && n.s16 <= sl.start16 && n.s16 + n.d16 > sl.start16);
    if (sung) add(map, j, sl);
    else if (nextSyl >= 0) add(pre, nextSyl, sl);
    else tail.push(sl);
  });
  return { map, pre, tail };
}

function chordButton(sl) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = gripLabel(sl.chord);
  b.dataset.slot = sl.index;
  if (sl.manual) b.classList.add('hand');
  return b;
}

function renderBlatt() {
  const an = state.an;
  const root = $('ansichtBlatt');
  root.innerHTML = '';
  if (!an.notes.length) { root.innerHTML = '<p class="blatt-hinweis">In dieser Aufnahme wurden keine Töne erkannt.</p>'; return; }
  const hint = document.createElement('p');
  hint.className = 'blatt-hinweis';
  hint.textContent = 'Tippe auf einen Akkord, um ihn zu ändern. Tippe auf eine Stelle, um dort mit dem Abspielen zu beginnen.';
  root.append(hint);
  const hasLyrics = an.lyricLines.length && an.q.notes16.some((n) => n.syl);
  state.marks = [];
  if (hasLyrics) {
    const { map, pre, tail } = anchorsForSlots();
    let lineEl = null, lineNo = -1, wordEl = null, first = true;
    an.q.notes16.forEach((n, i) => {
      if (!n.syl) return;
      if (pre.has(i)) {
        const z = document.createElement('div');
        z.className = 'blatt-zwischen';
        z.dataset.s16 = pre.get(i)[0].start16;
        const lab = document.createElement('span');
        lab.textContent = first ? 'Vorspiel' : 'Zwischenspiel';
        z.append(lab);
        pre.get(i).forEach((sl) => z.append(chordButton(sl)));
        root.append(z);
        state.marks.push({ s16: pre.get(i)[0].start16, el: z });
        lineNo = -1;
      }
      first = false;
      if (n.syl.line !== lineNo) {
        lineNo = n.syl.line;
        lineEl = document.createElement('div');
        lineEl.className = 'blatt-zeile';
        root.append(lineEl);
        wordEl = null;
      }
      if (!wordEl || n.syl.wordStart) {
        wordEl = document.createElement('span');
        wordEl.className = 'wort';
        lineEl.append(wordEl);
      }
      const sp = document.createElement('span');
      sp.className = 'silbe';
      sp.dataset.s16 = n.s16;
      const a = document.createElement('span');
      a.className = 'a';
      const here = map.get(i) || [];
      here.forEach((sl, j) => { if (j) a.append(' '); a.append(chordButton(sl)); });
      if (here.length) {
        sp.classList.add('mit-akkord');
        if (!n.syl.wordEnd && here.map((sl) => gripLabel(sl.chord)).join(' ').length >= n.syl.text.length) sp.classList.add('trennt');
        sp.style.setProperty('--breite', here.map((sl) => gripLabel(sl.chord)).join(' ').length + 0.5);
      }
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = n.syl.text;
      sp.append(a, t);
      wordEl.append(sp);
      state.marks.push({ s16: n.s16, el: sp });
    });
    root.querySelectorAll('.blatt-zeile').forEach((l) => { if (!l.querySelector('.mit-akkord')) l.classList.add('ohne-akkorde'); });
    if (tail.length) {
      const d = document.createElement('div');
      d.className = 'blatt-zwischen';
      const lab = document.createElement('span');
      lab.textContent = 'Nachspiel';
      d.append(lab);
      tail.forEach((sl) => d.append(chordButton(sl)));
      d.dataset.s16 = tail[0].start16;
      state.marks.push({ s16: tail[0].start16, el: d });
      root.append(d);
    }
    if (an.lyr.total < an.lyr.notes) {
      const p = document.createElement('p');
      p.className = 'blatt-hinweis';
      p.textContent = `Noch ${an.lyr.notes - an.lyr.total} Töne ohne Text.`;
      root.append(p);
    }
  } else {
    const perLine = Math.max(1, Math.min(4, Math.floor(root.clientWidth / (120 * state.fontScale)) || 4));
    const grid = document.createElement('div');
    grid.className = 'takte';
    grid.style.setProperty('--spalten', perLine);
    const bars = an.q.total16 / an.q.barLen;
    let prevK = null;
    for (let b = 0; b < bars; b++) {
      const cell = document.createElement('div');
      cell.className = 'takt';
      cell.dataset.s16 = b * an.q.barLen;
      an.slots.filter((sl) => Math.floor(sl.start16 / an.q.barLen) === b).forEach((sl) => {
        const btn = chordButton(sl);
        const k = chordKey(sl.chord);
        if (k === prevK) btn.classList.add('gleich');
        prevK = k;
        cell.append(btn);
      });
      grid.append(cell);
      state.marks.push({ s16: b * an.q.barLen, el: cell });
    }
    root.append(grid);
    const p = document.createElement('p');
    p.className = 'blatt-hinweis';
    p.style.marginTop = '8px';
    p.textContent = 'Trag im Reiter „Text“ deinen Liedtext ein, dann stehen die Akkorde über den passenden Silben.';
    root.append(p);
  }
}

$('ansichtBlatt').addEventListener('click', (e) => {
  const cb = e.target.closest('button[data-slot]');
  if (cb) { openChordPopup(+cb.dataset.slot, cb); return; }
  const m = e.target.closest('[data-s16]');
  if (m) seekTo(+m.dataset.s16);
});

function openChordPopup(slotIndex, anchor) {
  const sl = state.an.slots[slotIndex];
  const pop = $('akkordPopup');
  const fill = (list, all) => {
    pop.innerHTML = '';
    list.forEach((ch, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = gripLabel(ch);
      if (!all && i === 0) { const sm = document.createElement('small'); sm.textContent = 'Vorschlag'; b.append(sm); }
      if (chordKey(ch) === chordKey(sl.chord)) b.classList.add('aktuell');
      b.addEventListener('click', () => pickChord(slotIndex, ch));
      pop.append(b);
    });
    const none = document.createElement('button');
    none.type = 'button';
    none.textContent = 'Kein Akkord';
    none.addEventListener('click', () => pickChord(slotIndex, null));
    pop.append(none);
    if (!all) {
      const more = document.createElement('button');
      more.type = 'button';
      more.textContent = 'Alle Akkorde …';
      more.addEventListener('click', (ev) => { ev.stopPropagation(); fill(allChords(), true); place(); });
      pop.append(more);
    }
  };
  const place = () => {
    const r = anchor.getBoundingClientRect();
    pop.style.maxHeight = `${window.innerHeight - 40}px`;
    pop.style.overflowY = 'auto';
    const ph = pop.offsetHeight, pw = pop.offsetWidth;
    pop.style.left = `${Math.max(16, Math.min(window.innerWidth - pw - 16, r.left))}px`;
    pop.style.top = `${Math.max(20, Math.min(window.innerHeight - ph - 20, r.bottom + 6))}px`;
  };
  fill(sl.alts, false);
  pop.hidden = false;
  place();
  setTimeout(() => document.addEventListener('click', closePopup, { once: true }), 0);
}
function closePopup() { $('akkordPopup').hidden = true; }
function allChords() {
  const capo = capoFor();
  const out = [];
  for (let r = 0; r < 12; r++) for (const q of ['', 'm', '7']) out.push({ root: (r + capo) % 12, qual: q });
  return out;
}
function pickChord(slotIndex, ch) {
  const s = state.song.settings;
  const sl = state.an.slots[slotIndex];
  if (ch && chordKey(ch) === chordKey(sl.auto)) delete s.overrides[slotIndex];
  else s.overrides[slotIndex] = ch ? chordKey({ root: mod12(ch.root - (s.transpose || 0)), qual: ch.qual }) : '-';
  $('akkordPopup').hidden = true;
  recompute();
  saveSoon();
}

function barsPerLine(width, scale, lyrics) { return Math.max(1, Math.min(6, Math.floor(width / ((lyrics ? 250 : 175) * scale)))); }

function abcFor(an, bpl, withTitle) {
  return buildAbc({
    events: an.events, q: an.q, slots: an.slots, key: an.key, meter: an.meter, bpm: an.bpm,
    barsPerLine: bpl, octaveUp: an.octaveUp, chordLabel: (c) => chordName(c, an.key),
    title: withTitle ? state.song.name : '',
  });
}

function renderNoten() {
  const an = state.an;
  const box = $('ansichtNoten');
  if (!an.notes.length) { $('notenBild').innerHTML = '<p class="blatt-hinweis">Keine Töne erkannt.</p>'; return; }
  const width = Math.max(260, box.clientWidth - 32);
  const scale = state.fontScale;
  const lyrics = an.q.notes16.some((n) => n.syl);
  const bpl = barsPerLine(width, scale, lyrics);
  window.ABCJS.renderAbc('notenBild', abcFor(an, 10000, false), {
    add_classes: true,
    scale,
    staffwidth: width / scale - 8,
    wrap: { minSpacing: lyrics ? 2.6 : 1.6, maxSpacing: 3.2, preferredMeasuresPerLine: bpl },
    paddingleft: 0, paddingright: 0, paddingtop: 4, paddingbottom: 4,
    clickListener: (el, tune, classes) => {
      const m = /abcjs-mm(\d+)/.exec(classes || '');
      if (m) seekTo(+m[1] * an.q.barLen);
    },
  });
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.screen === 'song') { renderBlatt(); if (state.view === 'noten') renderNoten(); } }, 250);
});

function setFont(delta) {
  state.fontScale = Math.round(Math.min(2, Math.max(0.7, state.fontScale + delta)) * 10) / 10;
  setPref('schrift', state.fontScale);
  document.documentElement.style.setProperty('--fs', state.fontScale);
  renderBlatt();
  if (state.view === 'noten') renderNoten();
  toast(`Schriftgröße ${Math.round(state.fontScale * 100)} %`, 1200);
}
$('schriftKlein').addEventListener('click', () => setFont(-0.1));
$('schriftGross').addEventListener('click', () => setFont(0.1));

/* Text */

let textTimer = null;
$('songText').addEventListener('input', (e) => {
  state.song.settings.lyrics = e.target.value;
  clearTimeout(textTimer);
  textTimer = setTimeout(() => { recompute(); saveSoon(); }, 350);
});
$('textSprache').addEventListener('change', (e) => {
  state.song.settings.textSprache = e.target.value;
  saveSoon();
});
$('optSprache').value = pref('sprache', 'auto');
$('optSprache').addEventListener('change', (e) => setPref('sprache', e.target.value));
$('optSilben').addEventListener('change', (e) => { state.song.settings.autoSplit = e.target.checked; recompute(); saveSoon(); });
$('autoTextUebernehmen').addEventListener('click', () => {
  const t = $('songText');
  t.value = state.song.wordsText || '';
  t.dispatchEvent(new Event('input'));
});

function renderTextStatus() {
  const l = state.an.lyr;
  let msg = '';
  if (l.timed) msg = `Text nach Zeit zugeordnet: ${l.total} Wörter liegen auf den Tönen, auf denen du sie gesungen hast. Einzelne Wörter kannst du hier korrigieren, die Zuordnung bleibt erhalten, solange die Zahl der Wörter gleich bleibt.`;
  else if (l.mismatch) msg = `Du hast Wörter hinzugefügt oder entfernt. Deshalb verteilt die App die Silben jetzt der Reihe nach auf die Töne. Mit „Erkannten Text übernehmen“ kommt die Zeitzuordnung zurück.`;
  else if (!l.total) msg = `Die Melodie hat ${l.notes} Töne. Jede Silbe bekommt einen Ton.`;
  else if (l.total === l.notes) msg = `${l.total} Silben passen genau auf ${l.notes} Töne.`;
  else if (l.total < l.notes) msg = `${l.total} Silben auf ${l.notes} Töne verteilt, ${l.notes - l.total} Töne sind noch ohne Text.`;
  else msg = `${l.total - l.notes} Silben mehr als Töne. Die überzähligen erscheinen nicht, dann Silben zusammenfassen (Bindestrich weglassen).`;
  const ts = state.song.textStatus;
  if (ts) {
    const when = new Date(ts.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    msg += ts.ok
      ? ` Letzte Erkennung ${when} (Modell ${MODELS[ts.model]?.name || ts.model}${ts.lang ? ', Sprache ' + (LANGUAGES[ts.lang] || ts.lang) : ''}): ${ts.raw} Wörter gehört, ${ts.kept} übernommen.`
      : ` Letzte Erkennung ${when} fehlgeschlagen beim Schritt „${ts.phase}“: ${ts.error}`;
  }
  $('textStatus').textContent = msg;
  $('textErkennen').textContent = state.song.words ? 'Text neu erkennen' : 'Text aus der Aufnahme erkennen';
}

$('textErkennen').addEventListener('click', () => {
  if (tx.running) { toast('Die Texterkennung läuft schon.'); return; }
  startTranscription(state.song, null, modelReady(), true);
});

function startSpeech(onText) {
  const r = new SR();
  r.lang = 'de-DE';
  r.continuous = true;
  r.interimResults = true;
  let finalText = '';
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript.trim() + '\n';
      else interim += e.results[i][0].transcript;
    }
    onText((finalText + interim).trim(), finalText.trim());
  };
  r.onerror = () => {};
  try { r.start(); } catch (e) { return null; }
  return r;
}

let diktat = null;
$('textDiktat').addEventListener('click', () => {
  if (diktat) { stopDiktat(); return; }
  const t = $('songText');
  const before = t.value ? t.value.replace(/\s+$/, '') + '\n' : '';
  diktat = startSpeech((all, fin) => { t.value = before + all; state.song.settings.lyrics = before + fin; });
  if (!diktat) { toast('Spracherkennung ließ sich nicht starten. Nutze das Mikrofon der Tastatur.'); return; }
  diktat.onend = () => stopDiktat();
  $('textDiktat').textContent = 'Fertig';
  toast('Sprich jetzt deinen Text, Zeile für Zeile.');
});
function stopDiktat() {
  if (!diktat) return;
  const d = diktat;
  diktat = null;
  try { d.stop(); } catch (e) { /* schon beendet */ }
  $('textDiktat').textContent = 'Text sprechen';
  $('songText').dispatchEvent(new Event('input'));
}

/* Abspielen */

const player = new Player();
const chordPlayer = new Player();
let playRaf = null, lastMark = null, lastBar = -1;

function speed() { return +$('speed').value / 100; }
$('speed').addEventListener('input', () => ($('speedWert').textContent = `${$('speed').value} %`));
$('speed').addEventListener('change', () => { if (player.playing || chordPlayer.playing) seekTo(currentPos()); });

function currentPos() {
  const p = player.pos || chordPlayer.pos;
  return p ? Math.max(0, p()) : state.startS16;
}

function startPlayback(from = state.startS16) {
  audioCtx();
  const an = state.an, mode = $('spielModus').value;
  const sec16 = an.q.sec16;
  const onEnd = () => { stopPlayback(); state.startS16 = 0; };
  const click = $('klickKnopf').getAttribute('aria-pressed') === 'true';
  const barLen = an.q.barLen;
  if (mode === 'original' || mode === 'original+akkorde') {
    if (mode === 'original+akkorde' || click) chordPlayer.playSynth({ events: an.events, slots: an.slots, sec16, fromS16: from, speed: speed(), melody: false, chords: mode === 'original+akkorde', click, barLen });
    player.playOriginal({
      audioEl: $('audioEl'), originSec: an.q.originSec, sec16, fromS16: from, speed: speed(), onEnd,
      onError: () => { stopPlayback(); toast('Die Aufnahme ließ sich nicht abspielen. Nochmal auf Abspielen tippen.'); },
    });
  } else {
    player.playSynth({ events: an.events, slots: an.slots, sec16, fromS16: from, speed: speed(), melody: mode === 'beides', chords: true, click, barLen, onEnd });
  }
  $('spielKnopf').textContent = '■';
  $('spielKnopf').setAttribute('aria-label', 'Stoppen');
  lastBar = -1;
  cancelAnimationFrame(playRaf);
  playRaf = requestAnimationFrame(follow);
}

function stopPlayback() {
  player.stop();
  chordPlayer.stop();
  cancelAnimationFrame(playRaf);
  $('spielKnopf').textContent = '▶';
  $('spielKnopf').setAttribute('aria-label', 'Abspielen');
  clearHighlight();
}

function clearHighlight() {
  if (lastMark) lastMark.classList.remove('jetzt');
  lastMark = null;
  document.querySelectorAll('#notenBild .aktiv').forEach((e) => e.classList.remove('aktiv'));
}

function seekTo(s16) {
  state.startS16 = Math.max(0, s16);
  if (player.playing || chordPlayer.playing) startPlayback(state.startS16);
  else toast(`Abspielen startet ab Takt ${Math.floor(s16 / state.an.q.barLen) + 1}`, 1400);
}

$('spielKnopf').addEventListener('click', () => {
  if (player.playing || chordPlayer.playing) { state.startS16 = currentPos(); stopPlayback(); }
  else startPlayback();
});
$('klickKnopf').setAttribute('aria-pressed', String(pref('klick', false)));
$('klickKnopf').addEventListener('click', () => {
  const on = $('klickKnopf').getAttribute('aria-pressed') !== 'true';
  $('klickKnopf').setAttribute('aria-pressed', String(on));
  setPref('klick', on);
  if (player.playing || chordPlayer.playing) startPlayback(currentPos());
});
$('spielModus').addEventListener('change', () => { if (player.playing || chordPlayer.playing) startPlayback(currentPos()); });

function keepVisible(el) {
  const r = el.getBoundingClientRect();
  const top = 90, bottom = window.innerHeight - 170;
  if (r.top < top || r.bottom > bottom) {
    const target = window.scrollY + r.top - Math.max(top, (window.innerHeight - 170) * 0.3);
    window.scrollTo({ top: Math.max(0, target), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}

function follow() {
  if (!(player.playing || chordPlayer.playing)) return;
  const pos = currentPos();
  const an = state.an;
  if (state.view === 'blatt' && state.marks?.length) {
    let m = null;
    for (const x of state.marks) { if (x.s16 <= pos + 0.01) m = x; else break; }
    if (m && m.el !== lastMark) {
      if (lastMark) lastMark.classList.remove('jetzt');
      m.el.classList.add('jetzt');
      lastMark = m.el;
      keepVisible(m.el);
    }
  }
  if (state.view === 'noten') {
    const bar = Math.floor(pos / an.q.barLen);
    if (bar !== lastBar) {
      document.querySelectorAll('#notenBild .aktiv').forEach((e) => e.classList.remove('aktiv'));
      const els = document.querySelectorAll(`#notenBild .abcjs-mm${bar}`);
      els.forEach((e) => { if (e.classList.contains('abcjs-note') || e.classList.contains('abcjs-rest')) e.classList.add('aktiv'); });
      if (els[0]) keepVisible(els[0]);
      lastBar = bar;
    }
  }
  playRaf = requestAnimationFrame(follow);
}

/* Teilen */

function safeName() { return (state.song.name || 'Idee').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60); }

async function shareFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function shareText(text) {
  try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Akkordblatt kopiert.'); }
  catch (e) { toast('Teilen wird hier nicht unterstützt.'); }
}

$('teilenAudio').addEventListener('click', () => {
  const ext = /mp4|m4a|aac/.test(state.song.mime) ? 'm4a' : /webm/.test(state.song.mime) ? 'webm' : /ogg/.test(state.song.mime) ? 'ogg' : 'wav';
  shareFile(state.song.audio, `${safeName()}.${ext}`);
});
$('teilenMidi').addEventListener('click', () => {
  const an = state.an;
  shareFile(buildMidi({ events: an.events, slots: an.slots, bpm: an.bpm }), `${safeName()}.mid`);
});
$('teilenBild').addEventListener('click', async () => {
  const an = state.an;
  if (!an.notes.length) { toast('Keine Noten vorhanden.'); return; }
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute;left:-10000px;top:0;width:820px;color:#000;background:#fff';
  document.body.append(div);
  window.ABCJS.renderAbc(div, abcFor(an, 4, true), { staffwidth: 780, foregroundColor: '#000000', paddingleft: 20, paddingright: 20, paddingtop: 20, paddingbottom: 20 });
  const svg = div.querySelector('svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const w = +svg.getAttribute('width') || 820, h = +svg.getAttribute('height') || 400;
  const txt = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, '#000');
  div.remove();
  const img = new Image();
  const url = URL.createObjectURL(new Blob([txt], { type: 'image/svg+xml' }));
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = w * 2; c.height = h * 2;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    c.toBlob((b) => shareFile(b, `${safeName()} Noten.png`), 'image/png');
  };
  img.onerror = () => toast('Das Notenbild ließ sich nicht erzeugen.');
  img.src = url;
});
$('teilenBlatt').addEventListener('click', () => shareText(chordSheetText()));

function chordSheetText() {
  const an = state.an;
  const capo = capoFor();
  const out = [state.song.name, `${keyName(an.key)} · ${an.bpm} BPM${capo ? ` · Kapo ${capo}` : ''}`, ''];
  const hasLyrics = an.q.notes16.some((n) => n.syl);
  if (hasLyrics) {
    const { map, pre, tail } = anchorsForSlots();
    let chordLine = '', textLine = '', lineNo = -1, first = true;
    const flush = () => { if (textLine || chordLine) { out.push(chordLine.replace(/\s+$/, ''), textLine.replace(/\s+$/, '')); } chordLine = ''; textLine = ''; };
    an.q.notes16.forEach((n, i) => {
      if (!n.syl) return;
      if (pre.has(i)) { flush(); out.push(`[${first ? 'Vorspiel' : 'Zwischenspiel'}] ` + pre.get(i).map((sl) => gripLabel(sl.chord)).join(' ')); lineNo = -1; }
      first = false;
      if (n.syl.line !== lineNo) { flush(); lineNo = n.syl.line; }
      const chords = (map.get(i) || []).map((sl) => gripLabel(sl.chord)).join(' ');
      if (chords) {
        if (chordLine.length > textLine.length) textLine = textLine.padEnd(chordLine.length, ' ');
        chordLine = chordLine.padEnd(textLine.length, ' ') + chords + ' ';
      }
      textLine += n.syl.text + (n.syl.wordEnd ? ' ' : '');
    });
    flush();
    if (tail.length) out.push('[Nachspiel] ' + tail.map((sl) => gripLabel(sl.chord)).join(' '));
  } else {
    const bars = an.q.total16 / an.q.barLen;
    let line = '|';
    for (let b = 0; b < bars; b++) {
      line += ' ' + an.slots.filter((sl) => Math.floor(sl.start16 / an.q.barLen) === b).map((sl) => gripLabel(sl.chord)).join(' ') + ' |';
      if (b % 4 === 3) { out.push(line); line = '|'; }
    }
    if (line !== '|') out.push(line);
  }
  return out.join('\n');
}

$('songLoeschen').addEventListener('click', () => ($('loeschenFrage').hidden = false));
$('loeschenNein').addEventListener('click', () => ($('loeschenFrage').hidden = true));
$('loeschenJa').addEventListener('click', async () => {
  const song = state.song;
  history.back();
  await deleteWithUndo(song);
});

/* Stimmgerät */

let tuner = null;
async function startTuner() {
  try {
    audioCtx();
    const stream = await openMic();
    tuner = { stream, live: new LiveInput(stream), points: [] };
    $('tunerKnopf').textContent = 'Mikrofon stoppen';
    $('tunerKnopf').classList.add('aktiv');
    loopTuner();
  } catch (err) { tuner = null; micError(err); }
}
function loopTuner() {
  if (!tuner) return;
  const p = tuner.live.pitch();
  const now = performance.now() / 1000;
  tuner.points.push({ t: now, midi: p.midi });
  if (tuner.points.length > 1200) tuner.points.splice(0, 200);
  if (p.midi !== null) {
    const r = Math.round(p.midi);
    const c = (p.midi - r) * 100;
    $('tunerNote').textContent = midiName(r);
    $('tunerNadel').style.left = `${50 + c}%`;
    $('tunerWerte').textContent = `${p.freq.toFixed(1)} Hz · ${c >= 0 ? '+' : ''}${Math.round(c)} Cent`;
  }
  drawTrail($('tunerSpur'), tuner.points, 8);
  tuner.raf = requestAnimationFrame(loopTuner);
}
function stopTuner() {
  if (!tuner) return;
  cancelAnimationFrame(tuner.raf);
  tuner.live.close();
  stopStream(tuner.stream);
  tuner = null;
  $('tunerKnopf').textContent = 'Mikrofon starten';
  $('tunerKnopf').classList.remove('aktiv');
}
$('tunerKnopf').addEventListener('click', () => (tuner ? stopTuner() : startTuner()));

/* Gitarre */

let git = null;
const gitHistory = [];
const chromaEl = $('gitChroma');
for (let i = 0; i < 12; i++) { const d = document.createElement('div'); d.innerHTML = '<span></span>'; chromaEl.append(d); }
function labelChroma() { [...chromaEl.children].forEach((d, i) => (d.firstChild.textContent = pcName(i))); }
labelChroma();

async function startGitarre() {
  try {
    audioCtx();
    const stream = await openMic();
    git = { stream, cl: new ChordListener(stream), cand: null, count: 0, current: null, t0: performance.now(), last: 0 };
    try { git.wake = await navigator.wakeLock?.request('screen'); } catch (e) { /* ohne Wachhalten */ }
    $('gitKnopf').textContent = 'Zuhören stoppen';
    $('gitKnopf').classList.add('aktiv');
    labelChroma();
    loopGitarre();
  } catch (err) { git = null; micError(err); }
}
function loopGitarre(ts = 0) {
  if (!git) return;
  git.raf = requestAnimationFrame(loopGitarre);
  if (ts - git.last < 60) return;
  git.last = ts;
  const r = git.cl.read();
  const mx = Math.max(...r.chroma) || 1;
  [...chromaEl.children].forEach((d, i) => (d.style.height = `${Math.round((r.chroma[i] / mx) * 100)}%`));
  const k = r.chord ? chordKey(r.chord) : null;
  if (k && k === git.cand) git.count++;
  else { git.cand = k; git.count = 1; }
  if (k && git.count >= 4 && k !== git.current) {
    git.current = k;
    const name = guitarChordName(r.chord);
    $('gitAkkord').textContent = name;
    $('gitGriff').innerHTML = diagramSvg(r.chord, name);
    gitHistory.push({ name, t: (performance.now() - git.t0) / 1000 });
    renderGitHistory();
  }
}
function renderGitHistory() {
  $('gitVerlauf').innerHTML = gitHistory.map((h) => `<li>${h.name}<small>${fmtTime(h.t)}</small></li>`).join('');
}
function stopGitarre() {
  if (!git) return;
  cancelAnimationFrame(git.raf);
  git.cl.close();
  stopStream(git.stream);
  try { git.wake?.release(); } catch (e) { /* schon freigegeben */ }
  git = null;
  $('gitKnopf').textContent = 'Zuhören starten';
  $('gitKnopf').classList.remove('aktiv');
}
$('gitKnopf').addEventListener('click', () => (git ? stopGitarre() : startGitarre()));
$('gitLeeren').addEventListener('click', () => { gitHistory.length = 0; renderGitHistory(); $('gitAkkord').textContent = '–'; $('gitGriff').innerHTML = ''; });
$('gitKopieren').addEventListener('click', async () => {
  const text = gitHistory.map((h) => h.name).join(' ');
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast('Verlauf kopiert.'); } catch (e) { shareText(text); }
});

/* Start */

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.screen === 'song') { state.startS16 = currentPos(); stopPlayback(); }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

requestAnimationFrame(() => drawTrail($('recSpur'), [], 8));

