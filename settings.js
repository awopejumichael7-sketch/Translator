/* CAC Goodworks Audio Translator — app configuration + user settings (kept in localStorage on this device). */

export const APP_CONFIG = {
  name: 'CAC Goodworks Audio Translator',
  shortName: 'CAC Audio Translator',
  org: 'CAC Goodworks Assembly',
  version: '1.0.2', // keep in sync with VERSION in service-worker.js
  purpose: 'To help users listen to and understand spoken content across languages.',
  /* Contact details are shown on the About page. Fill these in before publishing.
     Empty values are hidden — nothing is invented. */
  contact: { email: '', phone: '', website: '', address: '' },
  /* Set to false to remove the optional online translation service (MyMemory) from the app completely. */
  enableOnlineTranslation: true,
};

const KEY = 'cac-goodworks-audio-translator.settings.v1';

export const DEFAULTS = Object.freeze({
  theme: 'system',            // 'light' | 'dark' | 'system'
  highContrast: false,
  largeText: false,
  uiLang: 'en',
  srcLang: 'en',
  tgtLang: 'yo',
  voiceByLang: {},            // { yo: 'voiceURI', ... }
  speed: 1,
  autoDownload: 'off',        // 'off' | 'text' | 'text-audio'
  reviewBeforeTranslate: false,
  keepModelsLoaded: false,    // false = free model memory after every job
  keepAudioInHistory: false,  // false = history keeps text only
  saveHistory: true,          // keep a text-only history of recent jobs on this device
  allowOnlineTranslation: false,
  mtEngine: 'auto',           // 'auto' | 'chrome' | 'opus' | 'nllb' | 'mymemory'
  ttsEngine: 'auto',          // 'auto' | 'browser' | 'local'
  asrModelEn: 'Xenova/whisper-base.en',
  asrModelMulti: 'Xenova/whisper-base',
  protectedTerms: ['CAC Goodworks Assembly', 'CAC', 'Goodworks'],
  protectBibleRefs: true,
  translateBibleBooks: false, // false = "John 3:16" stays exactly as written
});

const ENUMS = {
  theme: ['light', 'dark', 'system'],
  autoDownload: ['off', 'text', 'text-audio'],
  mtEngine: ['auto', 'chrome', 'opus', 'nllb', 'mymemory'],
  ttsEngine: ['auto', 'browser', 'local'],
  uiLang: ['en'],
};
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function sanitize(raw) {
  const out = { ...DEFAULTS, voiceByLang: {}, protectedTerms: [...DEFAULTS.protectedTerms] };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in raw)) continue;
    const v = raw[k];
    const d = DEFAULTS[k];
    if (typeof d === 'boolean') { if (typeof v === 'boolean') out[k] = v; continue; }
    if (k === 'speed') { if (SPEEDS.includes(Number(v))) out[k] = Number(v); continue; }
    if (k === 'voiceByLang') {
      if (v && typeof v === 'object') for (const [a, b] of Object.entries(v)) if (typeof b === 'string') out.voiceByLang[String(a).slice(0, 12)] = b.slice(0, 300);
      continue;
    }
    if (k === 'protectedTerms') {
      if (Array.isArray(v)) out.protectedTerms = v.map((t) => String(t).trim()).filter(Boolean).slice(0, 200);
      continue;
    }
    if (ENUMS[k]) { if (ENUMS[k].includes(v)) out[k] = v; continue; }
    if (typeof d === 'string' && typeof v === 'string') out[k] = v.slice(0, 120);
  }
  return out;
}

let current = sanitize(null);
const subscribers = new Set();

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    current = sanitize(raw ? JSON.parse(raw) : null);
  } catch (_) {
    current = sanitize(null);
  }
  return current;
}

export const getSettings = () => current;

export function updateSettings(patch) {
  current = sanitize({ ...current, ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (_) { /* storage may be blocked */ }
  subscribers.forEach((fn) => { try { fn(current, patch); } catch (_) { /* ignore */ } });
  return current;
}

export function resetSettings() {
  try { localStorage.removeItem(KEY); } catch (_) { /* ignore */ }
  current = sanitize(null);
  subscribers.forEach((fn) => { try { fn(current, {}); } catch (_) { /* ignore */ } });
  return current;
}

export function onSettings(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Applies theme / contrast / text size to <html>. Safe to call any time. */
export function applyAppearance(s = current) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.contrast = s.highContrast ? 'high' : 'normal';
  root.dataset.textsize = s.largeText ? 'large' : 'normal';
  const dark = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#08150f' : '#0b5d3b');
}
