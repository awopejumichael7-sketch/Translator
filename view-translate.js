/* CAC Goodworks Audio Translator — the Translate screen.
 * Input (upload, drop, record, YouTube note, typed text) → progress → two-column workspace.
 */
import { isAbort, toAppError } from './errors.js';
import { getLang, langName } from './languages.js';
import { getSettings, onSettings, updateSettings } from './settings.js';
import { downloadBlob, textBlob, fileSafeName, sanitizeFilename, formatBytes, formatDuration, formatMB, stamp, uid } from './util.js';
import { $, h, icon, clear, toast, announce, confirmDialog, choiceDialog, progressBar } from './ui.js';
import {
  ACCEPT, Recorder, validateFile, isVideoFile, probeMedia, decodeToMono16k, computePeaks,
  recordingSupported, micPermission, extForMime,
} from './audio.js';
import { MediaAdapter, createPlayer } from './player.js';
import { TtsPlayer, listVoices, voicesFor, pickVoice, voiceLabel, noVoiceMessage } from './tts.js';
import { ttsModelFor, localEngineSupported } from './models.js';
import { STAGES, runJob, ensureSamples, releaseSamples } from './pipeline.js';
import { abortClient } from './engine.js';
import { saveJob, saveBlob, getBlob, listJobs, deleteJob } from './storage.js';
import { YOUTUBE_MESSAGE, parseYouTube } from './youtube.js';
import { navigate, emit, on } from './common.js';

const HISTORY_LIMIT = 50;

const S = {
  job: null,
  ctrl: null,
  lastMode: 'full',
  mediaUrl: '',
  mediaAdapter: null,
  origPlayer: null,
  transPlayer: null,
  tts: new TtsPlayer(),
  recorder: null,
  recBlob: null,
  recUrl: '',
  loadCtrl: null,
  ready: false,
};

const el = {};
const ids = [
  'panel-input', 'panel-record', 'panel-youtube', 'panel-loading', 'panel-langs', 'panel-progress', 'banner-complete', 'workspace',
  'btn-upload', 'btn-device', 'btn-record', 'btn-youtube', 'btn-text-mode', 'file-input', 'btn-translate', 'btn-new', 'btn-remove',
  'rec-back', 'rec-perm', 'rec-timer', 'rec-state', 'rec-meter', 'rec-start', 'rec-pause', 'rec-resume', 'rec-stop', 'rec-review', 'rec-audio', 'rec-use', 'rec-again',
  'yt-back', 'yt-url', 'yt-go', 'yt-result', 'loading-text', 'loading-cancel',
  'stages', 'prog-bar-host', 'prog-detail', 'chunks', 'prog-error', 'err-title', 'err-hint', 'err-retry', 'err-cancel', 'prog-cancel', 'prog-actions', 'prog-title',
  'complete-detail', 'source-meta', 'orig-video', 'orig-audio', 'orig-player', 'peaks-skeleton',
  'transcript', 'transcript-label', 'tr-edit', 'tr-save', 'tr-translate', 'dl-original', 'dl-transcript',
  'translation', 'translation-label', 'tl-copy', 'tl-edit', 'tl-save', 'dl-translation',
  'voice-row', 'voice-select', 'speech-notice', 'trans-player', 'video-note', 'dl-audio', 'make-audio', 'audio-hint',
  'view-translate',
];

const prog = { bar: null, stageEls: new Map(), chunkEls: [] };

/* ================= helpers ================= */

const hasContent = () => !!(S.job && (S.job.transcript.trim() || S.job.translation.trim()));
const fileBase = (code) => `CAC-Goodworks-${fileSafeName(langName(code))}`;

function newJob(fields) {
  const s = getSettings();
  return {
    id: uid(), kind: 'audio', file: null, fileName: '', mime: '', size: 0, duration: NaN, hasVideo: false,
    srcLang: s.srcLang, tgtLang: s.tgtLang,
    transcript: '', transcriptLang: '', translation: '', translationLang: '',
    peaks: null, samples: null, _decode: null, audioBlob: null, audioPeaks: null,
    speech: { engine: 'none', reason: '' }, createdAt: new Date().toISOString(),
    ...fields,
  };
}

function setPanels({ input = false, record = false, youtube = false, loading = false, workspace = false }) {
  el['panel-input'].hidden = !input;
  el['panel-record'].hidden = !record;
  el['panel-youtube'].hidden = !youtube;
  el['panel-loading'].hidden = !loading;
  el['panel-langs'].hidden = !workspace;
  el.workspace.hidden = !workspace;
}

function showInputStage() {
  setPanels({ input: true });
  el['panel-progress'].hidden = true;
  el['banner-complete'].hidden = true;
}

function humanError(e) {
  const err = toAppError(e);
  return err.hint ? `${err.message} ${err.hint}` : err.message;
}

