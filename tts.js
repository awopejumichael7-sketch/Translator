/* CAC Goodworks Audio Translator — text to speech.
 *
 *  • Browser voices (Web Speech API): free, instant, but the browser cannot save them as a file.
 *  • Local voices (Meta MMS-TTS, on the device): produce a downloadable WAV file. One-time download.
 *
 * If neither is available for a language the app says so plainly — it never pretends.
 */
import { AppError, throwIfAborted } from './errors.js';
import { langName } from './languages.js';
import { ttsModelFor, loadInto, localEngineSupported } from './models.js';
import { encodeWav } from './audio.js';

/* ---------------- Browser voices ---------------- */

export const browserSpeechSupported = () =>
  typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

let voiceCache = null;
let waited = false; // after one full wait, later calls answer straight away with whatever the browser has

/** Resolves with the browser's voices (some browsers fill the list a moment after load). */
export function listVoices() {
  if (!browserSpeechSupported()) return Promise.resolve([]);
  if (voiceCache && voiceCache.length) return Promise.resolve(voiceCache);
  if (waited) {
    const now = window.speechSynthesis.getVoices();
    if (now && now.length) voiceCache = now;
    return Promise.resolve(voiceCache || []);
  }
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const take = () => { const v = synth.getVoices(); if (v && v.length) { voiceCache = v; return true; } return false; };
    if (take()) { resolve(voiceCache); return; }
    const done = () => { waited = true; synth.removeEventListener('voiceschanged', onChange); clearTimeout(timer); resolve(take() ? voiceCache : []); };
    const onChange = () => { if (take()) done(); };
    const timer = setTimeout(done, 1500);
    synth.addEventListener('voiceschanged', onChange);
  });
}

const primary = (tag) => String(tag || '').replace('_', '-').toLowerCase().split('-')[0];

export function voicesFor(langCode, voices) {
  const code = primary(langCode);
  return (voices || []).filter((v) => primary(v.lang) === code);
}

/** Only says "female"/"male" when the voice's own name says so; browsers do not expose gender. */
export function voiceLabel(v) {
  const g = /\bfemale\b/i.test(v.name) ? ' (female)' : /\bmale\b/i.test(v.name) ? ' (male)' : '';
  return `${v.name}${g} — ${v.lang}${v.localService ? ' — works offline' : ' — needs internet'}`;
}

export function pickVoice(langCode, voices, savedUri) {
  const list = voicesFor(langCode, voices);
  return list.find((v) => v.voiceURI === savedUri) || list.find((v) => v.default) || list.find((v) => v.localService) || list[0] || null;
}

export function noVoiceMessage(langCode) {
  return `${langName(langCode)} voice is not available on this device/browser. Please select another available voice or use an installed ${langName(langCode)} TTS engine.`;
}

/* ---------------- Planning ---------------- */

/**
 * Decides how the translation will be spoken.
 * Returns { engine: 'browser' | 'local' | 'none', voices, model, needs, reason }.
 */
export async function planSpeech(tgt, settings, ready) {
  const voices = voicesFor(tgt, await listVoices());
  const model = ttsModelFor(tgt);
  const localOk = !!model && localEngineSupported();
  const browser = voices.length ? { engine: 'browser', voices, model: null, needs: [] } : null;
  const local = localOk ? { engine: 'local', voices, model, needs: ready.has(model.id) ? [] : [model] } : null;
  const none = { engine: 'none', voices: [], model: null, needs: [], reason: noVoiceMessage(tgt) };
  if (settings.ttsEngine === 'browser') return browser || none;
  if (settings.ttsEngine === 'local') return local || none;
  if (local && !local.needs.length) return local;
  return browser || local || none;
}

/* ---------------- Text chunking ---------------- */

export function splitForSpeech(text, max = 180) {
  const sentences = String(text || '').replace(/\s*\n+\s*/g, '. ').match(/[^.!?…]+[.!?…]*/g) || [];
  const out = [];
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    while (s.length > max) {
      let cut = Math.max(s.lastIndexOf(',', max), s.lastIndexOf(' ', max));
      if (cut < max / 2) cut = max;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).replace(/^[,\s]+/, '');
    }
    if (s) out.push(s);
  }
  return out;
}

/* ---------------- Local voice generation ---------------- */

/**
 * Speaks `text` with a local MMS voice and returns { blob, samples, sampleRate, duration }.
 * The model is loaded (and downloaded if needed) into the given worker client first.
 */
export async function generateLocalAudio(client, model, text, { signal, onProgress } = {}) {
  await loadInto(client, model, {
    signal,
    onProgress: (p) => onProgress && onProgress(p.total ? (p.loaded / p.total) * 0.5 : null, `Downloading ${model.label}…`, true),
  });
  const chunks = splitForSpeech(text, 200);
  if (!chunks.length) throw new AppError('NO_TEXT', 'There is no text to speak.', { retryable: false });
  const pieces = [];
  let rate = 16000;
  let length = 0;
  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(signal);
    const out = await client.call('run', { task: model.task, model: model.id, text: chunks[i] }, { signal });
    rate = out.sampling_rate || rate;
    pieces.push(out.audio);
    length += out.audio.length + Math.round(rate * 0.25);
    if (onProgress) onProgress(0.5 + ((i + 1) / chunks.length) * 0.5, `Creating audio… ${i + 1} of ${chunks.length}`, false);
  }
  const samples = new Float32Array(length);
  let o = 0;
  for (const p of pieces) { samples.set(p, o); o += p.length + Math.round(rate * 0.25); }
  return { blob: encodeWav(samples, rate), samples, sampleRate: rate, duration: samples.length / rate };
}

