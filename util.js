/* CAC Goodworks Audio Translator — small shared helpers (no DOM needed except downloadBlob). */

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const digits = i === 0 ? 0 : n >= 100 ? 0 : 1;
  return `${n.toFixed(digits)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatMB(mb) {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function fileExt(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 && i < s.length - 1 ? s.slice(i + 1).toLowerCase() : '';
}

/** Makes a user-supplied filename safe: no paths, no reserved characters, no hidden/traversal names. */
export function sanitizeFilename(name, fallback = 'file') {
  let s = String(name == null ? '' : name).normalize('NFC');
  s = s.split(/[\\/]/).pop();
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '');
  const dot = s.lastIndexOf('.');
  let base = dot > 0 ? s.slice(0, dot) : s;
  let ext = dot > 0 ? s.slice(dot + 1) : '';
  ext = ext.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
  base = base.replace(/[. ]+$/, '').slice(0, 80).trim();
  if (!base) base = fallback;
  return ext ? `${base}.${ext}` : base;
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, ms = 150) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Triggers a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

/** UTF-8 text file with BOM so Yoruba tone marks open correctly in older Windows editors. */
export function textBlob(text) {
  return new Blob(['\uFEFF', String(text)], { type: 'text/plain;charset=utf-8' });
}

/** Language names contain spaces (e.g. "Chinese") — keep file names tidy. */
export function fileSafeName(s) {
  return String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Text';
}
