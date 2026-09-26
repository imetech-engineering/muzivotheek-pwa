// Opslag op het apparaat (IndexedDB). Niets gaat naar een server.
//
// Stores:
//   songs       metadata per nummer (titel, componist, bpm, bladwijzers, ...)
//   files       de PDF's zelf als Blob, los van de metadata zodat de lijst snel laadt
//   thumbs      kleine voorbeeldplaatjes van pagina 1
//   notes       krabbels per pagina, sleutel "<songId>:<pagina>"
//   audio       gekoppelde audiobestanden
//   setlists    afspeellijsten met geordende songIds

const DB_NAME = "muzivotheek";
const DB_VERSION = 1;
const STORES = ["songs", "files", "thumbs", "notes", "audio", "setlists"];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then((v) => (out = v), reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, key) => tx(store, "readonly", (s) => wrap(s.get(key))),
  put: (store, key, value) => tx(store, "readwrite", (s) => wrap(s.put(value, key))),
  del: (store, key) => tx(store, "readwrite", (s) => wrap(s.delete(key))),
  all: (store) => tx(store, "readonly", (s) => wrap(s.getAll())),
  keys: (store) => tx(store, "readonly", (s) => wrap(s.getAllKeys())),
  clear: (store) => tx(store, "readwrite", (s) => wrap(s.clear())),
  // Alle sleutels die met een prefix beginnen (krabbels van één nummer).
  keysWithPrefix: (store, prefix) =>
    tx(store, "readonly", (s) => wrap(s.getAllKeys(IDBKeyRange.bound(prefix, prefix + "￿")))),
  delPrefix: (store, prefix) =>
    tx(store, "readwrite", (s) => wrap(s.delete(IDBKeyRange.bound(prefix, prefix + "￿")))),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Vraag de browser om de opslag niet op te ruimen bij ruimtegebrek.
export async function persistStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) {}
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (e) {}
  return null;
}
