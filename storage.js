/* CAC Goodworks Audio Translator — local storage layer.
 * History lives in IndexedDB on this device only. Nothing here talks to a server.
 */
import { uid } from './util.js';

const DB_NAME = 'cac-goodworks-audio-translator';
const DB_VERSION = 1;
const JOBS = 'jobs';
const BLOBS = 'blobs';

/** transformers.js keeps downloaded model files in this Cache Storage bucket. */
export const MODEL_CACHE = 'transformers-cache';
const READY_KEY = 'cac-goodworks-audio-translator.models.ready.v1';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(JOBS)) {
        const s = db.createObjectStore(JOBS, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Could not open local storage.'));
    req.onblocked = () => reject(new Error('Local storage is blocked by another tab.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function run(storeNames, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let out;
    try { out = fn(...[].concat(storeNames).map((n) => tx.objectStore(n))); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out && out instanceof IDBRequest ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
  }));
}

export async function historyAvailable() {
  try { await openDb(); return true; } catch (_) { return false; }
}

/** Saves job metadata + text. Returns the id. */
export async function saveJob(job) {
  const rec = { ...job, id: job.id || uid(), createdAt: job.createdAt || new Date().toISOString() };
  delete rec.originalBlob;
  delete rec.audioBlob;
  await run(JOBS, 'readwrite', (s) => s.put(rec));
  return rec.id;
}

export async function saveBlob(key, blob) {
  await run(BLOBS, 'readwrite', (s) => s.put(blob, key));
}

export async function getBlob(key) {
  const r = await run(BLOBS, 'readonly', (s) => s.get(key));
  return r || null;
}

export async function deleteBlob(key) {
  await run(BLOBS, 'readwrite', (s) => s.delete(key));
}

export async function getJob(id) {
  const r = await run(JOBS, 'readonly', (s) => s.get(id));
  return r || null;
}

export async function listJobs() {
  const all = await run(JOBS, 'readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function deleteJob(id) {
  await run([JOBS, BLOBS], 'readwrite', (jobs, blobs) => {
    jobs.delete(id);
    blobs.delete(`${id}:original`);
    blobs.delete(`${id}:audio`);
  });
}

export async function clearJobs() {
  await run([JOBS, BLOBS], 'readwrite', (jobs, blobs) => { jobs.clear(); blobs.clear(); });
}

/* ---------- Model cache ---------- */

function readReadyMap() {
  try { return JSON.parse(localStorage.getItem(READY_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function writeReadyMap(m) {
  try { localStorage.setItem(READY_KEY, JSON.stringify(m)); } catch (_) { /* ignore */ }
}

export function markModelReady(id) {
  const m = readReadyMap();
  m[id] = Date.now();
  writeReadyMap(m);
}

export function unmarkModelReady(id) {
  const m = readReadyMap();
  delete m[id];
  writeReadyMap(m);
}

async function cachedUrls() {
  if (typeof caches === 'undefined') return [];
  try {
    if (!(await caches.has(MODEL_CACHE))) return [];
    const cache = await caches.open(MODEL_CACHE);
    return (await cache.keys()).map((r) => r.url);
  } catch (_) { return []; }
}

/** Returns a Set of model ids that are both flagged ready and have files in the cache. */
export async function readyModelIds(candidateIds) {
  const flags = readReadyMap();
  const urls = await cachedUrls();
  const out = new Set();
  for (const id of candidateIds) {
    if (!flags[id]) continue;
    const needle = `/${id}/`;
    if (urls.some((u) => u.includes(needle) && /\.onnx(\?|$)/.test(u))) out.add(id);
  }
  return out;
}

export async function isModelReady(id) {
  return (await readyModelIds([id])).has(id);
}

export async function deleteModelFiles(id) {
  unmarkModelReady(id);
  if (typeof caches === 'undefined') return 0;
  let n = 0;
  try {
    if (!(await caches.has(MODEL_CACHE))) return 0;
    const cache = await caches.open(MODEL_CACHE);
    for (const req of await cache.keys()) {
      if (req.url.includes(`/${id}/`)) { if (await cache.delete(req)) n++; }
    }
  } catch (_) { /* ignore */ }
  return n;
}

export async function deleteAllModelFiles() {
  writeReadyMap({});
  if (typeof caches === 'undefined') return false;
  try { return await caches.delete(MODEL_CACHE); } catch (_) { return false; }
}

/* ---------- Storage info ---------- */

export async function estimateStorage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch (_) { /* ignore */ }
  return null;
}

export async function persistenceState() {
  try {
    if (navigator.storage && navigator.storage.persisted) return await navigator.storage.persisted();
  } catch (_) { /* ignore */ }
  return null;
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (_) { /* ignore */ }
  return false;
}

/** CLEAR ALL DATA: history + stored audio. Models are only removed when asked. */
export async function clearAllLocalData({ includeModels = false } = {}) {
  try { await clearJobs(); } catch (_) { /* history may be unavailable */ }
  if (includeModels) await deleteAllModelFiles();
}
