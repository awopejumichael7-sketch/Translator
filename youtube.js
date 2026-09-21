/* CAC Goodworks Audio Translator — YouTube links.
 * This app never downloads or extracts audio from YouTube. It only recognises a link
 * and tells the person how to proceed legally.
 */
export const YOUTUBE_MESSAGE =
  'For YouTube videos, please download or save the audio/video legally using a method permitted by YouTube and then upload the file here.';

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Returns { valid, id } for a YouTube link. Anything else is not valid. */
export function parseYouTube(input) {
  let raw = String(input || '').trim();
  if (!raw) return { valid: false, id: '' };
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch (_) { return { valid: false, id: '' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { valid: false, id: '' };
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return { valid: false, id: '' };
  let id = '';
  if (host.endsWith('youtu.be')) {
    id = u.pathname.split('/').filter(Boolean)[0] || '';
  } else if (u.pathname === '/watch') {
    id = u.searchParams.get('v') || '';
  } else {
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    id = m ? m[1] : '';
  }
  return ID_RE.test(id) ? { valid: true, id } : { valid: false, id: '' };
}
