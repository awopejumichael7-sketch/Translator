/* CAC Goodworks Audio Translator — player component.
 * One control set (play/pause, stop, waveform seek, time, volume, mute, speed) for both the original
 * media and the translated voice. It talks to an "adapter": MediaAdapter (below) or TtsPlayer (tts.js).
 */
import { h, icon } from './ui.js';
import { formatDuration } from './util.js';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Wraps an <audio> or <video> element in the adapter interface. */
export class MediaAdapter extends EventTarget {
  constructor(el) {
    super();
    this.el = el;
    this.state = 'idle';
    this.canSeek = true;
    this.ready = true;
    const emit = (type, detail) => this.dispatchEvent(new CustomEvent(type, { detail }));
    const setState = (s) => { this.state = s; emit('state', s); };
    const time = () => emit('time', { t: el.currentTime, d: el.duration, p: el.duration ? el.currentTime / el.duration : 0 });
    this._h = {
      play: () => setState('playing'),
      pause: () => { if (!el.ended) setState(el.currentTime > 0 ? 'paused' : 'idle'); },
      ended: () => setState('ended'),
      timeupdate: time,
      loadedmetadata: time,
      durationchange: time,
      error: () => emit('error', new Error('The media could not be played.')),
    };
    for (const [k, fn] of Object.entries(this._h)) el.addEventListener(k, fn);
  }

  play() { return this.el.play().catch(() => this.dispatchEvent(new CustomEvent('error', { detail: new Error('Playback was blocked or failed.') }))); }
  pause() { this.el.pause(); }
  stop() { this.el.pause(); this.el.currentTime = 0; this.state = 'idle'; this.dispatchEvent(new CustomEvent('state', { detail: 'idle' })); }
  seek(t) { if (Number.isFinite(t)) this.el.currentTime = Math.max(0, t); }
  getTime() { return this.el.currentTime || 0; }
  getDuration() { return Number.isFinite(this.el.duration) ? this.el.duration : NaN; }
  setRate(r) { this.el.playbackRate = r; }
  setVolume(v) { this.el.volume = v; }
  setMuted(m) { this.el.muted = m; }
  detach() { for (const [k, fn] of Object.entries(this._h)) this.el.removeEventListener(k, fn); }
}

/* ---------------- Waveform drawing ---------------- */

function cssColor(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function drawWave(canvas, peaks, progress) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const hgt = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== hgt) canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, hgt);
  const base = cssColor(canvas, '--wave', '#9db8a8');
  const played = cssColor(canvas, '--wave-played', '#b8871b');
  const mid = hgt / 2;
  if (!peaks || !peaks.length) {
    // No waveform (browser voice): draw a plain track with a progress fill.
    ctx.fillStyle = base;
    ctx.fillRect(0, mid - dpr, w, 2 * dpr);
    ctx.fillStyle = played;
    ctx.fillRect(0, mid - 2 * dpr, w * progress, 4 * dpr);
    return;
  }
  const bar = Math.max(2, Math.round(3 * dpr));
  const gap = Math.max(1, Math.round(1.5 * dpr));
  const n = Math.max(1, Math.floor(w / (bar + gap)));
  for (let i = 0; i < n; i++) {
    const idx = Math.min(peaks.length - 1, Math.floor((i / n) * peaks.length));
    const amp = Math.max(0.06, peaks[idx]);
    const bh = Math.max(2 * dpr, amp * (hgt - 4 * dpr));
    ctx.fillStyle = i / n < progress ? played : base;
    ctx.fillRect(i * (bar + gap), mid - bh / 2, bar, bh);
  }
}

/**
 * @param {{adapter, peaks?:Float32Array|null, label:string, playText?:string}} opts
 * @returns {{el:HTMLElement, setAdapter(a), setPeaks(p), destroy()}}
 */