/* ================= job lifecycle ================= */

function disposeMedia() {
  if (S.origPlayer) { S.origPlayer.destroy(); S.origPlayer = null; }
  if (S.mediaAdapter) { S.mediaAdapter.detach(); S.mediaAdapter = null; }
  for (const m of [el['orig-video'], el['orig-audio']]) {
    try { m.pause(); } catch (_) { /* ignore */ }
    m.removeAttribute('src');
    try { m.load(); } catch (_) { /* ignore */ }
    m.hidden = true;
  }
  if (S.mediaUrl) { URL.revokeObjectURL(S.mediaUrl); S.mediaUrl = ''; }
}

function resetJob() {
  if (S.ctrl) { S.ctrl.abort(); abortClient(); }
  if (S.loadCtrl) { S.loadCtrl.abort(); S.loadCtrl = null; }
  disposeMedia();
  S.tts.dispose();
  if (S.job) releaseSamples(S.job);
  S.job = null;
  el.transcript.value = '';
  el.translation.value = '';
  setEditing('transcript', false);
  setEditing('translation', false);
  el['orig-player'].replaceChildren();
  el['banner-complete'].hidden = true;
  el['panel-progress'].hidden = true;
  emit('input-changed', null);
}

async function confirmReplace() {
  if (!S.job) return true;
  const s = getSettings();
  if (!hasContent() || s.saveHistory) return true;
  return confirmDialog({
    title: 'Replace the current work?',
    message: 'The transcript and translation on this screen will be lost. History is turned off, so nothing has been saved.',
    confirmLabel: 'Replace', danger: true,
  });
}

function attachMediaElement(job, hasVideo) {
  disposeMedia();
  S.mediaUrl = URL.createObjectURL(job.file);
  const media = hasVideo ? el['orig-video'] : el['orig-audio'];
  media.hidden = !hasVideo;
  media.src = S.mediaUrl;
  S.mediaAdapter = new MediaAdapter(media);
  S.origPlayer = createPlayer({ adapter: S.mediaAdapter, peaks: job.peaks, label: hasVideo ? 'original video' : 'original audio' });
  S.origPlayer.setSpeed(getSettings().speed);
  el['orig-player'].replaceChildren(S.origPlayer.el);
}

/** Accepts a chosen, dropped or recorded file: checks it, reads it, and opens the workspace. */
async function acceptFile(file, { recorded = false } = {}) {
  try { validateFile(file); } catch (e) {
    toast(humanError(e), { kind: 'error' });
    return;
  }
  if (!(await confirmReplace())) return;
  resetJob();
  navigate('translate');
  setPanels({ loading: true });
  el['loading-text'].textContent = 'Reading your file…';
  const ctrl = new AbortController();
  S.loadCtrl = ctrl;
  const wantsVideo = !recorded && isVideoFile(file);
  const probe = await probeMedia(file, { video: wantsVideo });
  if (ctrl.signal.aborted) return;
  const hasVideo = wantsVideo && probe.hasVideo;
  const job = newJob({
    kind: recorded ? 'recording' : hasVideo ? 'video' : 'audio',
    file, fileName: file.name, mime: file.type, size: file.size, duration: probe.duration, hasVideo,
  });
  S.job = job;
  el['loading-text'].textContent = 'Preparing the audio…';
  try {
    await ensureSamples(job, ctrl.signal);
  } catch (e) {
    if (isAbort(e) || ctrl.signal.aborted) return;
    S.job = null;
    showInputStage();
    toast(humanError(e), { kind: 'error' });
    return;
  }
  S.loadCtrl = null;
  showWorkspace();
  announce('File ready. Choose the languages, then press Translate.');
  emit('input-changed', job);
}

function startTextMode() {
  resetJob();
  S.job = newJob({ kind: 'text', fileName: 'Typed text' });
  showWorkspace();
  el.transcript.focus();
  emit('input-changed', S.job);
}

/* ================= workspace rendering ================= */

function metaRow(job) {
  const row = el['source-meta'];
  clear(row);
  if (job.kind === 'text') { row.append(icon('type'), h('strong', { text: 'Typed or pasted text' })); return; }
  const ico = job.kind === 'video' ? 'video' : job.kind === 'recording' ? 'mic' : 'file';
  const type = job.kind === 'video' ? 'Video' : job.kind === 'recording' ? 'Recording' : 'Audio';
  row.append(
    icon(ico), h('strong', { text: job.fileName || 'Recording' }),
    h('span', { text: type }),
    job.size ? h('span', { text: formatBytes(job.size) }) : null,
    Number.isFinite(job.duration) ? h('span', { text: formatDuration(job.duration) }) : null,
  );
}

