/* CAC Goodworks Audio Translator — Settings screen. */
import { getSettings, updateSettings, resetSettings, onSettings, applyAppearance, APP_CONFIG } from './settings.js';
import { $, h, clear, toast, confirmDialog, choiceDialog } from './ui.js';
import { clearAllLocalData, persistenceState, requestPersistence } from './storage.js';
import { listVoices, voicesFor, voiceLabel, noVoiceMessage } from './tts.js';
import { ttsModelFor } from './models.js';
import { langName } from './languages.js';
import { emit } from './common.js';

let wired = false;

async function fillVoices() {
  const sel = $('#set-voice');
  const help = $('#set-voice-help');
  const s = getSettings();
  const voices = voicesFor(s.tgtLang, await listVoices());
  clear(sel);
  sel.append(h('option', { value: '', text: 'Automatic' }));
  for (const v of voices) sel.append(h('option', { value: v.voiceURI, text: voiceLabel(v) }));
  sel.value = voices.some((v) => v.voiceURI === s.voiceByLang[s.tgtLang]) ? s.voiceByLang[s.tgtLang] : '';
  sel.disabled = !voices.length;
  if (voices.length) help.textContent = `Browser voices found for ${langName(s.tgtLang)}: ${voices.length}.`;
  else if (ttsModelFor(s.tgtLang)) help.textContent = `No browser voice for ${langName(s.tgtLang)}. A downloadable voice is available in AI models.`;
  else help.textContent = noVoiceMessage(s.tgtLang);
}

function sync(s) {
  $('#set-theme').value = s.theme;
  $('#set-contrast').checked = s.highContrast;
  $('#set-largetext').checked = s.largeText;
  $('#set-uilang').value = s.uiLang;
  $('#set-speed').value = String(s.speed);
  $('#set-autodownload').value = s.autoDownload;
  $('#set-review').checked = s.reviewBeforeTranslate;
  $('#set-mt').value = s.mtEngine;
  $('#set-tts').value = s.ttsEngine;
  $('#set-online').checked = s.allowOnlineTranslation;
  $('#set-bible').checked = s.protectBibleRefs;
  $('#set-biblebooks').checked = s.translateBibleBooks;
  $('#set-terms').value = s.protectedTerms.join('\n');
  $('#set-savehistory').checked = s.saveHistory;
  $('#set-keepaudio').checked = s.keepAudioInHistory;
  $('#set-keeploaded').checked = s.keepModelsLoaded;
  $('#set-keepaudio').disabled = !s.saveHistory;
}

async function refreshPersist() {
  const p = await persistenceState();
  $('#persist-line').textContent = p === true ? 'The browser has agreed to keep this app’s data, including downloaded models.'
    : p === false ? 'The browser may clear this app’s data if the device runs low on space.'
      : 'This browser does not say whether it will keep the app’s data.';
}

async function enableOnline() {
  return confirmDialog({
    title: 'Use the online translation service?',
    message: 'When this is on and no on-device model is chosen, the text you translate is sent over the internet to MyMemory (a free service with a daily limit). Your audio is never sent. You can turn this off at any time.',
    confirmLabel: 'Allow online translation',
  });
}

