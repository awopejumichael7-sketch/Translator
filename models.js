/* CAC Goodworks Audio Translator — registry of the free, open-source models the app can download.
 * Sizes are approximate (quantised 8-bit files) and are shown to the user before any download.
 * Only models that were checked to exist on the Hugging Face Hub are listed.
 */
import { LANGUAGES, getLang } from './languages.js';
import { AppError } from './errors.js';
import { WorkerClient, LIB_URL } from './ml-client.js';
import { markModelReady, deleteModelFiles, readyModelIds } from './storage.js';

export { LIB_URL };

const ASR_TASK = 'automatic-speech-recognition';

export const ASR_MODELS = [
  { id: 'Xenova/whisper-tiny.en',  kind: 'asr', task: ASR_TASK, label: 'Whisper Tiny (English)',  sizeMB: 40,  multilingual: false, license: 'MIT', desc: 'Fastest. Good for clear speech on low-power phones.' },
  { id: 'Xenova/whisper-base.en',  kind: 'asr', task: ASR_TASK, label: 'Whisper Base (English)',  sizeMB: 80,  multilingual: false, license: 'MIT', desc: 'Balanced speed and accuracy. Recommended.' },
  { id: 'Xenova/whisper-small.en', kind: 'asr', task: ASR_TASK, label: 'Whisper Small (English)', sizeMB: 250, multilingual: false, license: 'MIT', desc: 'Most accurate English model here. Slower; needs a modern phone or computer.' },
  { id: 'Xenova/whisper-tiny',     kind: 'asr', task: ASR_TASK, label: 'Whisper Tiny (multilingual)',  sizeMB: 40,  multilingual: true, license: 'MIT', desc: 'For non-English speech. Fast, lowest accuracy.' },
  { id: 'Xenova/whisper-base',     kind: 'asr', task: ASR_TASK, label: 'Whisper Base (multilingual)',  sizeMB: 80,  multilingual: true, license: 'MIT', desc: 'For non-English speech. Balanced.' },
  { id: 'Xenova/whisper-small',    kind: 'asr', task: ASR_TASK, label: 'Whisper Small (multilingual)', sizeMB: 250, multilingual: true, license: 'MIT', desc: 'For non-English speech. Better accuracy, slower.' },
].map((m) => ({ dtype: 'q8', ...m }));

export const NLLB_ID = 'Xenova/nllb-200-distilled-600M';

export const MT_MODELS = [
  {
    id: NLLB_ID, kind: 'mt', task: 'translation', label: 'NLLB-200 (200 languages)', sizeMB: 900, universal: true,
    license: 'CC-BY-NC-4.0 (non-commercial)', dtype: 'q8', minRamGB: 4,
    desc: 'Meta’s open translation model. Covers every language in this app, including Yoruba, Hausa and Igbo. Large download; needs a device with about 4 GB of memory or more.',
  },
  { id: 'Xenova/opus-mt-en-fr', kind: 'mt', task: 'translation', label: 'Opus-MT English → French',  sizeMB: 100, pair: ['en', 'fr'], license: 'CC-BY-4.0', dtype: 'q8', desc: 'Compact single-pair model for lower-powered phones.' },
  { id: 'Xenova/opus-mt-en-es', kind: 'mt', task: 'translation', label: 'Opus-MT English → Spanish', sizeMB: 100, pair: ['en', 'es'], license: 'CC-BY-4.0', dtype: 'q8', desc: 'Compact single-pair model for lower-powered phones.' },
  { id: 'Xenova/opus-mt-en-ar', kind: 'mt', task: 'translation', label: 'Opus-MT English → Arabic',  sizeMB: 100, pair: ['en', 'ar'], license: 'CC-BY-4.0', dtype: 'q8', desc: 'Compact single-pair model for lower-powered phones.' },
  { id: 'Xenova/opus-mt-en-hi', kind: 'mt', task: 'translation', label: 'Opus-MT English → Hindi',   sizeMB: 100, pair: ['en', 'hi'], license: 'CC-BY-4.0', dtype: 'q8', desc: 'Compact single-pair model for lower-powered phones.' },
];

export const TTS_MODELS = LANGUAGES.filter((l) => l.mms).map((l) => ({
  id: l.mms, kind: 'tts', task: 'text-to-speech', label: `MMS-TTS ${l.name}`, lang: l.code, sizeMB: 40,
  license: 'CC-BY-NC-4.0 (non-commercial)', dtype: 'q8',
  desc: `Meta MMS voice for ${l.name}. Creates a downloadable audio file. Quality varies; digits are not spoken.`,
}));

export const ALL_MODELS = [...ASR_MODELS, ...MT_MODELS, ...TTS_MODELS];

export function getModel(id) {
  const m = ALL_MODELS.find((x) => x.id === id);
  if (!m) throw new AppError('MODEL_UNKNOWN', `Unknown model: ${id}`, { retryable: false });
  return m;
}

/** Picks the Whisper model for a source language, or throws when Whisper cannot handle it. */
export function asrModelFor(langCode, settings) {
  const lang = getLang(langCode);
  if (!lang.whisper) {
    throw new AppError('ASR_LANG', `Speech recognition for ${lang.name} is not available on this device (the Whisper models do not include it).`, {
      hint: 'You can still type or paste the text into the transcript box and translate it.',
      retryable: false,
    });
  }
  const id = langCode === 'en' ? settings.asrModelEn : settings.asrModelMulti;
  const m = ASR_MODELS.find((x) => x.id === id && x.multilingual === (langCode !== 'en'));
  return m || ASR_MODELS.find((x) => x.multilingual === (langCode !== 'en') && x.sizeMB === 80);
}

export const opusFor = (src, tgt) => MT_MODELS.find((m) => m.pair && m.pair[0] === src && m.pair[1] === tgt) || null;
export const nllbSupports = (src, tgt) => !!(getLang(src).nllb && getLang(tgt).nllb);
export const ttsModelFor = (langCode) => TTS_MODELS.find((m) => m.lang === langCode) || null;

export async function readyMap(models = ALL_MODELS) {
  return readyModelIds(models.map((m) => m.id));
}

/** Downloads a model into the on-device cache without keeping it in memory afterwards. */
export async function downloadModel(model, { onProgress, signal } = {}) {
  const client = new WorkerClient('download');
  try {
    await client.call('load', { task: model.task, model: model.id, dtype: model.dtype }, { onProgress, signal });
    markModelReady(model.id);
  } finally {
    client.terminate();
  }
}

export const removeModel = (model) => deleteModelFiles(model.id);

/** Loads a model into a worker (downloading it first if it is not cached yet). */
export async function loadInto(client, model, { onProgress, signal } = {}) {
  await client.call('load', { task: model.task, model: model.id, dtype: model.dtype }, { onProgress, signal });
  markModelReady(model.id);
}

/** Frees every loaded model in the worker (the downloaded files stay cached on the device). */
export const disposeModels = (client) => client.call('dispose', {});

/** True when this browser can run the on-device engine (WebAssembly + module workers). */
export const localEngineSupported = () => typeof WebAssembly === 'object' && typeof Worker !== 'undefined';