function showWorkspace() {
  const job = S.job;
  setPanels({ workspace: true });
  const isText = job.kind === 'text';
  $('#source-media').hidden = isText;
  el['dl-original'].hidden = isText || !job.file;
  metaRow(job);
  if (!isText && job.file) {
    attachMediaElement(job, job.hasVideo);
    el['peaks-skeleton'].hidden = true;
  }
  el.transcript.value = job.transcript;
  el.translation.value = job.translation;
  setEditing('transcript', isText);
  setEditing('translation', false);
  el['video-note'].hidden = job.kind !== 'video';
  refreshLabels();
  refreshButtons();
  refreshSpeech();
}

function refreshLabels() {
  const job = S.job;
  const s = getSettings();
  const src = job && job.transcriptLang ? job.transcriptLang : s.srcLang;
  const tgt = job && job.translationLang ? job.translationLang : s.tgtLang;
  el['transcript-label'].textContent = `Original transcript (${langName(src)})`;
  el['translation-label'].textContent = `Translated text (${langName(tgt)})`;
  el.transcript.dir = getLang(src).dir;
  el.translation.dir = getLang(tgt).dir;
  el['btn-translate'].textContent = job && job.kind === 'text' ? 'Translate text' : 'Translate audio';
  el['prog-title'].textContent = 'Working on it';
}

function refreshButtons() {
  const job = S.job;
  if (!job) return;
  const hasT = !!job.transcript.trim();
  const hasX = !!job.translation.trim();
  const busy = !!S.ctrl;
  el['tr-translate'].disabled = !hasT || busy;
  el['btn-translate'].disabled = busy || (job.kind === 'text' && !hasT);
  el['dl-transcript'].disabled = !hasT;
  el['dl-translation'].disabled = !hasX;
  el['tl-copy'].disabled = !hasX;
  el['tl-edit'].disabled = !hasX || busy;
  el['tr-edit'].disabled = busy;
  el['make-audio'].disabled = busy;
}

function setEditing(which, on) {
  const isT = which === 'transcript';
  const area = isT ? el.transcript : el.translation;
  const edit = isT ? el['tr-edit'] : el['tl-edit'];
  const save = isT ? el['tr-save'] : el['tl-save'];
  const textMode = S.job && S.job.kind === 'text' && isT;
  area.readOnly = !(on || textMode);
  edit.hidden = on || textMode;
  save.hidden = !on || textMode;
}

/* ================= translated voice ================= */

async function refreshSpeech() {
  const job = S.job;
  const player = S.transPlayer;
  const notice = el['speech-notice'];
  const playBtn = player.el.querySelector('.player-play');
  notice.hidden = true;
  el['voice-row'].hidden = true;
  el['make-audio'].hidden = true;
  el['dl-audio'].hidden = true;
  el['audio-hint'].textContent = '';
  if (!job || !job.translation.trim()) {
    S.tts.dispose();
    player.setAdapter(S.tts);
    playBtn.disabled = true;
    return;
  }
  const tgt = job.translationLang || job.tgtLang;
  const s = getSettings();
  const voices = voicesFor(tgt, await listVoices());
  const model = ttsModelFor(tgt);
  const canLocal = !!model && localEngineSupported();

  if (job.audioBlob) {
    if (S.tts._blob !== job.audioBlob) { S.tts._blob = job.audioBlob; S.tts.loadBlob(job.audioBlob); }
    player.setAdapter(S.tts);
    player.setPeaks(job.audioPeaks || null);
    player.setNote('');
    el['dl-audio'].hidden = false;
  } else if (voices.length && s.ttsEngine !== 'local') {
    S.tts._blob = null;
    S.tts.loadBrowser({ text: job.translation, lang: tgt, voice: pickVoice(tgt, voices, s.voiceByLang[tgt]) });
    player.setAdapter(S.tts);
    player.setPeaks(null);
    player.setNote('Browser voices can be played but not saved as a file.');
    fillVoiceSelect(tgt, voices);
  } else {
    S.tts._blob = null;
    S.tts.dispose();
    player.setAdapter(S.tts);
    player.setPeaks(null);
    player.setNote('');
    notice.hidden = false;
    notice.className = 'notice';
    notice.textContent = canLocal
      ? `Create the ${langName(tgt)} audio to play and download it. This uses a small voice model (about ${formatMB(model.sizeMB)}) that downloads once.`
      : noVoiceMessage(tgt);
  }
  if (canLocal && !job.audioBlob) el['make-audio'].hidden = false;
  playBtn.disabled = !S.tts.ready;
  if (!job.audioBlob) {
    el['audio-hint'].textContent = canLocal
      ? 'To save the translation as an audio file, create the downloadable audio.'
      : 'Audio download is not available for this language on this device. You can still download the text.';
  }
}

