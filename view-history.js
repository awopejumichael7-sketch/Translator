/* CAC Goodworks Audio Translator — History screen (text-only by default, stored on this device). */
import { langName } from './languages.js';
import { formatDuration } from './util.js';
import { $, h, icon, clear, toast, confirmDialog } from './ui.js';
import { listJobs, deleteJob, clearJobs, historyAvailable } from './storage.js';
import { openFromHistory } from './view-translate.js';

let wired = false;

function titleOf(rec) {
  if (rec.kind === 'text') return (rec.transcript || 'Typed text').replace(/\s+/g, ' ').slice(0, 60);
  return rec.fileName || 'Recording';
}

function itemFor(rec) {
  const when = new Date(rec.createdAt);
  const kind = rec.kind === 'video' ? 'Video' : rec.kind === 'recording' ? 'Recording' : rec.kind === 'text' ? 'Text' : 'Audio';
  const snippet = (rec.translation || rec.transcript || '').replace(/\s+/g, ' ').slice(0, 180);
  return h('li', { class: 'history-item' },
    h('div', { class: 'history-top' },
      h('span', { class: 'history-title', text: titleOf(rec) }),
      h('span', { class: 'history-meta', text: Number.isNaN(when.getTime()) ? '' : when.toLocaleString() }),
    ),
    h('div', { class: 'history-meta' },
      `${langName(rec.transcriptLang || rec.srcLang)} to ${langName(rec.translationLang || rec.tgtLang)}`,
      ` · ${kind}`,
      rec.duration ? ` · ${formatDuration(rec.duration)}` : '',
      rec.hasOriginal || rec.hasAudio ? ' · audio kept' : '',
    ),
    snippet ? h('p', { class: 'history-snippet', text: snippet }) : null,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => openFromHistory(rec) }, 'Open'),
      h('button', {
        class: 'btn btn-small btn-danger', type: 'button', 'aria-label': `Delete ${titleOf(rec)}`,
        onclick: async () => {
          if (!(await confirmDialog({ title: 'Delete this item?', message: 'It will be removed from this device.', confirmLabel: 'Delete', danger: true }))) return;
          await deleteJob(rec.id);
          toast('Deleted.', { kind: 'success' });
          renderHistory();
        },
      }, icon('trash'), 'Delete'),
    ),
  );
}

export async function renderHistory() {
  const list = $('#history-list');
  const empty = $('#history-empty');
  const loading = $('#history-loading');
  const clearBtn = $('#history-clear');
  loading.hidden = false;
  clear(list);
  empty.hidden = true;
  let jobs = [];
  let ok = true;
  try { ok = await historyAvailable(); if (ok) jobs = await listJobs(); } catch (_) { ok = false; }
  loading.hidden = true;
  clearBtn.disabled = !jobs.length;
  if (!ok) {
    empty.hidden = false;
    empty.querySelector('h2').textContent = 'History is not available';
    empty.querySelector('p').textContent = 'This browser is not allowing local storage (private browsing can do this). Your translations still work; they just are not kept.';
    return;
  }
  if (!jobs.length) {
    empty.hidden = false;
    empty.querySelector('h2').textContent = 'No translations yet';
    empty.querySelector('p').textContent = 'Finished translations appear here so you can open them again.';
    return;
  }
  for (const rec of jobs) list.append(itemFor(rec));
}

export function initHistory() {
  if (wired) return;
  wired = true;
  $('#history-clear').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear all history?',
      message: 'Every saved translation and any kept audio will be removed from this device. Downloaded AI models stay.',
      confirmLabel: 'Clear history', danger: true,
    });
    if (!ok) return;
    try { await clearJobs(); toast('History cleared.', { kind: 'success' }); } catch (_) { toast('History could not be cleared.', { kind: 'error' }); }
    renderHistory();
  });
}
