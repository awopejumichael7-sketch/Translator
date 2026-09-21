/* CAC Goodworks Audio Translator — translation.
 *
 * Engines, in the order "Automatic" considers them:
 *   1. the browser's built-in Translator (Chrome) — on-device, only if its language pack is installed
 *   2. a compact Opus-MT model for the pair (about 100 MB, downloaded once)
 *   3. NLLB-200 (about 900 MB, downloaded once) — covers every language here, including Yoruba
 *   4. MyMemory online service — only if the person switched "online translation" on
 *
 * Bible references (e.g. "John 3:16") and church terms are protected so they are not translated.
 */
import { AppError, throwIfAborted } from './errors.js';
import { getLang } from './languages.js';
import { escapeRegExp } from './util.js';
import { NLLB_ID, getModel, opusFor, nllbSupports, loadInto, localEngineSupported } from './models.js';
import { APP_CONFIG } from './settings.js';

/* ---------------- Protecting Bible references and church terms ---------------- */

const BOOKS = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth', 'Samuel', 'Kings', 'Chronicles',
  'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms', 'Psalm', 'Proverbs', 'Ecclesiastes', 'Song of Solomon', 'Song of Songs',
  'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum',
  'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans',
  'Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', 'Thessalonians', 'Timothy', 'Titus', 'Philemon',
  'Hebrews', 'James', 'Peter', 'Jude', 'Revelations', 'Revelation',
];
const ABBREVIATIONS = [
  'Gen', 'Exo', 'Ex', 'Lev', 'Num', 'Deut', 'Dt', 'Josh', 'Judg', 'Sam', 'Kgs', 'Chr', 'Neh', 'Esth', 'Ps', 'Psa', 'Prov',
  'Eccl', 'Isa', 'Jer', 'Lam', 'Ezek', 'Dan', 'Hos', 'Obad', 'Mic', 'Nah', 'Hab', 'Zeph', 'Hag', 'Zech', 'Mal', 'Matt',
  'Mt', 'Mk', 'Lk', 'Jn', 'Rom', 'Cor', 'Gal', 'Eph', 'Phil', 'Col', 'Thess', 'Tim', 'Tit', 'Phlm', 'Heb', 'Jas', 'Pet', 'Rev',
];

const BOOK_ALT = [...BOOKS, ...ABBREVIATIONS]
  .sort((a, b) => b.length - a.length)
  .map((b) => escapeRegExp(b).replace(/ /g, '\\s+'))
  .join('|');

/* [optional 1-3] Book[.] chapter:verse[-verse][, verse] — a chapter:verse is required, so words like "Job" or "Mark" are not caught by accident.
   "Psalm 23" is also recognised. */
const REF_RE = new RegExp(
  '\\b((?:[1-3]\\s?)?)(' + BOOK_ALT + ')(\\.?)\\s?(\\d{1,3}\\s?:\\s?\\d{1,3}(?:\\s?[-–]\\s?\\d{1,3})?(?:\\s?,\\s?\\d{1,3}(?::\\d{1,3})?)*)',
  'g',
);
const PSALM_RE = /\b(Psalms?)\s(\d{1,3})\b(?!\s?:)/g;

const TOKEN_RE = /\[\[(\d+)\]\]/g;

/** Replaces protected text with [[n]] markers. Returns { text, map }. */
export function protectText(text, settings) {
  const map = [];
  let out = String(text);
  const add = (original) => {
    const n = map.length + 1;
    map.push({ n, original });
    return `[[${n}]]`;
  };
  if (settings.protectBibleRefs) {
    out = out.replace(REF_RE, (m, pre, book, dot, nums) => (
      settings.translateBibleBooks ? `${pre}${book}${dot} ${add(nums)}` : add(m)
    ));
    if (!settings.translateBibleBooks) out = out.replace(PSALM_RE, (m) => add(m));
  }
  const terms = [...(settings.protectedTerms || [])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const t of terms) {
    const lead = /^\w/.test(t) ? '\\b' : '';
    const trail = /\w$/.test(t) ? '\\b' : '';
    out = out.replace(new RegExp(lead + escapeRegExp(t) + trail, 'gi'), (m) => add(m));
  }
  return { text: out, map };
}

function restoreTokens(text, entries) {
  let ok = true;
  let out = text;
  for (const e of entries) {
    const re = new RegExp('\\[\\s*\\[\\s*' + e.n + '\\s*\\]\\s*\\]', 'g');
    const found = (out.match(re) || []).length;
    if (found !== 1) ok = false;
    out = out.replace(re, () => e.original);
  }
  return { text: out, ok };
}

