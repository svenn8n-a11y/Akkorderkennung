const DB = 'akkorderkennung';
const STORE = 'songs';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const listSongs = async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => b.created - a.created);
export const getSong = (id) => tx('readonly', (s) => s.get(id));
export const saveSong = (song) => tx('readwrite', (s) => s.put(song));
export const deleteSong = (id) => tx('readwrite', (s) => s.delete(id));

export async function persist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch (e) { /* nicht unterstützt */ }
  return false;
}

export function pref(name, fallback) {
  try { const v = localStorage.getItem('ak-' + name); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}
export function setPref(name, value) {
  try { localStorage.setItem('ak-' + name, JSON.stringify(value)); } catch (e) { /* Speicher gesperrt */ }
}
