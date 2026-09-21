/* CAC Goodworks Audio Translator — talks to ml-worker.js so heavy AI work never blocks the interface. */
import { AppError, abortError } from './errors.js';

/** Open-source runtime (Apache-2.0) that runs ONNX models in the browser. Pinned for reproducibility. */
export const LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

function mapWorkerError(m) {
  const code = m.code || 'ENGINE_ERROR';
  const msg = String(m.message || '');
  if (code === 'LIB_UNAVAILABLE') {
    return new AppError('LIB_UNAVAILABLE', 'The on-device AI engine could not be loaded.', {
      hint: 'Internet connection required for this processing method (needed once, then it works offline).',
    });
  }
  if (code === 'NETWORK' || /failed to fetch|networkerror|load failed|network request failed|could not locate file/i.test(msg)) {
    return new AppError('NETWORK', 'Internet connection required to download this model.', {
      hint: 'Connect to the internet once to download it. After that it works offline.',
    });
  }
  if (code === 'OOM' || /out of memory|allocation|bad_alloc|memory access out of bounds|aborted\(\)/i.test(msg)) {
    return new AppError('OOM', 'This device ran out of memory while running the model.', {
      hint: 'Close other apps or tabs, or choose a smaller model in AI Models.',
    });
  }
  return new AppError('ENGINE_ERROR', 'The on-device AI engine reported an error.', { hint: msg.slice(0, 240) });
}

export class WorkerClient {
  constructor(role) {
    this.role = role;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
  }

  get active() { return !!this.worker; }

  _spawn() {
    if (this.worker) return;
    if (typeof Worker === 'undefined') {
      throw new AppError('NO_WORKER', 'This browser cannot run background workers, so on-device AI models are unavailable.', { retryable: false });
    }
    let w;
    try {
      w = new Worker(new URL('./ml-worker.js', import.meta.url), { type: 'module', name: `cac-${this.role}` });
    } catch (e) {
      throw new AppError('NO_WORKER', 'This browser cannot start the AI worker (module workers are required).', { retryable: false, cause: e });
    }
    w.onmessage = (ev) => this._onMessage(ev.data || {});
    w.onerror = (ev) => {
      const detail = ev && ev.message ? ev.message : 'The worker script could not be started.';
      this._failAll(new AppError('WORKER_CRASH', 'The on-device AI engine stopped unexpectedly.', { hint: detail }));
      this._kill();
    };
    this.worker = w;
  }

  /** Sends a request. Resolves with the worker's result payload. */
  call(type, payload = {}, { onProgress, transfer, signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    this._spawn();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onProgress, signal, abortHandler: null };
      if (signal) {
        entry.abortHandler = () => this.terminate();
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }
      this.pending.set(id, entry);
      try {
        this.worker.postMessage({ id, type, libUrl: LIB_URL, ...payload }, transfer || []);
      } catch (e) {
        this._settle(id);
        reject(e);
      }
    });
  }

  _settle(id) {
    const e = this.pending.get(id);
    if (!e) return null;
    this.pending.delete(id);
    if (e.signal && e.abortHandler) e.signal.removeEventListener('abort', e.abortHandler);
    return e;
  }

  _onMessage(m) {
    if (m.type === 'progress') {
      const e = this.pending.get(m.id);
      if (e && e.onProgress) { try { e.onProgress(m); } catch (_) { /* ignore UI errors */ } }
      return;
    }
    const e = this._settle(m.id);
    if (!e) return;
    if (m.type === 'result') e.resolve(m.data);
    else e.reject(mapWorkerError(m));
  }

  _failAll(err) {
    for (const id of [...this.pending.keys()]) {
      const e = this._settle(id);
      if (e) e.reject(err);
    }
  }

  _kill() {
    if (this.worker) {
      try { this.worker.terminate(); } catch (_) { /* ignore */ }
      this.worker = null;
    }
  }

  /** Stops the worker immediately, cancelling anything in flight and freeing its memory. */
  terminate() {
    this._failAll(abortError());
    this._kill();
  }
}