/** Splits into sentences (no look-behind, so older browsers work too). */
export function splitSentences(text) {
  const out = [];
  const re = /[^.!?…\n]+(?:[.!?…]+["')\]]*|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

function batchSentences(list, maxChars) {
  const batches = [];
  let cur = '';
  for (const s of list) {
    if (cur && cur.length + s.length + 1 > maxChars) { batches.push(cur); cur = s; } else { cur = cur ? `${cur} ${s}` : s; }
  }
  if (cur) batches.push(cur);
  return batches;
}

/* ---------------- Engine planning ---------------- */

const onlineAllowed = (s) => !!(APP_CONFIG.enableOnlineTranslation && s.allowOnlineTranslation);
const lowMemory = () => typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4;

export async function chromeAvailability(src, tgt) {
  try {
    if (typeof self === 'undefined' || !('Translator' in self)) return { supported: false, state: 'unsupported' };
    // Some browsers never answer this call. Give it a moment, then carry on with the on-device models.
    const state = await Promise.race([
      self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt }),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2500)),
    ]);
    if (state === 'timeout') return { supported: false, state: 'unsupported' };
    return { supported: true, state };
  } catch (_) {
    return { supported: false, state: 'unsupported' };
  }
}

const ENGINE_LABEL = {
  chrome: 'Built-in browser translator (on this device)',
  opus: 'Compact on-device model (Opus-MT)',
  nllb: 'On-device model (NLLB-200)',
  mymemory: 'Online service (MyMemory) — text is sent over the internet',
};

function candidate(engine, model, ready) {
  return {
    engine,
    model: model || null,
    label: ENGINE_LABEL[engine],
    online: engine === 'mymemory',
    needs: model && !ready.has(model.id) ? [model] : [],
    warning: engine === 'nllb' && lowMemory()
      ? 'This device reports less than 4 GB of memory. The large translation model may not run reliably here.'
      : '',
  };
}

/**
 * Chooses the translation engine. `ready` is a Set of model ids already downloaded.
 * Throws an AppError when nothing free is available for the language pair.
 */
export async function planTranslation(src, tgt, settings, ready) {
  if (src === tgt) {
    throw new AppError('SAME_LANG', 'Choose two different languages.', { retryable: false, hint: 'The source and target language are the same.' });
  }
  const chrome = await chromeAvailability(src, tgt);
  const opus = opusFor(src, tgt);
  const local = localEngineSupported();
  const cands = [];
  const autoChrome = chrome.state === 'available';
  const anyChrome = chrome.supported && chrome.state !== 'unavailable';
  if (settings.mtEngine === 'chrome' ? anyChrome : autoChrome) cands.push(candidate('chrome', null, ready));
  if (local && opus) cands.push(candidate('opus', opus, ready));
  if (local && nllbSupports(src, tgt)) cands.push(candidate('nllb', getModel(NLLB_ID), ready));
  if (onlineAllowed(settings)) cands.push(candidate('mymemory', null, ready));
  const by = (e) => cands.find((c) => c.engine === e);

  const pref = settings.mtEngine;
  if (pref !== 'auto') {
    const c = by(pref);
    if (!c) {
      throw new AppError('MT_UNAVAILABLE', `The selected translation engine cannot translate ${getLang(src).name} to ${getLang(tgt).name} on this device.`, {
        hint: 'Open Settings and set the translation engine to Automatic.',
        retryable: false,
      });
    }
    return c;
  }
  if (by('chrome')) return by('chrome');
  for (const e of ['opus', 'nllb']) { const c = by(e); if (c && !c.needs.length) return c; }
  if (by('opus')) return by('opus');
  if (by('nllb') && !(lowMemory() && by('mymemory'))) return by('nllb');
  if (by('mymemory')) return by('mymemory');
  throw new AppError('MT_UNAVAILABLE', `Translation from ${getLang(src).name} to ${getLang(tgt).name} is not available on this device.`, {
    hint: local
      ? 'This language pair has no free on-device model here. You can allow the optional online service in Settings.'
      : 'This browser cannot run on-device models. Try a current version of Chrome, Edge, Firefox or Safari.',
    retryable: false,
  });
}

/* ---------------- Engines ---------------- */