export function initSettings() {
  if (wired) return;
  wired = true;

  if (!APP_CONFIG.enableOnlineTranslation) {
    $('#set-online').closest('label').hidden = true;
    const opt = $('#set-mt').querySelector('option[value="mymemory"]');
    if (opt) opt.remove();
  }

  const bindCheck = (id, key) => $(id).addEventListener('change', (e) => updateSettings({ [key]: e.target.checked }));
  const bindSelect = (id, key, conv = (v) => v) => $(id).addEventListener('change', (e) => updateSettings({ [key]: conv(e.target.value) }));

  bindSelect('#set-theme', 'theme');
  bindCheck('#set-contrast', 'highContrast');
  bindCheck('#set-largetext', 'largeText');
  bindSelect('#set-uilang', 'uiLang');
  bindSelect('#set-speed', 'speed', Number);
  bindSelect('#set-autodownload', 'autoDownload');
  bindCheck('#set-review', 'reviewBeforeTranslate');
  bindSelect('#set-tts', 'ttsEngine');
  bindCheck('#set-bible', 'protectBibleRefs');
  bindCheck('#set-biblebooks', 'translateBibleBooks');
  bindCheck('#set-savehistory', 'saveHistory');
  bindCheck('#set-keepaudio', 'keepAudioInHistory');
  bindCheck('#set-keeploaded', 'keepModelsLoaded');

  $('#set-mt').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v === 'mymemory' && !getSettings().allowOnlineTranslation) {
      if (!(await enableOnline())) { sync(getSettings()); return; }
      updateSettings({ mtEngine: v, allowOnlineTranslation: true });
      return;
    }
    updateSettings({ mtEngine: v });
  });

  $('#set-online').addEventListener('change', async (e) => {
    if (e.target.checked) {
      if (!(await enableOnline())) { e.target.checked = false; return; }
      updateSettings({ allowOnlineTranslation: true });
    } else {
      updateSettings({ allowOnlineTranslation: false, ...(getSettings().mtEngine === 'mymemory' ? { mtEngine: 'auto' } : {}) });
    }
  });

  $('#set-voice').addEventListener('change', (e) => {
    const s = getSettings();
    const map = { ...s.voiceByLang };
    if (e.target.value) map[s.tgtLang] = e.target.value; else delete map[s.tgtLang];
    updateSettings({ voiceByLang: map });
  });

  $('#set-terms-save').addEventListener('click', () => {
    const terms = $('#set-terms').value.split('\n').map((t) => t.trim()).filter(Boolean);
    updateSettings({ protectedTerms: terms });
    toast('Protected terms saved.', { kind: 'success' });
  });

  $('#btn-persist').addEventListener('click', async () => {
    const ok = await requestPersistence();
    toast(ok ? 'The browser will keep this app’s data.' : 'The browser did not agree. Installing the app can help.', { kind: ok ? 'success' : 'warn' });
    refreshPersist();
  });

  $('#btn-clear-all').addEventListener('click', async () => {
    const cb = h('input', { type: 'checkbox', id: 'clr-models' });
    const body = h('div', {},
      h('p', { text: 'This removes your history and any kept audio from this device. Your settings stay.' }),
      h('label', { class: 'check', for: 'clr-models' }, cb, h('span', { text: 'Also remove downloaded AI models (they would need to be downloaded again).' })),
    );
    const r = await choiceDialog({
      title: 'Clear all data?', body,
      actions: [{ label: 'Cancel', value: false, kind: 'ghost' }, { label: 'Clear data', value: true, kind: 'danger' }],
    });
    if (r !== true) return;
    await clearAllLocalData({ includeModels: cb.checked });
    if (cb.checked && typeof caches !== 'undefined') { try { await caches.delete('cac-goodworks-audio-translator-engine'); } catch (_) { /* ignore */ } }
    emit('data-cleared', { models: cb.checked });
    toast('Data cleared.', { kind: 'success' });
  });

  $('#btn-reset').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Reset settings?', message: 'All settings return to their defaults. History and downloaded models are not affected.', confirmLabel: 'Reset settings', danger: true }))) return;
    resetSettings();
    applyAppearance();
    toast('Settings reset.', { kind: 'success' });
  });

  $('#btn-check-update').addEventListener('click', () => emit('check-update'));
  $('#app-version').textContent = APP_CONFIG.version;

  onSettings((s, patch) => {
    sync(s);
    if (!patch || 'tgtLang' in patch || 'voiceByLang' in patch || Object.keys(patch).length === 0) fillVoices();
  });
  sync(getSettings());
  fillVoices();
  refreshPersist();
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', fillVoices);
}

export function renderSettings() {
  sync(getSettings());
  fillVoices();
  refreshPersist();
}
