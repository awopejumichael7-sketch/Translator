/* CAC Goodworks Audio Translator — error helpers. */

export class AppError extends Error {
  /**
   * @param {string} code   machine-readable code, e.g. 'MIC_DENIED'
   * @param {string} message plain-language message shown to the user
   * @param {{hint?:string, retryable?:boolean, cause?:any}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = opts.hint || '';
    this.retryable = opts.retryable !== false;
    this.cause = opts.cause;
  }
}

export function abortError() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  e.code = 'ABORTED';
  return e;
}

export const isAbort = (e) => !!e && (e.name === 'AbortError' || e.code === 'ABORTED');

export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** Turns anything thrown into an AppError with a readable message. */
export function toAppError(e, fallback = 'Something went wrong.') {
  if (e instanceof AppError) return e;
  if (isAbort(e)) return new AppError('ABORTED', 'Cancelled.', { retryable: true });
  const msg = e && e.message ? String(e.message) : String(e || '');
  if (typeof e === 'number' || /out of memory|allocation failed|bad_alloc|memory access out of bounds/i.test(msg)) {
    return new AppError('OOM', 'This device ran out of memory.', {
      hint: 'Close other apps or tabs, or choose a smaller model in AI Models.',
      cause: e,
    });
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return new AppError('NETWORK', 'Internet connection required for this processing method.', { cause: e });
  }
  return new AppError('UNKNOWN', fallback, { hint: msg.slice(0, 240), cause: e });
}