async function myMemory(text, src, tgt, signal) {
  const pair = `${getLang(src).mymemory}|${getLang(tgt).mymemory}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
  let res;
  try { res = await fetch(url, { signal }); } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new AppError('NETWORK', 'Internet connection required for this processing method.', { cause: e });
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* handled below */ }
  const translated = data && data.responseData && data.responseData.translatedText;
  if (/MYMEMORY WARNING|USED ALL AVAILABLE/i.test(String(translated || '')) || res.status === 429) {
    throw new AppError('MT_QUOTA', 'The free daily limit of the online translation service has been reached.', {
      hint: 'Try again tomorrow, or use an on-device model in AI Models.',
      retryable: false,
    });
  }
  if (!res.ok || !translated) {
    throw new AppError('MT_ONLINE', 'The online translation service did not return a translation.', { hint: data && data.responseDetails ? String(data.responseDetails).slice(0, 160) : '' });
  }
  return String(translated);
}

async function makeEngine(plan, { src, tgt, client, signal, onProgress }) {
  if (plan.engine === 'chrome') {
    const t = await self.Translator.create({
      sourceLanguage: src,
      targetLanguage: tgt,
      signal,
      monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress && onProgress(Math.round(e.loaded * 100), 'Downloading the browser language pack…')); },
    });
    return { translate: (s) => t.translate(s), maxChars: 900, close: () => { try { t.destroy(); } catch (_) { /* ignore */ } } };
  }
  if (plan.engine === 'opus' || plan.engine === 'nllb') {
    await loadInto(client, plan.model, {
      signal,
      onProgress: (p) => onProgress && onProgress(p.total ? Math.round((p.loaded / p.total) * 100) : null, `Downloading ${plan.model.label}…`),
    });
    const options = plan.engine === 'nllb'
      ? { src_lang: getLang(src).nllb, tgt_lang: getLang(tgt).nllb, max_new_tokens: 512 }
      : { max_new_tokens: 512 };
    return {
      translate: async (s) => (await client.call('run', { task: 'translation', model: plan.model.id, text: s, options }, { signal })).text,
      maxChars: 420,
      close: () => {},
    };
  }
  return { translate: (s) => myMemory(s, src, tgt, signal), maxChars: 380, close: () => {} };
}

const clean = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * Translates text. Paragraph breaks are kept. Protected terms and Bible references come back exactly as written.
 * `onProgress(percent|null, detail)` reports download and translation progress.
 */
export async function translateText({ text, src, tgt, plan, settings, client, signal, onProgress }) {
  const raw = String(text || '').trim();
  if (!raw) throw new AppError('NO_TEXT', 'There is no text to translate.', { retryable: false, hint: 'Add or paste some text in the transcript box.' });
  const engine = await makeEngine(plan, { src, tgt, client, signal, onProgress });
  try {
    const paragraphs = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const prepared = paragraphs.map((p) => {
      const { text: prot, map } = protectText(p, settings);
      return { map, batches: batchSentences(splitSentences(prot), engine.maxChars) };
    });
    const totalBatches = prepared.reduce((n, p) => n + p.batches.length, 0) || 1;
    let done = 0;

    const translateBatch = async (batch, map) => {
      const out = clean(await engine.translate(batch));
      const ids = [...batch.matchAll(TOKEN_RE)].map((m) => Number(m[1]));
      if (!ids.length) return out;
      const entries = ids.map((n) => map.find((x) => x.n === n)).filter(Boolean);
      const r = restoreTokens(out, entries);
      if (r.ok) return r.text;
      // The engine altered a marker: translate the pieces around each protected item separately.
      let res = '';
      for (const part of batch.split(/(\[\[\d+\]\])/)) {
        const tm = part.match(/^\[\[(\d+)\]\]$/);
        if (tm) { const e = map.find((x) => x.n === Number(tm[1])); res += e ? e.original : ''; continue; }
        if (/\p{L}/u.test(part)) {
          const lead = /^\s/.test(part) ? ' ' : '';
          const trail = /\s$/.test(part) ? ' ' : '';
          res += lead + clean(await engine.translate(part.trim())) + trail;
        } else {
          res += part;
        }
      }
      return res.replace(/\s+/g, ' ').trim();
    };

    const outParas = [];
    for (const p of prepared) {
      const outs = [];
      for (const b of p.batches) {
        throwIfAborted(signal);
        outs.push(await translateBatch(b, p.map));
        done++;
        if (onProgress) onProgress(Math.round((done / totalBatches) * 100), `Translating… ${done} of ${totalBatches}`);
      }
      outParas.push(outs.join(' '));
    }
    return outParas.join('\n\n');
  } finally {
    engine.close();
  }
}
