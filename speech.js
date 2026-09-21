/* CAC Goodworks Audio Translator — speech recognition (Whisper, on the device).
 * Long audio is cut into pieces of at most 30 seconds, quiet moments are skipped, and
 * each piece is recognised in turn so progress can be shown honestly.
 */
import { AppError, throwIfAborted } from './errors.js';
import { getLang } from './languages.js';
import { splitChunks, rms } from './audio.js';

const SILENCE_RMS = 0.0015;

function cleanPiece(text) {
  return String(text || '')
    .replace(/\[\s*(?:BLANK[_ ]AUDIO|silence|music|applause)\s*\]/gi, ' ')
    .replace(/\(\s*(?:silence|music|applause)\s*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentences(text) {
  return text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
}

/** Drops obvious "stuck loop" repeats (the same sentence more than twice in a row). */
function dropLoops(list) {
  const out = [];
  let run = 0;
  for (const s of list) {
    if (out.length && out[out.length - 1].toLowerCase() === s.toLowerCase()) {
      run++;
      if (run >= 2) continue;
    } else {
      run = 0;
    }
    out.push(s);
  }
  return out;
}

export function formatTranscript(parts) {
  const list = dropLoops(sentences(parts.filter(Boolean).join(' ')));
  const paras = [];
  for (let i = 0; i < list.length; i += 4) paras.push(list.slice(i, i + 4).join(' '));
  return paras.join('\n\n');
}

/**
 * @param client   a loaded WorkerClient
 * @param model    entry from ASR_MODELS (already loaded into the worker)
 * @param samples  Float32Array, mono, 16 kHz
 * @param opts     { langCode, signal, onChunk(i,total,status), onProgress(fraction) }
 */
export async function transcribeSamples(client, model, samples, { langCode, signal, onChunk, onProgress } = {}) {
  const chunks = splitChunks(samples);
  const total = chunks.length;
  const parts = [];
  let spoken = 0;
  for (let i = 0; i < total; i++) {
    throwIfAborted(signal);
    const { start, end } = chunks[i];
    if (rms(samples, start, end) < SILENCE_RMS) {
      if (onChunk) onChunk(i, total, 'skipped');
      if (onProgress) onProgress((i + 1) / total);
      continue;
    }
    if (onChunk) onChunk(i, total, 'processing');
    const audio = samples.slice(start, end);
    const options = { chunk_length_s: 30, task: 'transcribe', return_timestamps: false };
    if (model.multilingual) options.language = getLang(langCode).whisper;
    const out = await client.call('run', { task: model.task, model: model.id, audio, options }, { signal, transfer: [audio.buffer] });
    const piece = cleanPiece(out && out.text);
    if (piece) { parts.push(piece); spoken++; }
    if (onChunk) onChunk(i, total, 'done');
    if (onProgress) onProgress((i + 1) / total);
  }
  if (!spoken) {
    throw new AppError('NO_SPEECH', 'No speech was detected in this audio.', {
      hint: 'Check that the recording is not silent, then try again. You can also type or paste the text yourself.',
      retryable: false,
    });
  }
  return formatTranscript(parts);
}
