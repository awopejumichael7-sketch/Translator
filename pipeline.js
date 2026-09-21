/* CAC Goodworks Audio Translator — the processing pipeline.
 *
 *   1 Loading  →  2 Extracting audio  →  3 Transcribing  →  4 Translating  →  5 Generating speech  →  6 Completed
 *
 * The pipeline never touches the page directly; it reports through `hooks` so the same code can be tested
 * without a screen. Models are downloaded only after the person agrees, and released after the job.
 */
import { AppError, isAbort, throwIfAborted } from './errors.js';
import { decodeToMono16k, computePeaks } from './audio.js';
import { acquireClient, releaseClient } from './engine.js';
import { asrModelFor, readyMap, loadInto, disposeModels } from './models.js';
import { transcribeSamples } from './speech.js';
import { planTranslation, translateText } from './translator.js';
import { planSpeech, generateLocalAudio, noVoiceMessage } from './tts.js';
import { langName } from './languages.js';

export const STAGES = [
  { n: 1, label: 'Loading' },
  { n: 2, label: 'Extracting audio' },
  { n: 3, label: 'Transcribing' },
  { n: 4, label: 'Translating' },
  { n: 5, label: 'Generating speech' },
  { n: 6, label: 'Completed' },
];

/** Decodes the job's media once and keeps the samples until they are released. */
export function ensureSamples(job, signal) {
  if (job.samples) return Promise.resolve(job.samples);
  if (job._decode) return job._decode;
  job._decode = decodeToMono16k(job.file, { signal, video: job.kind === 'video' })
    .then((r) => {
      job.samples = r.samples;
      job.duration = r.duration;
      if (!job.peaks) job.peaks = computePeaks(r.samples);
      return r.samples;
    })
    .finally(() => { job._decode = null; });
  return job._decode;
}

export function releaseSamples(job) { job.samples = null; }

const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

/**
 * @param job       the working job object (see view-translate.js)
 * @param opts.mode 'full' (audio → everything), 'translate' (from the transcript on), 'speech' (voice file only)
 */