export function createPlayer({ adapter, peaks = null, label = 'Audio', playText = '' }) {
  let ad = adapter;
  let pk = peaks;
  let progress = 0;
  let listeners = [];

  const canvas = h('canvas', {
    class: 'wave', role: 'slider', tabindex: '0', 'aria-label': `${label} position`,
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
  });
  const playBtn = h('button', { class: playText ? 'btn btn-primary player-play' : 'icon-btn icon-btn-solid player-play', type: 'button', 'aria-label': `Play ${label}` });
  const stopBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Stop ${label}` }, icon('stop'));
  const time = h('span', { class: 'player-time', 'aria-hidden': 'true', text: '0:00 / 0:00' });
  const muteBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Mute' }, icon('volume'));
  const vol = h('input', { class: 'player-vol', type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume' });
  const speed = h('select', { class: 'player-speed', 'aria-label': 'Playback speed' },
    SPEEDS.map((s) => h('option', { value: String(s), selected: s === 1, text: `${s}×` })));
  const note = h('p', { class: 'player-note', hidden: true });

  const el = h('div', { class: 'player' },
    h('div', { class: 'wave-wrap' }, canvas),
    h('div', { class: 'player-row' },
      playBtn, stopBtn, time,
      h('span', { class: 'grow' }),
      muteBtn, vol, speed,
    ),
    note,
  );

  const setPlayFace = (playing) => {
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'), ...(playText ? [document.createTextNode(playing ? 'PAUSE' : playText)] : []));
    playBtn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${label}`);
  };
  setPlayFace(false);

  const redraw = () => drawWave(canvas, pk, progress);

  const setProgress = (p, t, d) => {
    progress = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0));
    canvas.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    if (Number.isFinite(d) && d > 0) {
      const tt = Number.isFinite(t) ? t : 0;
      time.textContent = `${formatDuration(tt)} / ${formatDuration(d)}`;
      canvas.setAttribute('aria-valuetext', `${formatDuration(tt)} of ${formatDuration(d)}`);
    } else {
      time.textContent = `${Math.round(progress * 100)}%`;
      canvas.setAttribute('aria-valuetext', `${Math.round(progress * 100)} percent`);
    }
    redraw();
  };

  const seekFromEvent = (ev) => {
    if (!ad || !ad.canSeek) return;
    const r = canvas.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const d = ad.getDuration();
    if (Number.isFinite(d)) { ad.seek(p * d); setProgress(p, p * d, d); }
  };
  let dragging = false;
  canvas.addEventListener('pointerdown', (ev) => { dragging = true; canvas.setPointerCapture(ev.pointerId); seekFromEvent(ev); });
  canvas.addEventListener('pointermove', (ev) => { if (dragging) seekFromEvent(ev); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('keydown', (ev) => {
    if (!ad || !ad.canSeek) return;
    const d = ad.getDuration();
    if (!Number.isFinite(d)) return;
    const t = ad.getTime();
    const step = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' ? 5 : 15;
    let n = null;
    if (ev.key === 'ArrowLeft' || ev.key === 'PageDown') n = t - step;
    else if (ev.key === 'ArrowRight' || ev.key === 'PageUp') n = t + step;
    else if (ev.key === 'Home') n = 0;
    else if (ev.key === 'End') n = d;
    if (n == null) return;
    ev.preventDefault();
    n = Math.max(0, Math.min(d, n));
    ad.seek(n);
    setProgress(n / d, n, d);
  });

  playBtn.addEventListener('click', () => {
    if (!ad) return;
    if (ad.state === 'playing') ad.pause(); else ad.play();
  });
  stopBtn.addEventListener('click', () => { if (ad) ad.stop(); setProgress(0, 0, ad ? ad.getDuration() : NaN); });
  vol.addEventListener('input', () => { if (ad) { ad.setVolume(Number(vol.value)); } });
  muteBtn.addEventListener('click', () => {
    if (!ad) return;
    const muted = muteBtn.getAttribute('aria-pressed') !== 'true';
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    muteBtn.replaceChildren(icon(muted ? 'mute' : 'volume'));
    ad.setMuted(muted);
  });
  speed.addEventListener('change', () => { if (ad) ad.setRate(Number(speed.value)); });

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => redraw()) : null;
  if (ro) ro.observe(canvas);

  function bind(a) {
    listeners.forEach(([t, fn]) => ad && ad.removeEventListener(t, fn));
    listeners = [];
    ad = a;
    if (!ad) return;
    const onState = (e) => {
      setPlayFace(e.detail === 'playing');
      if (e.detail === 'ended') setProgress(1, ad.getDuration(), ad.getDuration());
      if (e.detail === 'idle') setProgress(0, 0, ad.getDuration());
    };
    const onTime = (e) => setProgress(e.detail.p, e.detail.t, e.detail.d);
    ad.addEventListener('state', onState);
    ad.addEventListener('time', onTime);
    listeners = [['state', onState], ['time', onTime]];
    ad.setRate(Number(speed.value));
    ad.setVolume(Number(vol.value));
    setPlayFace(ad.state === 'playing');
    canvas.classList.toggle('no-seek', !ad.canSeek);
    if (!ad.canSeek) canvas.setAttribute('aria-disabled', 'true'); else canvas.removeAttribute('aria-disabled');
    const d = ad.getDuration();
    setProgress(0, 0, d);
  }
  bind(ad);
  requestAnimationFrame(redraw);

  return {
    el,
    setAdapter: bind,
    setPeaks(p) { pk = p; redraw(); },
    setNote(text) { note.textContent = text || ''; note.hidden = !text; },
    setSpeed(v) { speed.value = String(v); if (ad) ad.setRate(Number(v)); },
    redraw,
    destroy() {
      listeners.forEach(([t, fn]) => ad && ad.removeEventListener(t, fn));
      listeners = [];
      if (ro) ro.disconnect();
      el.remove();
    },
  };
}
