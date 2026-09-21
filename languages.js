/* CAC Goodworks Audio Translator — language table.
 *
 * To add a language, add one entry to LANGUAGES below (see README → "Adding more languages").
 *   code       short code used in the app and in the browser Translator / voice lookups
 *   name       English name shown in menus and used in downloaded file names
 *   native     name in the language itself
 *   nllb       NLLB-200 language code (translation model) — null if NLLB does not cover it
 *   whisper    Whisper language name (speech recognition) — null if Whisper does not cover it
 *   mms        Hugging Face id of a verified local text-to-speech model (Meta MMS-TTS, ONNX) — null if none
 *   mymemory   language code for the optional MyMemory online service
 *   dir        'ltr' or 'rtl'
 */
export const LANGUAGES = [
  { code: 'en', name: 'English',    native: 'English',    nllb: 'eng_Latn', whisper: 'english',    mms: 'Xenova/mms-tts-eng', mymemory: 'en',    dir: 'ltr' },
  { code: 'yo', name: 'Yoruba',     native: 'Yorùbá',     nllb: 'yor_Latn', whisper: 'yoruba',     mms: 'Xenova/mms-tts-yor', mymemory: 'yo',    dir: 'ltr', priority: true },
  { code: 'ha', name: 'Hausa',      native: 'Hausa',      nllb: 'hau_Latn', whisper: 'hausa',      mms: null,                 mymemory: 'ha',    dir: 'ltr' },
  { code: 'ig', name: 'Igbo',       native: 'Igbo',       nllb: 'ibo_Latn', whisper: null,         mms: null,                 mymemory: 'ig',    dir: 'ltr' },
  { code: 'fr', name: 'French',     native: 'Français',   nllb: 'fra_Latn', whisper: 'french',     mms: 'Xenova/mms-tts-fra', mymemory: 'fr',    dir: 'ltr' },
  { code: 'es', name: 'Spanish',    native: 'Español',    nllb: 'spa_Latn', whisper: 'spanish',    mms: 'Xenova/mms-tts-spa', mymemory: 'es',    dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', native: 'Português',  nllb: 'por_Latn', whisper: 'portuguese', mms: 'Xenova/mms-tts-por', mymemory: 'pt',    dir: 'ltr' },
  { code: 'ar', name: 'Arabic',     native: 'العربية',     nllb: 'arb_Arab', whisper: 'arabic',     mms: 'Xenova/mms-tts-ara', mymemory: 'ar',    dir: 'rtl' },
  { code: 'de', name: 'German',     native: 'Deutsch',    nllb: 'deu_Latn', whisper: 'german',     mms: 'Xenova/mms-tts-deu', mymemory: 'de',    dir: 'ltr' },
  { code: 'it', name: 'Italian',    native: 'Italiano',   nllb: 'ita_Latn', whisper: 'italian',    mms: null,                 mymemory: 'it',    dir: 'ltr' },
  { code: 'zh', name: 'Chinese',    native: '中文',        nllb: 'zho_Hans', whisper: 'chinese',    mms: null,                 mymemory: 'zh-CN', dir: 'ltr' },
  { code: 'ja', name: 'Japanese',   native: '日本語',       nllb: 'jpn_Jpan', whisper: 'japanese',   mms: null,                 mymemory: 'ja',    dir: 'ltr' },
  { code: 'ko', name: 'Korean',     native: '한국어',       nllb: 'kor_Hang', whisper: 'korean',     mms: null,                 mymemory: 'ko',    dir: 'ltr' },
  { code: 'ru', name: 'Russian',    native: 'Русский',    nllb: 'rus_Cyrl', whisper: 'russian',    mms: 'Xenova/mms-tts-rus', mymemory: 'ru',    dir: 'ltr' },
  { code: 'hi', name: 'Hindi',      native: 'हिन्दी',       nllb: 'hin_Deva', whisper: 'hindi',      mms: 'Xenova/mms-tts-hin', mymemory: 'hi',    dir: 'ltr' },
];

const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));

export const getLang = (code) => byCode.get(code) || byCode.get('en');
export const hasLang = (code) => byCode.has(code);
export const langName = (code) => getLang(code).name;

/** Adds a language at runtime (used by advanced deployments). */
export function addLanguage(entry) {
  if (!entry || !entry.code || !entry.name) throw new Error('A language needs at least a code and a name.');
  const full = { native: entry.name, nllb: null, whisper: null, mms: null, mymemory: entry.code, dir: 'ltr', ...entry };
  if (byCode.has(full.code)) {
    Object.assign(byCode.get(full.code), full);
  } else {
    LANGUAGES.push(full);
    byCode.set(full.code, full);
  }
}
