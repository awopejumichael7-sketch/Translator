/* CAC Goodworks Audio Translator — audio input helpers.
 * File validation, decoding to 16 kHz mono (what Whisper needs), waveform peaks, chunking,
 * WAV encoding and the microphone recorder. Everything happens on the device.
 */
import { AppError, throwIfAborted } from './errors.js';
import { fileExt } from './util.js';

export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'];
export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', '3gp'];
export const ACCEPT = [...AUDIO_EXTS, ...VIDEO_EXTS].map((e) => `.${e}`).join(',') + ',audio/*,video/*';
export const MAX_FILE_BYTES = 300 * 1024 * 1024;
export const TARGET_RATE = 16000;

const OK_TYPES = /^(audio|video)\//;
const OK_OTHER_TYPES = new Set(['', 'application/ogg', 'application/octet-stream', 'application/x-matroska']);

/** Throws an AppError when a file should not be processed. */
export function validateFile(file) {
  if (!file || typeof file.size !== 'number') {
    throw new AppError('BAD_FILE', 'That is not a valid file.', { retryable: false });
  }
  if (file.size === 0) {
    throw new AppError('EMPTY_FILE', 'This file is empty.', { hint: 'Choose a different audio or video file.', retryable: false });
  }
  const ext = fileExt(file.name);
  const type = String(file.type || '').toLowerCase();
  const knownExt = AUDIO_EXTS.includes(ext) || VIDEO_EXTS.includes(ext);
  const knownType = OK_TYPES.test(type);
  const okOther = OK_OTHER_TYPES.has(type);
  const supported = ext ? knownExt && (knownType || okOther) : knownType;
  if (!supported) {
    throw new AppError('UNSUPPORTED', 'Unsupported audio format.', {
      hint: 'Use MP3, WAV, M4A, AAC, OGG, OPUS, FLAC, MP4, WEBM or MKV.',
      retryable: false,
    });
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AppError('TOO_LARGE', 'This file is too large to process on this device.', {
      hint: 'The limit is 300 MB. Trim the file or save it at a lower quality, then try again.',
      retryable: false,
    });
  }
}

export function isVideoFile(file) {
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('video/')) return true;
  if (type.startsWith('audio/')) return false;
  return VIDEO_EXTS.includes(fileExt(file.name)) && fileExt(file.name) !== 'webm';
}

/** Reads duration and whether a picture track exists, using the browser's own media element. */
export function probeMedia(blob, { video = false } = {}) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement(video ? 'video' : 'audio');
    el.preload = 'metadata';
    el.muted = true;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      try { el.load(); } catch (_) { /* ignore */ }
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ duration: NaN, hasVideo: false, playable: false }), 8000);
    el.onloadedmetadata = () => finish({
      duration: Number.isFinite(el.duration) ? el.duration : NaN,
      hasVideo: !!el.videoWidth,
      playable: true,
    });
    el.onerror = () => finish({ duration: NaN, hasVideo: false, playable: false });
    el.src = url;
  });
}

function decodeError(e, isVideo) {
  const name = e && e.name;
  const msg = e && e.message ? String(e.message) : '';
  if (e instanceof RangeError || /allocation|out of memory|too large/i.test(msg)) {
    return new AppError('TOO_LARGE', 'This audio is too large for this device to process.', {
      hint: 'Try a shorter file, or close other apps and tabs.',
      cause: e,
    });
  }
  if (isVideo) {
    return new AppError('DECODE', 'This video format is not supported by your browser, or it has no readable audio track.', {
      hint: 'Some video formats may require conversion. MP4 (H.264 + AAC) or WEBM usually works, or save the audio as MP3.',
      cause: e,
      retryable: false,
    });
  }
  if (name === 'EncodingError' || name === 'NotSupportedError' || !name || /decode|unable|format/i.test(msg)) {
    return new AppError('DECODE', 'Your browser cannot decode this audio format.', {
      hint: 'Convert the file to MP3, WAV or M4A and try again.',
      cause: e,
      retryable: false,
    });
  }
  return new AppError('DECODE', 'The audio could not be read.', { hint: msg.slice(0, 200), cause: e });
}