export async function runJob(job, { mode = 'full', settings, hooks, signal }) {
  const keep = settings.keepModelsLoaded;
  const client = acquireClient();
  const stage = (n, status, info) => hooks.stage(n, status, info || {});
  try {
    const ready = await readyMap();
    const doTranscribe = mode === 'full';
    const review = doTranscribe && settings.reviewBeforeTranslate;
    const doTranslate = mode !== 'speech' && !review;
    const doSpeech = mode === 'speech' || !review;

    /* ---- plan everything first, so the person can agree to downloads once ---- */
    const asrModel = doTranscribe ? asrModelFor(job.srcLang, settings) : null;
    const mtPlan = doTranslate ? await planTranslation(job.srcLang, job.tgtLang, settings, ready) : null;
    let speechPlan = null;
    if (doSpeech) {
      speechPlan = await planSpeech(job.tgtLang, mode === 'speech' ? { ...settings, ttsEngine: 'local' } : settings, ready);
      if (mode === 'speech' && speechPlan.engine !== 'local') {
        throw new AppError('TTS_UNAVAILABLE', speechPlan.reason || noVoiceMessage(job.tgtLang), { retryable: false });
      }
    }

    const required = [];
    if (asrModel && !ready.has(asrModel.id)) required.push({ model: asrModel, why: 'Speech recognition' });
    if (mtPlan) for (const m of mtPlan.needs) required.push({ model: m, why: 'Translation' });
    const optional = [];
    if (speechPlan && speechPlan.engine === 'local' && speechPlan.needs.length) {
      (mode === 'speech' ? required : optional).push({ model: speechPlan.needs[0], why: 'Voice' });
    }

    if (required.length && !isOnline()) {
      throw new AppError('NETWORK', 'Internet connection required for this processing method.', {
        hint: 'Connect to the internet once to download the needed AI models. After that they work offline.',
      });
    }
    if (mtPlan && mtPlan.online && !isOnline()) {
      throw new AppError('NETWORK', 'Internet connection required for this processing method.', {
        hint: 'The online translation service needs internet. You can use an on-device model instead (AI Models).',
      });
    }
    if (optional.length && !isOnline()) {
      speechPlan = { engine: 'none', reason: `The ${langName(job.tgtLang)} voice has not been downloaded and there is no internet connection to download it.`, voices: [], needs: [] };
      optional.length = 0;
    }

    if (required.length || optional.length || (mtPlan && (mtPlan.warning || mtPlan.online))) {
      const choice = await hooks.askDownloads({ required, optional, plan: mtPlan });
      if (choice === 'cancel' || choice == null) return { status: 'cancelled' };
      if (choice === 'skip' && optional.length) {
        const fallback = speechPlan.voices && speechPlan.voices.length;
        speechPlan = fallback
          ? { engine: 'browser', voices: speechPlan.voices, model: null, needs: [] }
          : { engine: 'none', voices: [], model: null, needs: [], reason: noVoiceMessage(job.tgtLang) };
      }
    }
    throwIfAborted(signal);

    /* ---- 1 & 2: loading and extracting audio ---- */
    stage(1, 'active', { detail: 'Reading your file…' });
    if (doTranscribe && !job.file) throw new AppError('NO_INPUT', 'There is no audio to process.', { retryable: false });
    stage(1, 'done');
    if (doTranscribe) {
      stage(2, 'active', { detail: 'Extracting the audio track…' });
      await ensureSamples(job, signal);
      stage(2, 'done', { detail: 'Audio ready' });
    } else {
      stage(2, 'skipped', { detail: 'Not needed' });
    }

    /* ---- 3: transcribing ---- */
    if (doTranscribe) {
      stage(3, 'active', { detail: 'Loading the speech model…', pct: null });
      await loadInto(client, asrModel, {
        signal,
        onProgress: (p) => stage(3, 'active', { detail: `Downloading ${asrModel.label}…`, pct: p.total ? (p.loaded / p.total) * 100 : null }),
      });
      stage(3, 'active', { detail: 'Transcribing…', pct: 0 });
      const text = await transcribeSamples(client, asrModel, job.samples, {
        langCode: job.srcLang,
        signal,
        onChunk: (i, total, status) => hooks.chunk(i, total, status),
        onProgress: (f) => stage(3, 'active', { detail: 'Transcribing…', pct: f * 100 }),
      });
      job.transcript = text;
      job.transcriptLang = job.srcLang;
      job.translation = '';
      job.translationLang = '';
      hooks.onTranscript(text);
      releaseSamples(job);
      if (!keep) await disposeModels(client);
      stage(3, 'done', { detail: 'Transcript ready' });
    } else {
      stage(3, 'skipped', { detail: 'Using the existing text' });
    }

    if (review) {
      for (const n of [4, 5, 6]) stage(n, 'pending');
      return { status: 'review' };
    }

    /* ---- 4: translating ---- */
    if (doTranslate) {
      stage(4, 'active', { detail: `Translating with: ${mtPlan.label}`, pct: null });
      const translated = await translateText({
        text: job.transcript,
        src: job.srcLang,
        tgt: job.tgtLang,
        plan: mtPlan,
        settings,
        client,
        signal,
        onProgress: (pct, detail) => stage(4, 'active', { detail, pct }),
      });
      job.translation = translated;
      job.translationLang = job.tgtLang;
      job.audioBlob = null;
      job.audioPeaks = null;
      hooks.onTranslation(translated);
      if (!keep) await disposeModels(client);
      stage(4, 'done', { detail: 'Translation ready' });
    } else {
      stage(4, 'skipped', { detail: 'Using the existing translation' });
    }

    /* ---- 5: speech (a failure here never throws away the finished translation) ---- */
    job.speech = { engine: 'none', reason: '' };
    if (speechPlan.engine === 'none') {
      job.speech = { engine: 'none', reason: speechPlan.reason };
      stage(5, 'skipped', { detail: speechPlan.reason });
    } else if (speechPlan.engine === 'browser') {
      job.speech = { engine: 'browser' };
      stage(5, 'done', { detail: 'Ready to play with a browser voice' });
    } else {
      stage(5, 'active', { detail: 'Preparing the voice…', pct: null });
      try {
        const gen = await generateLocalAudio(client, speechPlan.model, job.translation, {
          signal,
          onProgress: (f, detail) => stage(5, 'active', { detail, pct: f == null ? null : f * 100 }),
        });
        job.audioBlob = gen.blob;
        job.audioPeaks = computePeaks(gen.samples);
        job.speech = { engine: 'local' };
        stage(5, 'done', { detail: 'Audio file ready to download' });
      } catch (e) {
        if (isAbort(e)) throw e;
        if (mode === 'speech') throw e;
        const msg = e instanceof AppError ? e.message : 'The voice could not be created.';
        job.speech = { engine: 'none', reason: msg };
        stage(5, 'skipped', { detail: `${msg} The translated text is still available.` });
      }
      if (!keep) { try { await disposeModels(client); } catch (_) { /* worker may have ended */ } }
    }

    stage(6, 'done', { detail: 'Finished' });
    return { status: 'done' };
  } finally {
    releaseClient(keep);
  }
}