/* ---------------- Player used for the translated voice ---------------- */

/**
 * Same interface as MediaAdapter (see player.js): play, pause, stop, seek, setRate, setVolume, setMuted,
 * and 'state' / 'time' events. Works with a generated audio file ("blob") or a browser voice ("browser").
 */
export class TtsPlayer extends EventTarget {
  constructor() {
    super();
    this.mode = null;
    this.state = 'idle';
    this.rate = 1;
    this.volume = 1;
    this.muted = false;
    this.audio = null;
    this.url = '';
    this.chunks = [];
    this.idx = 0;
    this.voice = null;
    this.lang = 'en';
    this._token = 0;
  }

  get canSeek() { return this.mode === 'blob'; }
  get ready() { return this.mode === 'blob' ? !!this.audio : this.chunks.length > 0; }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _setState(s) { this.state = s; this._emit('state', s); }

  _drop() {
    this._token++;
    if (browserSpeechSupported()) window.speechSynthesis.cancel();
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); this.audio = null; }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = ''; }
    this.chunks = [];
    this.idx = 0;
    this.mode = null;
  }

  loadBlob(blob) {
    this._drop();
    this.mode = 'blob';
    this.url = URL.createObjectURL(blob);
    const a = new Audio(this.url);
    a.preload = 'auto';
    a.playbackRate = this.rate;
    a.volume = this.volume;
    a.muted = this.muted;
    a.onplay = () => this._setState('playing');
    a.onpause = () => { if (!a.ended) this._setState(a.currentTime > 0 ? 'paused' : 'idle'); };
    a.onended = () => this._setState('ended');
    a.onerror = () => this._emit('error', new AppError('PLAYBACK', 'The translated audio could not be played.'));
    a.ontimeupdate = () => this._emit('time', { t: a.currentTime, d: a.duration, p: a.duration ? a.currentTime / a.duration : 0 });
    a.onloadedmetadata = () => this._emit('time', { t: 0, d: a.duration, p: 0 });
    this.audio = a;
    this._setState('idle');
  }

  loadBrowser({ text, lang, voice }) {
    this._drop();
    this.mode = 'browser';
    this.chunks = splitForSpeech(text);
    this.lang = lang;
    this.voice = voice || null;
    this._setState('idle');
  }

  setVoice(voice) { this.voice = voice || null; }

  _speakFrom(i) {
    const synth = window.speechSynthesis;
    synth.cancel();
    const token = ++this._token;
    this.idx = i;
    const next = () => {
      if (token !== this._token) return;
      if (this.idx >= this.chunks.length) {
        this.idx = 0;
        this._emit('time', { t: null, d: null, p: 1 });
        this._setState('ended');
        return;
      }
      const u = new SpeechSynthesisUtterance(this.chunks[this.idx]);
      u.lang = (this.voice && this.voice.lang) || this.lang;
      if (this.voice) u.voice = this.voice;
      u.rate = this.rate;
      u.volume = this.muted ? 0 : this.volume;
      u.onend = () => {
        if (token !== this._token) return;
        this.idx++;
        this._emit('time', { t: null, d: null, p: this.idx / this.chunks.length });
        next();
      };
      u.onerror = (ev) => {
        if (token !== this._token) return;
        if (ev.error === 'canceled' || ev.error === 'interrupted') return;
        this._token++;
        this._setState('idle');
        this._emit('error', new AppError('PLAYBACK', 'The browser voice could not speak this text.', { hint: String(ev.error || '') }));
      };
      synth.speak(u);
    };
    this._setState('playing');
    setTimeout(next, 30); // some browsers need a moment after cancel()
  }

  play() {
    if (!this.ready) return;
    if (this.mode === 'blob') { this.audio.play().catch(() => this._emit('error', new AppError('PLAYBACK', 'The translated audio could not be played.'))); return; }
    this._speakFrom(this.state === 'paused' ? this.idx : 0);
  }

  /** Browser voices pause at the start of the current sentence (works the same on every browser). */
  pause() {
    if (this.mode === 'blob') { if (this.audio) this.audio.pause(); return; }
    if (this.state !== 'playing') return;
    this._token++;
    window.speechSynthesis.cancel();
    this._setState('paused');
  }

  stop() {
    if (this.mode === 'blob') { if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; } this._setState('idle'); return; }
    if (this.mode === 'browser') {
      this._token++;
      window.speechSynthesis.cancel();
      this.idx = 0;
      this._emit('time', { t: null, d: null, p: 0 });
      this._setState('idle');
    }
  }

  seek(t) { if (this.mode === 'blob' && this.audio && Number.isFinite(t)) this.audio.currentTime = Math.max(0, t); }
  getTime() { return this.audio ? this.audio.currentTime : 0; }
  getDuration() { return this.audio && Number.isFinite(this.audio.duration) ? this.audio.duration : NaN; }

  setRate(r) {
    this.rate = r;
    if (this.audio) this.audio.playbackRate = r;
    if (this.mode === 'browser' && this.state === 'playing') this._speakFrom(this.idx);
  }

  setVolume(v) {
    this.volume = v;
    if (this.audio) this.audio.volume = v;
    if (this.mode === 'browser' && this.state === 'playing') this._speakFrom(this.idx);
  }

  setMuted(m) {
    this.muted = m;
    if (this.audio) this.audio.muted = m;
    if (this.mode === 'browser' && this.state === 'playing') this._speakFrom(this.idx);
  }

  dispose() { this._drop(); this._setState('idle'); }
}