async function resampleMono(samples, fromRate) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const length = Math.max(1, Math.ceil((samples.length * TARGET_RATE) / fromRate));
  const ctx = new OAC(1, length, TARGET_RATE);
  const buf = ctx.createBuffer(1, samples.length, fromRate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0).slice();
}

/**
 * Decodes an audio or video file to mono Float32 samples at 16 kHz.
 * Nothing is uploaded; the browser's own decoder does the work.
 */
export async function decodeToMono16k(blob, { signal, video = false } = {}) {
  throwIfAborted(signal);
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    throw new AppError('NO_AUDIO_API', 'This browser cannot process audio.', { retryable: false, hint: 'Try a current version of Chrome, Edge, Firefox or Safari.' });
  }
  let bytes;
  try { bytes = await blob.arrayBuffer(); } catch (e) { throw decodeError(e, video); }
  throwIfAborted(signal);
  let ctx;
  try { ctx = new AC({ sampleRate: TARGET_RATE }); } catch (_) { ctx = new AC(); }
  let decoded;
  try {
    decoded = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.catch === 'function') p.catch(reject);
    });
  } catch (e) {
    throw decodeError(e, video);
  } finally {
    try { if (ctx.close) ctx.close(); } catch (_) { /* ignore */ }
  }
  throwIfAborted(signal);
  if (!decoded || decoded.length === 0) {
    throw new AppError('NO_AUDIO', 'No audio was found in this file.', { retryable: false });
  }
  const channels = decoded.numberOfChannels;
  let mono;
  try {
    mono = new Float32Array(decoded.length);
    for (let c = 0; c < channels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels;
    }
    if (decoded.sampleRate !== TARGET_RATE) mono = await resampleMono(mono, decoded.sampleRate);
  } catch (e) {
    throw decodeError(e, video);
  }
  return { samples: mono, sampleRate: TARGET_RATE, duration: mono.length / TARGET_RATE };
}

/** Peak envelope (0..1) with `n` buckets — used to draw the waveform. */
export function computePeaks(samples, n = 900) {
  const out = new Float32Array(n);
  if (!samples || !samples.length) return out;
  const step = samples.length / n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * step);
    const e = Math.max(s + 1, Math.min(samples.length, Math.floor((i + 1) * step)));
    let p = 0;
    for (let j = s; j < e; j++) {
      const a = samples[j] < 0 ? -samples[j] : samples[j];
      if (a > p) p = a;
    }
    out[i] = p;
    if (p > max) max = p;
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

export function rms(samples, start = 0, end = samples.length) {
  let sum = 0;
  let n = 0;
  for (let i = start; i < end; i += 4) { sum += samples[i] * samples[i]; n++; }
  return n ? Math.sqrt(sum / n) : 0;
}

/**
 * Splits long audio into pieces of at most `target` seconds, cutting at the quietest moment
 * in the last `search` seconds so words are not chopped in half.
 */
export function splitChunks(samples, sr = TARGET_RATE, target = 30, search = 2) {
  const total = samples.length;
  const size = Math.floor(target * sr);
  const frame = Math.floor(0.1 * sr);
  const out = [];
  let start = 0;
  while (start < total) {
    let end = start + size;
    if (end >= total) {
      end = total;
    } else {
      const lo = Math.max(start + Math.floor(size / 2), end - Math.floor(search * sr));
      let best = end;
      let bestE = Infinity;
      for (let p = lo; p + frame <= end; p += frame) {
        let e = 0;
        for (let k = p; k < p + frame; k += 8) e += samples[k] * samples[k];
        if (e < bestE) { bestE = e; best = p + (frame >> 1); }
      }
      end = Math.min(best, end);
    }
    out.push({ start, end });
    start = end;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ---------------- Microphone recorder ---------------- */

const REC_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

export function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
}

export async function micPermission() {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const r = await navigator.permissions.query({ name: 'microphone' });
      return r.state; // 'granted' | 'denied' | 'prompt'
    }
  } catch (_) { /* not supported */ }
  return 'unknown';
}