function fillVoiceSelect(tgt, voices) {
  const sel = el['voice-select'];
  const s = getSettings();
  clear(sel);
  for (const v of voices) sel.append(h('option', { value: v.voiceURI, text: voiceLabel(v) }));
  const cur = pickVoice(tgt, voices, s.voiceByLang[tgt]);
  if (cur) sel.value = cur.voiceURI;
  el['voice-row'].hidden = voices.length < 2;
}

/* ================= progress panel ================= */

function buildStages() {
  clear(el.stages);
  prog.stageEls.clear();
  for (const st of STAGES) {
    const mark = h('span', { class: 'stage-mark' }, icon('check'));
    const detail = h('span', { class: 'stage-detail' });
    const li = h('li', { dataset: { status: 'pending' } }, mark, h('span', {}, st.label, ' ', detail));
    el.stages.append(li);
    prog.stageEls.set(st.n, { li, detail });
  }
  clear(el.chunks);
  el.chunks.hidden = true;
  prog.chunkEls = [];
  prog.bar = progressBar('Progress');
  el['prog-bar-host'].replaceChildren(prog.bar.el);
  prog.bar.set(null);
  el['prog-detail'].textContent = '';
}

function onStage(n, status, info = {}) {
  const entry = prog.stageEls.get(n);
  if (!entry) return;
  entry.li.dataset.status = status;
  if (info.detail && (status === 'skipped' || status === 'error')) entry.detail.textContent = `— ${info.detail}`;
  else if (status === 'done') entry.detail.textContent = '';
  if (status === 'active') {
    prog.bar.set('pct' in info ? info.pct : null);
    const pct = Number.isFinite(info.pct) ? ` — ${Math.round(info.pct)}%` : '';
    el['prog-detail'].textContent = `Step ${n} of 6: ${STAGES[n - 1].label}. ${info.detail || ''}${pct}`.trim();
  } else if (status === 'done' && n === 6) {
    prog.bar.set(100);
  }
}

function onChunk(i, total, status) {
  if (total < 2) return;
  if (!prog.chunkEls.length) {
    el.chunks.hidden = false;
    for (let k = 0; k < total; k++) {
      const li = h('li', { dataset: { status: 'pending' }, text: String(k + 1), title: `Piece ${k + 1} of ${total}` });
      prog.chunkEls.push(li);
      el.chunks.append(li);
    }
  }
  const li = prog.chunkEls[i];
  if (li) li.dataset.status = status;
  el['prog-detail'].textContent = `Step 3 of 6: Transcribing. Piece ${Math.min(i + 1, total)} of ${total}.`;
}

/** Asks before anything is downloaded. Returns 'all' | 'skip' | 'cancel'. */
async function askDownloads({ required, optional, plan }) {
  const all = [...required, ...optional];
  const totalMB = all.reduce((n, x) => n + x.model.sizeMB, 0);
  const body = h('div', {});
  if (all.length) {
    body.append(h('p', { text: 'These free, open-source AI models run on your device. They download once and are then kept for offline use. Your audio and text are not sent anywhere.' }));
    body.append(h('ul', { class: 'dl-list' }, all.map((x) =>
      h('li', {}, h('span', { text: `${x.why}: ${x.model.label}` }), h('span', { text: formatMB(x.model.sizeMB) })))));
    body.append(h('p', { class: 'hint', text: `Total: about ${formatMB(totalMB)}. Use Wi-Fi if you can.` }));
    const lic = all.map((x) => x.model).filter((m) => /NC/.test(m.license));
    if (lic.length) body.append(h('p', { class: 'hint', text: 'Some of these models are licensed for non-commercial use only.' }));
  }
  if (plan && plan.online) body.append(h('p', { class: 'notice', text: 'Your text will be sent over the internet to the MyMemory translation service.' }));
  if (plan && plan.warning) body.append(h('p', { class: 'notice', text: plan.warning }));
  const actions = [{ label: 'Cancel', value: 'cancel', kind: 'ghost' }];
  if (optional.length && required.length) actions.push({ label: 'Continue without voice', value: 'skip' });
  if (optional.length && !required.length) actions.push({ label: 'Skip voice', value: 'skip' });
  actions.push({ label: all.length ? 'Download and continue' : 'Continue', value: 'all', kind: 'primary' });
  const r = await choiceDialog({
    title: all.length ? 'Download AI models?' : 'Before you continue',
    body, actions, dismissible: true,
  });
  return r || 'cancel';
}

