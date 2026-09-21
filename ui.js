/* CAC Goodworks Audio Translator — small UI toolkit (no framework).
 * All text is inserted with textContent / text nodes, never innerHTML, so nothing typed or
 * loaded from a file can inject markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly']);

/** h('button', { class: 'btn', onclick: fn }, 'Label', icon('mic')) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (kid) => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}

/** Inline SVG icon from the sprite in index.html. */
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export const show = (el, on = true) => { if (el) el.hidden = !on; };

/* ---------------- Screen-reader announcements ---------------- */

export function announce(text) {
  const live = document.getElementById('sr-live');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 40);
}

/* ---------------- Toasts ---------------- */

const TOAST_ICON = { info: 'info', success: 'check', error: 'alert', warn: 'alert' };

export function toast(message, { kind = 'info', ms, action } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return null;
  const life = ms ?? (kind === 'error' ? 8000 : 4200);
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(TOAST_ICON[kind] || 'info'),
    h('span', { class: 'toast-text', text: message }),
    action ? h('button', { class: 'toast-action', type: 'button', text: action.label, onclick: () => { action.onClick(); close(); } }) : null,
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss message', onclick: () => close() }, icon('x')),
  );
  let timer = 0;
  function close() {
    clearTimeout(timer);
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 180);
  }
  host.append(t);
  while (host.children.length > 3) host.firstChild.remove();
  if (life > 0) timer = setTimeout(close, life);
  return { close };
}

/* ---------------- Dialogs ---------------- */

/**
 * Modal dialog. Resolves with the `value` of the chosen action, or null when dismissed.
 * actions: [{ label, value, kind: 'primary' | 'danger' | 'ghost' }]
 */
export function choiceDialog({ title, body, actions, dismissible = true }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    dlg.setAttribute('aria-labelledby', titleId);
    let result = null;
    const finish = (v) => { result = v; dlg.close(); };
    const btns = actions.map((a) => h('button', {
      class: `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : a.kind === 'ghost' ? 'btn-ghost' : ''}`.trim(),
      type: 'button',
      onclick: () => finish(a.value),
    }, a.label));
    const bodyEl = h('div', { class: 'dialog-body' }, typeof body === 'string' ? h('p', { text: body }) : body);
    dlg.append(
      h('h2', { class: 'dialog-title', id: titleId, text: title }),
      bodyEl,
      h('div', { class: 'dialog-actions' }, btns),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (previous && previous.focus) { try { previous.focus(); } catch (_) { /* ignore */ } }
      resolve(result);
    });
    dlg.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
    dlg.addEventListener('click', (e) => { if (dismissible && e.target === dlg) finish(null); });
    document.body.append(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    const first = btns.find((b) => b.classList.contains('btn-primary') || b.classList.contains('btn-danger')) || btns[0];
    if (first) first.focus();
  });
}

export async function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  const r = await choiceDialog({
    title,
    body: message,
    actions: [
      { label: cancelLabel, value: false, kind: 'ghost' },
      { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return r === true;
}

export function infoDialog({ title, body, closeLabel = 'Close' }) {
  return choiceDialog({ title, body, actions: [{ label: closeLabel, value: true, kind: 'primary' }] });
}

/* ---------------- Progress bar ---------------- */

/** Returns { el, set(percent|null) }. null shows a moving "working" state. */
export function progressBar(label) {
  const fill = h('div', { class: 'bar-fill' });
  const el = h('div', { class: 'bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  return {
    el,
    set(pct) {
      if (pct == null || !Number.isFinite(pct)) {
        el.classList.add('indeterminate');
        el.removeAttribute('aria-valuenow');
        fill.style.width = '';
      } else {
        el.classList.remove('indeterminate');
        const v = Math.max(0, Math.min(100, pct));
        el.setAttribute('aria-valuenow', String(Math.round(v)));
        fill.style.width = `${v}%`;
      }
    },
  };
}