function micError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new AppError('MIC_DENIED', 'Microphone permission was denied.', {
      hint: 'Allow microphone access for this site in your browser settings, then try again.',
    });
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new AppError('MIC_NONE', 'No microphone was found on this device.', { hint: 'Connect a microphone and try again.' });
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new AppError('MIC_BUSY', 'The microphone is being used by another app.', { hint: 'Close the other app and try again.' });
  }
  return new AppError('MIC_ERROR', 'The microphone could not be started.', { hint: e && e.message ? String(e.message).slice(0, 160) : '', cause: e });
}

/** Records from the microphone with pause / resume, a running timer and a live level meter. */
export class Recorder extends EventTarget {
  constructor() {
    super();
    this.state = 'idle'; // idle | recording | paused | stopped
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.mime = '';
    this.elapsed = 0;
    this._t0 = 0;
    this._timer = 0;
    this._raf = 0;
    this._ctx = null;
    this._analyser = null;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _setState(s) { this.state = s; this._emit('state', s); }

  async start() {
    if (!recordingSupported()) {
      throw new AppError('MIC_UNSUPPORTED', 'Recording is not supported in this browser.', { retryable: false, hint: 'Upload a recorded file instead.' });
    }
    if (!window.isSecureContext) {
      throw new AppError('MIC_INSECURE', 'Recording needs a secure (https) connection.', { retryable: false, hint: 'Open the app from its https address, or upload a file instead.' });
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      throw micError(e);
    }
    this.mime = REC_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    try {
      this.rec = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream);
    } catch (e) {
      this._release();
      throw micError(e);
    }
    this.chunks = [];
    this.elapsed = 0;
    this.rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) this.chunks.push(ev.data); };
    this.rec.onerror = () => { this._emit('error', new AppError('MIC_ERROR', 'Recording stopped unexpectedly.')); this._cleanupTimers(); };
    this.rec.start(1000);
    this._t0 = performance.now();
    this._setState('recording');
    this._startMeter();
    this._timer = setInterval(() => this._emit('tick', this.seconds()), 250);
  }

  seconds() {
    return this.elapsed + (this.state === 'recording' ? (performance.now() - this._t0) / 1000 : 0);
  }

  pause() {
    if (this.state !== 'recording') return;
    this.elapsed += (performance.now() - this._t0) / 1000;
    try { this.rec.pause(); } catch (_) { /* ignore */ }
    this._setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this._t0 = performance.now();
    try { this.rec.resume(); } catch (_) { /* ignore */ }
    this._setState('recording');
  }

  /** Stops and resolves with { blob, seconds, mime }. */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.rec || (this.state !== 'recording' && this.state !== 'paused')) { reject(new AppError('NOT_RECORDING', 'Nothing is being recorded.')); return; }
      const total = this.seconds();
      this.rec.onstop = () => {
        const type = (this.rec && this.rec.mimeType) || this.mime || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this._cleanupTimers();
        this._release();
        this._setState('stopped');
        if (!blob.size) reject(new AppError('EMPTY_RECORDING', 'The recording is empty.', { hint: 'Check your microphone and try again.' }));
        else resolve({ blob, seconds: total, mime: type });
      };
      try { this.rec.stop(); } catch (e) { reject(micError(e)); }
    });
  }

  /** Abandons the recording and releases the microphone. */
  cancel() {
    try { if (this.rec && this.rec.state !== 'inactive') { this.rec.onstop = null; this.rec.stop(); } } catch (_) { /* ignore */ }
    this._cleanupTimers();
    this._release();
    this.chunks = [];
    this.elapsed = 0;
    this._setState('idle');
  }

  _startMeter() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._ctx = new AC();
      const src = this._ctx.createMediaStreamSource(this.stream);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 512;
      src.connect(this._analyser);
      const data = new Uint8Array(this._analyser.fftSize);
      const loop = () => {
        if (!this._analyser) return;
        this._analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i] - 128) / 128; if (a > peak) peak = a; }
        this._emit('level', this.state === 'recording' ? Math.min(1, peak * 1.6) : 0);
        this._raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (_) { /* the meter is optional */ }
  }

  _cleanupTimers() {
    clearInterval(this._timer);
    cancelAnimationFrame(this._raf);
    this._analyser = null;
    if (this._ctx) { try { this._ctx.close(); } catch (_) { /* ignore */ } this._ctx = null; }
    this._emit('level', 0);
  }

  _release() {
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  }
}

export function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  return 'webm';
}