function showProgress() {
  buildStages();
  el['prog-error'].hidden = true;
  el['prog-actions'].hidden = false;
  el['panel-progress'].hidden = false;
  el['banner-complete'].hidden = true;
  el['panel-progress'].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showError(err) {
  const active = [...prog.stageEls.entries()].find(([, v]) => v.li.dataset.status === 'active');
  if (active) active[1].li.dataset.status = 'error';
  el['err-title'].textContent = err.message;
  el['err-hint'].textContent = err.hint || (err.retryable ? 'You can try again, or cancel.' : '');
  el['err-retry'].hidden = err.retryable === false;
  el['prog-error'].hidden = false;
  el['prog-actions'].hidden = true;
  prog.bar.set(0);
  announce(`Error. ${err.message}`);
}

/* ================= running a job ================= */

function pickMode() {
  const job = S.job;
  if (job.kind === 'text') return 'translate';
  if (!job.transcript.trim() || job.transcriptLang !== job.srcLang) return 'full';
  return 'translate';
}

async function startTranslation(forceMode) {
  const job = S.job;
  if (!job || S.ctrl) return;
  const s = getSettings();
  if (s.srcLang === s.tgtLang) { toast('Choose two different languages.', { kind: 'warn' }); return; }
  job.srcLang = s.srcLang;
  job.tgtLang = s.tgtLang;
  if (!el.transcript.readOnly || job.kind === 'text') job.transcript = el.transcript.value.trim();
  if (job.kind === 'text') job.transcriptLang = job.srcLang;
  if (job.kind === 'text' && !job.transcript) { toast('Type or paste some text first.', { kind: 'warn' }); return; }
  if (forceMode === 'translate' && !job.transcript.trim()) return;
  if (forceMode === 'translate') job.transcriptLang = job.srcLang; // the person is telling us what language this text is in
  await run(forceMode || pickMode());
}

async function run(mode) {
  const job = S.job;
  S.lastMode = mode;
  S.ctrl = new AbortController();
  showProgress();
  refreshButtons();
  setEditing('transcript', false);
  setEditing('translation', false);
  const hooks = {
    stage: onStage,
    chunk: onChunk,
    askDownloads,
    onTranscript: (t) => { el.transcript.value = t; refreshLabels(); },
    onTranslation: (t) => { el.translation.value = t; refreshLabels(); },
  };
  try {
    const res = await runJob(job, { mode, settings: getSettings(), hooks, signal: S.ctrl.signal });
    if (res.status === 'cancelled') {
      el['panel-progress'].hidden = true;
      toast('Cancelled. Nothing was downloaded.');
    } else if (res.status === 'review') {
      el['panel-progress'].hidden = true;
      refreshLabels();
      setEditing('transcript', true);
      el.transcript.focus();
      toast('Transcript ready. Check it, fix any words, then choose Translate.', { kind: 'success' });
      await persistJob();
    } else {
      await finishJob(mode);
    }
  } catch (e) {
    if (isAbort(e)) {
      el['panel-progress'].hidden = true;
      toast('Cancelled.');
    } else {
      showError(toAppError(e));
    }
  } finally {
    S.ctrl = null;
    refreshButtons();
    refreshLabels();
  }
}

async function finishJob(mode) {
  const job = S.job;
  el['panel-progress'].hidden = true;
  el.chunks.hidden = true;
  el.transcript.value = job.transcript;
  el.translation.value = job.translation;
  if (mode === 'speech') {
    await refreshSpeech();
    toast('Audio ready. You can play and download it.', { kind: 'success' });
    return;
  }
  el['complete-detail'].textContent = `${langName(job.transcriptLang || job.srcLang)} to ${langName(job.translationLang || job.tgtLang)}`;
  el['banner-complete'].hidden = false;
  await refreshSpeech();
  refreshLabels();
  refreshButtons();
  await persistJob();
  announce('Translation complete.');
  el['banner-complete'].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const auto = getSettings().autoDownload;
  if (auto !== 'off') {
    downloadTranslation();
    if (auto === 'text-audio' && job.audioBlob) downloadAudio();
  }
}

function cancelRun() {
  if (S.ctrl) S.ctrl.abort();
  abortClient();
  S.tts.stop();
}

/* ================= history ================= */

async function persistJob() {
  const job = S.job;
  const s = getSettings();
  if (!job || !s.saveHistory) return;
  if (!job.transcript.trim() && !job.translation.trim()) return;
  try {
    const keepAudio = s.keepAudioInHistory;
    const rec = {
      id: job.id, kind: job.kind, fileName: job.fileName, mime: job.mime, size: job.size, duration: Number.isFinite(job.duration) ? job.duration : null,
      srcLang: job.srcLang, tgtLang: job.tgtLang, transcript: job.transcript, transcriptLang: job.transcriptLang,
      translation: job.translation, translationLang: job.translationLang, createdAt: job.createdAt,
      updatedAt: new Date().toISOString(), hasOriginal: false, hasAudio: false,
    };
    if (keepAudio && job.file) { await saveBlob(`${job.id}:original`, job.file); rec.hasOriginal = true; }
    if (keepAudio && job.audioBlob) { await saveBlob(`${job.id}:audio`, job.audioBlob); rec.hasAudio = true; }
    await saveJob(rec);
    const all = await listJobs();
    for (const old of all.slice(HISTORY_LIMIT)) await deleteJob(old.id);
  } catch (_) {
    toast('This translation could not be saved to history on this device.', { kind: 'warn' });
  }
}

/** Opens a saved job from the History screen. */
export async function openFromHistory(rec) {
  resetJob();
  const job = newJob({
    id: rec.id, kind: rec.kind === 'text' ? 'text' : 'audio', fileName: rec.fileName || '', mime: rec.mime || '', size: rec.size || 0,
    duration: rec.duration == null ? NaN : rec.duration,
    srcLang: rec.srcLang, tgtLang: rec.tgtLang, transcript: rec.transcript || '', transcriptLang: rec.transcriptLang || rec.srcLang,
    translation: rec.translation || '', translationLang: rec.translationLang || rec.tgtLang, createdAt: rec.createdAt,
  });
  updateSettings({ srcLang: rec.srcLang, tgtLang: rec.tgtLang });
  job.srcLang = rec.srcLang;
  job.tgtLang = rec.tgtLang;
  try {
    if (rec.hasOriginal) {
      const blob = await getBlob(`${rec.id}:original`);
      if (blob) {
        job.file = new File([blob], rec.fileName || 'audio', { type: rec.mime || blob.type });
        job.kind = rec.kind === 'video' || rec.kind === 'recording' ? rec.kind : 'audio';
        job.hasVideo = rec.kind === 'video';
      }
    }
    if (rec.hasAudio) {
      const ab = await getBlob(`${rec.id}:audio`);
      if (ab) {
        job.audioBlob = ab;
        decodeToMono16k(ab).then((r) => { job.audioPeaks = computePeaks(r.samples); if (S.job === job) S.transPlayer.setPeaks(job.audioPeaks); }).catch(() => {});
      }
    }
  } catch (_) { /* text still opens */ }
  S.job = job;
  navigate('translate');
  showWorkspace();
  if (job.file) {
    ensureSamples(job).then(() => {
      if (S.job === job && S.origPlayer) S.origPlayer.setPeaks(job.peaks);
      releaseSamples(job);
    }).catch(() => {});
  }
  if (!job.file && job.kind !== 'text') {
    $('#source-media').hidden = true;
    el['source-meta'].append(h('span', { class: 'hint', text: 'The original audio was not kept. Only the text is saved.' }));
  }
  emit('input-changed', job);
}

/* ================= downloads ================= */

function downloadTranscript() {
  const job = S.job;
  downloadBlob(textBlob(job.transcript), `${fileBase(job.transcriptLang || job.srcLang)}-Transcript.txt`);
}
function downloadTranslation() {
  const job = S.job;
  downloadBlob(textBlob(job.translation), `${fileBase(job.translationLang || job.tgtLang)}-Translation.txt`);
}
function downloadAudio() {
  const job = S.job;
  if (!job.audioBlob) return;
  downloadBlob(job.audioBlob, `${fileBase(job.translationLang || job.tgtLang)}-Audio.wav`);
}
function downloadOriginal() {
  const job = S.job;
  if (!job.file) return;
  const name = job.kind === 'recording' && !/\.\w+$/.test(job.fileName)
    ? `CAC-Goodworks-Recording-${stamp()}.${extForMime(job.mime)}`
    : sanitizeFilename(job.fileName, 'original');
  downloadBlob(job.file, name);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = h('textarea', { 'aria-hidden': 'true', tabindex: '-1' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
    ta.remove();
    if (!ok) { toast('Copying is not allowed in this browser. Select the text and copy it yourself.', { kind: 'error' }); return; }
  }
  toast('Copied to the clipboard.', { kind: 'success' });
}

/* ================= recorder ================= */

async function updatePermissionLine() {
  const p = el['rec-perm'];
  if (!recordingSupported()) { p.textContent = 'Recording is not supported in this browser. Upload a recorded file instead.'; el['rec-start'].disabled = true; return; }
  if (!window.isSecureContext) { p.textContent = 'Recording needs a secure (https) connection. Open the app from its https address, or upload a file instead.'; el['rec-start'].disabled = true; return; }
  el['rec-start'].disabled = false;
  const st = await micPermission();
  p.textContent = st === 'granted' ? 'Microphone access is allowed.'
    : st === 'denied' ? 'Microphone access is blocked. Allow it in your browser settings to record.'
      : 'The browser will ask for microphone access when you start.';
}

function recUi(state) {
  const live = state === 'recording';
  el['rec-start'].hidden = state !== 'idle' && state !== 'stopped';
  el['rec-pause'].hidden = !live;
  el['rec-resume'].hidden = state !== 'paused';
  el['rec-stop'].hidden = !(live || state === 'paused');
  el['rec-state'].textContent = live ? 'Recording' : state === 'paused' ? 'Paused' : state === 'stopped' ? 'Recording finished' : 'Ready to record';
  el['rec-state'].classList.toggle('is-live', live);
}

function clearRecording() {
  if (S.recUrl) { URL.revokeObjectURL(S.recUrl); S.recUrl = ''; }
  S.recBlob = null;
  el['rec-audio'].removeAttribute('src');
  el['rec-review'].hidden = true;
}

function discardRecorder() {
  if (S.recorder) { S.recorder.cancel(); S.recorder = null; }
  clearRecording();
  el['rec-timer'].textContent = '0:00';
  el['rec-meter'].style.width = '0%';
  recUi('idle');
}

function openRecorder() {
  discardRecorder();
  setPanels({ record: true });
  updatePermissionLine();
}

async function startRecording() {
  clearRecording();
  const rec = new Recorder();
  S.recorder = rec;
  rec.addEventListener('state', (e) => recUi(e.detail));
  rec.addEventListener('tick', (e) => { el['rec-timer'].textContent = formatDuration(e.detail); });
  rec.addEventListener('level', (e) => { el['rec-meter'].style.width = `${Math.round(e.detail * 100)}%`; });
  rec.addEventListener('error', (e) => toast(humanError(e.detail), { kind: 'error' }));
  try {
    await rec.start();
    el['rec-timer'].textContent = '0:00';
    announce('Recording started.');
  } catch (e) {
    S.recorder = null;
    recUi('idle');
    const err = toAppError(e);
    el['rec-perm'].textContent = `${err.message} ${err.hint}`.trim();
    toast(humanError(err), { kind: 'error' });
  }
}

async function stopRecording() {
  try {
    const { blob, seconds } = await S.recorder.stop();
    S.recBlob = blob;
    S.recUrl = URL.createObjectURL(blob);
    el['rec-audio'].src = S.recUrl;
    el['rec-review'].hidden = false;
    el['rec-timer'].textContent = formatDuration(seconds);
    announce('Recording finished. You can play it back, then use it.');
  } catch (e) {
    toast(humanError(e), { kind: 'error' });
    recUi('idle');
  }
}

async function useRecording() {
  if (!S.recBlob) return;
  const blob = S.recBlob;
  const ext = extForMime(blob.type);
  const file = new File([blob], `CAC-Goodworks-Recording-${stamp()}.${ext}`, { type: blob.type });
  clearRecording();
  S.recorder = null;
  await acceptFile(file, { recorded: true });
}

/* ================= YouTube ================= */

function checkYouTube() {
  const box = el['yt-result'];
  const r = parseYouTube(el['yt-url'].value);
  box.hidden = false;
  clear(box);
  if (!r.valid) {
    box.className = 'notice';
    box.append('That does not look like a YouTube link. Check it and try again.');
    return;
  }
  box.className = 'notice is-info';
  box.append(
    h('p', { text: YOUTUBE_MESSAGE }),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => pickFile() }, 'Upload a file')),
  );
}

