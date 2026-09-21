/* CAC Goodworks Audio Translator — helpers shared by the screens. */
import { LANGUAGES } from './languages.js';
import { getSettings, updateSettings, onSettings } from './settings.js';
import { $$, h, clear } from './ui.js';

/** Small event bus so screens can talk without importing each other. */
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

export const navigate = (route) => { location.hash = `#/${route}`; };

export const languageLabel = (l) => (l.native && l.native !== l.name ? `${l.name} (${l.native})` : l.name);

/** Fills every language menu, keeps them in sync with the settings, and wires the swap buttons. */
export function initLanguageControls() {
  const srcs = $$('.js-src');
  const tgts = $$('.js-tgt');
  for (const sel of [...srcs, ...tgts]) {
    clear(sel);
    for (const l of LANGUAGES) sel.append(h('option', { value: l.code, text: languageLabel(l) }));
  }
  const sync = (s) => { srcs.forEach((x) => { x.value = s.srcLang; }); tgts.forEach((x) => { x.value = s.tgtLang; }); };
  sync(getSettings());
  onSettings(sync);
  srcs.forEach((sel) => sel.addEventListener('change', () => {
    const s = getSettings();
    updateSettings(sel.value === s.tgtLang ? { srcLang: sel.value, tgtLang: s.srcLang } : { srcLang: sel.value });
  }));
  tgts.forEach((sel) => sel.addEventListener('change', () => {
    const s = getSettings();
    updateSettings(sel.value === s.srcLang ? { tgtLang: sel.value, srcLang: s.tgtLang } : { tgtLang: sel.value });
  }));
  $$('.js-swap').forEach((b) => b.addEventListener('click', () => {
    const s = getSettings();
    updateSettings({ srcLang: s.tgtLang, tgtLang: s.srcLang });
  }));
}
