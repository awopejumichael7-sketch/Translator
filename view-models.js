/* CAC Goodworks Audio Translator — AI models screen.
 * Shows what is on the device, how big each model is before it downloads, and lets the person
 * download, cancel or remove models. Status always comes from the real cache, never a guess.
 */
import { LANGUAGES } from './languages.js';
import { isAbort, toAppError } from './errors.js';
import { formatBytes, formatMB } from './util.js';
import { $, h, icon, clear, toast, confirmDialog, progressBar } from './ui.js';
import { ASR_MODELS, MT_MODELS, TTS_MODELS, readyMap, downloadModel, removeModel, localEngineSupported } from './models.js';
import { estimateStorage } from './storage.js';
import { listVoices, voicesFor, browserSpeechSupported } from './tts.js';

const active = new Map(); // model id -> { ctrl, pct }
let ready = new Set();
let rendering = false;

const GROUPS = [
  { title: 'Speech recognition', blurb: 'Turns spoken audio into text. English models are smaller and more accurate for English.', models: ASR_MODELS },
  { title: 'Translation', blurb: 'Translates the text. The large model covers every language here, including Yoruba, Hausa and Igbo.', models: MT_MODELS },
  { title: 'Voices', blurb: 'Speak the translation and create a downloadable audio file. Languages without an entry have no downloadable voice.', models: TTS_MODELS },
];

function chip(kind, text, iconName) {
  return h('span', { class: `chip chip-${kind}` }, iconName ? icon(iconName) : null, text);
}

function statusChip(m) {
  const a = active.get(m.id);
  if (a) return chip('busy', a.pct == null ? 'Downloading…' : `Downloading ${Math.round(a.pct)}%`);
  if (ready.has(m.id)) return chip('ready', 'On this device', 'check');
  if (!localEngineSupported()) return chip('off', 'Unavailable in this browser');
  return chip('off', 'Not downloaded');
}

async function startDownload(m) {
  if (!navigator.onLine) { toast('Internet connection required to download this model.', { kind: 'warn' }); return; }
  const parts = [`${m.label} is about ${formatMB(m.sizeMB)}. It downloads once and then works offline.`];
  if (m.minRamGB) parts.push(`It needs a device with about ${m.minRamGB} GB of memory or more.`);
  if (/NC/.test(m.license)) parts.push('This model is licensed for non-commercial use only.');
  const ok = await confirmDialog({ title: 'Download this model?', message: parts.join(' '), confirmLabel: `Download ${formatMB(m.sizeMB)}` });
  if (!ok) return;
  const ctrl = new AbortController();
  active.set(m.id, { ctrl, pct: null });
  render();
  try {
    await downloadModel(m, {
      signal: ctrl.signal,
      onProgress: (p) => { const a = active.get(m.id); if (a) { a.pct = p.total ? (p.loaded / p.total) * 100 : null; paintProgress(m.id); } },
    });
    toast(`${m.label} is ready.`, { kind: 'success' });
  } catch (e) {
    if (isAbort(e)) toast('Download cancelled.');
    else { const err = toAppError(e); toast(`${err.message} ${err.hint}`.trim(), { kind: 'error' }); }
  } finally {
    active.delete(m.id);
    ready = await readyMap();
    render();
  }
}