/* ================= file picking and drag-drop ================= */

function pickFile() {
  const input = el['file-input'];
  input.accept = ACCEPT;
  input.value = '';
  input.click();
}

function bindDropTarget() {
  let depth = 0;
  const dz = el['panel-input'];
  const isFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (isFiles(e)) { depth++; dz.classList.add('is-dragover'); } });
  window.addEventListener('dragleave', (e) => { if (isFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('is-dragover'); } });
  window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dz.classList.remove('is-dragover');
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if (files.length > 1) toast(`One file at a time. Using ${files[0].name}.`, { kind: 'warn' });
    acceptFile(files[0]);
  });
}

/* ================= public API ================= */

export const hasInput = () => !!S.job;
export const inputName = () => (S.job ? (S.job.fileName || 'your text') : '');
export async function begin(method) {
  navigate('translate');
  if (method === 'upload') { pickFile(); return; }
  if (S.job) {
    if (!(await confirmReplace())) return;
    resetJob();
  }
  if (method === 'record') openRecorder();
  else if (method === 'youtube') { setPanels({ youtube: true }); el['yt-url'].focus(); }
  else if (method === 'text') startTextMode();
}
export function translateNow() { navigate('translate'); if (S.job) startTranslation(); }

export function initTranslate() {
  if (S.ready) return;
  S.ready = true;
  for (const id of ids) el[id] = document.getElementById(id);

  S.transPlayer = createPlayer({ adapter: S.tts, label: 'translation', playText: 'Play translation' });
  el['trans-player'].replaceChildren(S.transPlayer.el);
  S.tts.addEventListener('error', (e) => toast(humanError(e.detail), { kind: 'error' }));
  showInputStage();

  // input choices
  for (const id of ['btn-upload', 'btn-device']) el[id].addEventListener('click', pickFile);
  el['btn-record'].addEventListener('click', openRecorder);
  el['btn-youtube'].addEventListener('click', () => { setPanels({ youtube: true }); el['yt-url'].focus(); });
  el['btn-text-mode'].addEventListener('click', startTextMode);
  el['file-input'].addEventListener('change', () => { const f = el['file-input'].files && el['file-input'].files[0]; if (f) acceptFile(f); });
  el['loading-cancel'].addEventListener('click', () => { resetJob(); showInputStage(); });
  bindDropTarget();

  // recorder
  el['rec-back'].addEventListener('click', () => { discardRecorder(); showInputStage(); });
  el['rec-start'].addEventListener('click', startRecording);
  el['rec-pause'].addEventListener('click', () => S.recorder && S.recorder.pause());
  el['rec-resume'].addEventListener('click', () => S.recorder && S.recorder.resume());
  el['rec-stop'].addEventListener('click', stopRecording);
  el['rec-again'].addEventListener('click', () => { clearRecording(); el['rec-timer'].textContent = '0:00'; recUi('idle'); });
  el['rec-use'].addEventListener('click', useRecording);

  // YouTube
  el['yt-back'].addEventListener('click', showInputStage);
  el['yt-go'].addEventListener('click', checkYouTube);
  el['yt-url'].addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); checkYouTube(); } });

  // actions
  el['btn-translate'].addEventListener('click', () => startTranslation());
  el['tr-translate'].addEventListener('click', () => startTranslation('translate'));
  el['btn-new'].addEventListener('click', async () => { if (await confirmReplace()) { resetJob(); showInputStage(); } });
  el['btn-remove'].addEventListener('click', async () => {
    if (hasContent()) {
      const ok = await confirmDialog({ title: 'Remove this file?', message: 'The file and the text on this screen will be cleared. Anything saved in History stays there.', confirmLabel: 'Remove', danger: true });
      if (!ok) return;
    }
    resetJob();
    showInputStage();
  });
  el['prog-cancel'].addEventListener('click', cancelRun);
  el['err-cancel'].addEventListener('click', () => { el['panel-progress'].hidden = true; refreshButtons(); });
  el['err-retry'].addEventListener('click', () => { if (!S.ctrl && S.job) run(S.lastMode); });

  // text areas
  el['tr-edit'].addEventListener('click', () => { setEditing('transcript', true); el.transcript.focus(); });
  el['tr-save'].addEventListener('click', async () => {
    S.job.transcript = el.transcript.value.trim();
    setEditing('transcript', false);
    refreshButtons();
    await persistJob();
    toast('Edits saved.', { kind: 'success' });
  });
  el.transcript.addEventListener('input', () => { if (S.job && S.job.kind === 'text') { S.job.transcript = el.transcript.value; refreshButtons(); } });
  el['tl-edit'].addEventListener('click', () => { setEditing('translation', true); el.translation.focus(); });
  el['tl-save'].addEventListener('click', async () => {
    const job = S.job;
    job.translation = el.translation.value.trim();
    job.audioBlob = null;
    job.audioPeaks = null;
    S.tts._blob = null;
    setEditing('translation', false);
    refreshButtons();
    await refreshSpeech();
    await persistJob();
    toast('Edits saved.', { kind: 'success' });
  });
  el['tl-copy'].addEventListener('click', () => copyText(el.translation.value));

  // downloads
  el['dl-transcript'].addEventListener('click', downloadTranscript);
  el['dl-translation'].addEventListener('click', downloadTranslation);
  el['dl-audio'].addEventListener('click', downloadAudio);
  el['dl-original'].addEventListener('click', downloadOriginal);
  el['make-audio'].addEventListener('click', async () => {
    if (S.job && !S.ctrl) await run('speech');
  });

  // voice picker
  el['voice-select'].addEventListener('change', async () => {
    const job = S.job;
    const tgt = job.translationLang || job.tgtLang;
    updateSettings({ voiceByLang: { ...getSettings().voiceByLang, [tgt]: el['voice-select'].value } });
    S.tts.stop();
    await refreshSpeech();
  });

  // reactions
  onSettings((s, patch) => {
    if (patch && ('speed' in patch)) { S.transPlayer.setSpeed(s.speed); if (S.origPlayer) S.origPlayer.setSpeed(s.speed); }
    if (S.job) { refreshLabels(); if (patch && ('ttsEngine' in patch || 'voiceByLang' in patch)) refreshSpeech(); }
  });
  on('voice-changed', () => refreshSpeech());
  S.transPlayer.setSpeed(getSettings().speed);
  window.addEventListener('pagehide', () => { S.tts.stop(); });
}
