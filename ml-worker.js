/* CAC Goodworks Audio Translator — AI worker.
 * Runs speech recognition (Whisper), translation (NLLB / Opus-MT) and text-to-speech (MMS-TTS)
 * with Transformers.js (Apache-2.0) + ONNX Runtime WebAssembly. Everything runs on the device.
 * Models are downloaded once from Hugging Face and kept in the browser's Cache Storage.
 * This file is loaded as a module worker: new Worker('ml-worker.js', { type: 'module' }).
 */

let lib = null;
const pipes = new Map();

async function getLib(url) {
  if (lib) return lib;
  try {
    lib = await import(url);
  } catch (e) {
    const err = new Error('LIB_UNAVAILABLE');
    err.code = 'LIB_UNAVAILABLE';
    throw err;
  }
  const env = lib.env;
  env.allowLocalModels = false;   // models come from the Hugging Face Hub...
  env.allowRemoteModels = true;
  env.useBrowserCache = true;     // ...and are cached on the device after the first download
  return lib;
}

function makeProgress(id) {
  const files = new Map();
  let last = 0;
  return (p) => {
    if (!p || !p.file) return;
    const f = files.get(p.file) || { loaded: 0, total: 0 };
    if (p.status === 'progress' || p.status === 'download') {
      if (typeof p.loaded === 'number') f.loaded = p.loaded;
      if (typeof p.total === 'number') f.total = p.total;
    } else if (p.status === 'done') {
      if (f.total) f.loaded = f.total;
    }
    files.set(p.file, f);
    const now = Date.now();
    if (p.status !== 'done' && now - last < 120) return;
    last = now;
    let loaded = 0;
    let total = 0;
    for (const v of files.values()) { loaded += v.loaded; total += v.total; }
    self.postMessage({ type: 'progress', id, loaded, total, file: p.file, status: p.status });
  };
}

async function handleLoad(id, m) {
  const key = `${m.task}::${m.model}`;
  if (pipes.has(key)) return { ready: true, reused: true };
  const L = await getLib(m.libUrl);
  const pipe = await L.pipeline(m.task, m.model, {
    dtype: m.dtype || 'q8',
    progress_callback: makeProgress(id),
  });
  pipes.set(key, pipe);
  return { ready: true };
}

async function handleRun(m) {
  const pipe = pipes.get(`${m.task}::${m.model}`);
  if (!pipe) throw new Error('The model is not loaded yet.');
  if (m.task === 'automatic-speech-recognition') {
    const out = await pipe(m.audio, m.options || {});
    return { data: { text: String((out && out.text) || '').trim() } };
  }
  if (m.task === 'translation') {
    const out = await pipe(m.text, m.options || {});
    const o = Array.isArray(out) ? out[0] : out;
    return { data: { text: String((o && o.translation_text) || '').trim() } };
  }
  if (m.task === 'text-to-speech') {
    const out = await pipe(m.text);
    return { data: { audio: out.audio, sampling_rate: out.sampling_rate }, transfer: [out.audio.buffer] };
  }
  throw new Error(`Unknown task: ${m.task}`);
}

async function handleDispose() {
  for (const p of pipes.values()) {
    try { if (p && p.dispose) await p.dispose(); } catch (_) { /* ignore */ }
  }
  pipes.clear();
  return { disposed: true };
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  const id = m.id;
  try {
    let res;
    if (m.type === 'load') res = { data: await handleLoad(id, m) };
    else if (m.type === 'run') res = await handleRun(m);
    else if (m.type === 'dispose') res = { data: await handleDispose() };
    else if (m.type === 'ping') res = { data: { pong: true } };
    else throw new Error(`Unknown request: ${m.type}`);
    self.postMessage({ type: 'result', id, data: res.data }, res.transfer || []);
  } catch (e) {
    let code = (e && e.code) || 'ENGINE_ERROR';
    let message = e && e.message ? String(e.message) : String(e);
    if (typeof e === 'number') { code = 'OOM'; message = 'WebAssembly memory error ' + e; }
    self.postMessage({ type: 'error', id, code, message });
  }
};