async function remove(m) {
  const ok = await confirmDialog({ title: 'Remove this model?', message: `${m.label} will be deleted from this device. You can download it again later.`, confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  await removeModel(m);
  ready = await readyMap();
  toast('Removed.', { kind: 'success' });
  render();
}

const bars = new Map();
function paintProgress(id) {
  const b = bars.get(id);
  const a = active.get(id);
  if (b && a) b.set(a.pct);
  const c = document.querySelector(`[data-model-chip="${CSS.escape(id)}"]`);
  if (c && a) c.replaceChildren(a.pct == null ? 'Downloading…' : `Downloading ${Math.round(a.pct)}%`);
}

function rowFor(m) {
  const a = active.get(m.id);
  const isReady = ready.has(m.id);
  const supported = localEngineSupported();
  const offline = !navigator.onLine;
  const facts = [
    h('span', { text: `Size: about ${formatMB(m.sizeMB)}` }),
    h('span', { text: `Licence: ${m.license}` }),
  ];
  if (m.minRamGB) facts.push(h('span', { text: `Memory: ${m.minRamGB} GB or more` }));
  const actions = [];
  if (a) {
    actions.push(h('button', { class: 'btn btn-small', type: 'button', onclick: () => a.ctrl.abort() }, 'Cancel'));
  } else if (isReady) {
    actions.push(h('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: () => remove(m), 'aria-label': `Remove ${m.label}` }, icon('trash'), 'Remove'));
  } else if (supported) {
    actions.push(h('button', {
      class: 'btn btn-small btn-primary', type: 'button', disabled: offline, onclick: () => startDownload(m), 'aria-label': `Download ${m.label}, about ${formatMB(m.sizeMB)}`,
    }, icon('download'), `Download ${formatMB(m.sizeMB)}`));
    if (offline) actions.push(h('span', { class: 'hint', text: 'Internet connection required.' }));
  }
  let barEl = null;
  if (a) { const b = progressBar(`Downloading ${m.label}`); b.set(a.pct); bars.set(m.id, b); barEl = b.el; }
  const chipEl = statusChip(m);
  chipEl.dataset.modelChip = m.id;
  return h('div', { class: 'model-row' },
    h('div', { class: 'model-top' }, h('span', { class: 'model-name', text: m.label }), chipEl),
    h('p', { class: 'model-desc', text: m.desc }),
    h('div', { class: 'model-facts' }, facts),
    barEl,
    actions.length ? h('div', { class: 'btn-row' }, actions) : null,
  );
}

async function renderStorage() {
  const est = await estimateStorage();
  const line = $('#storage-summary');
  const fill = $('#storage-fill');
  const bar = $('#storage-bar');
  if (!est || !est.quota) { line.textContent = 'The browser does not report storage use.'; fill.style.width = '0%'; return; }
  const pct = Math.min(100, (est.usage / est.quota) * 100);
  line.textContent = `${formatBytes(est.usage)} used of about ${formatBytes(est.quota)} available`;
  fill.style.width = `${Math.max(pct, 0.5)}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
}

async function renderEngines() {
  const list = $('#engines-list');
  clear(list);
  const voices = await listVoices();
  const withVoice = LANGUAGES.filter((l) => voicesFor(l.code, voices).length).map((l) => l.name);
  const mem = typeof navigator.deviceMemory === 'number' ? `About ${navigator.deviceMemory} GB or more (browser estimate)` : 'Not reported by this browser';
  const rows = [
    ['On-device AI engine', localEngineSupported() ? 'Supported' : 'Not supported in this browser'],
    ['Built-in browser translator', 'Translator' in self ? 'Present (covers only a limited set of languages)' : 'Not present in this browser'],
    ['Browser voices', !browserSpeechSupported() ? 'Not supported' : withVoice.length ? `Found for: ${withVoice.join(', ')}` : 'None found for this app’s languages'],
    ['Device memory', mem],
  ];
  for (const [k, v] of rows) list.append(h('li', {}, h('strong', { text: k }), h('span', { text: v })));
}

export async function render() {
  if (rendering) { setTimeout(render, 60); return; }
  rendering = true;
  try {
    const host = $('#models-list');
    bars.clear();
    clear(host);
    for (const g of GROUPS) {
      host.append(h('section', { class: 'model-group' },
        h('h2', { text: g.title }),
        h('p', { text: g.blurb }),
        h('div', { class: 'model-list' }, g.models.map(rowFor)),
      ));
    }
    if (!localEngineSupported()) {
      host.prepend(h('div', { class: 'notice', text: 'This browser cannot run on-device AI models. Try a current version of Chrome, Edge, Firefox or Safari.' }));
    }
  } finally {
    rendering = false;
  }
}

export async function renderModels() {
  try { ready = await readyMap(); } catch (_) { ready = new Set(); }
  await render();
  renderStorage();
  renderEngines();
}

export function initModels() {
  window.addEventListener('online', () => { if (location.hash === '#/models') render(); });
  window.addEventListener('offline', () => { if (location.hash === '#/models') render(); });
}
