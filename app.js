/* CAC Goodworks Audio Translator — app bootstrap.
 * Router, home screen, connectivity chip, install prompt, offline and update handling.
 */
import { APP_CONFIG, loadSettings, getSettings, applyAppearance, onSettings } from './settings.js';
import { getLang } from './languages.js';
import { isAbort } from './errors.js';
import { $, $$, h, icon, toast, infoDialog, announce } from './ui.js';
import { initLanguageControls, on } from './common.js';
import { initTranslate, begin, hasInput, translateNow, inputName } from './view-translate.js';
import { initHistory, renderHistory } from './view-history.js';
import { initModels, renderModels } from './view-models.js';
import { initSettings, renderSettings } from './view-settings.js';

const ROUTES = {
  home: 'Home', translate: 'Translate', history: 'History', models: 'AI models', settings: 'Settings', help: 'Help', about: 'About and privacy',
};
let firstRoute = true;

/* ---------------- Router ---------------- */

function currentRoute() {
  const r = (location.hash.replace(/^#\/?/, '') || 'home').split(/[?/]/)[0];
  return ROUTES[r] ? r : 'home';
}

function showRoute() {
  const route = currentRoute();
  for (const sec of $$('.view')) sec.hidden = sec.dataset.view !== route;
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = route === 'home' ? APP_CONFIG.name : `${ROUTES[route]} — ${APP_CONFIG.name}`;
  if (route === 'history') renderHistory();
  if (route === 'models') renderModels();
  if (route === 'settings') renderSettings();
  window.scrollTo(0, 0);
  if (!firstRoute) { $('#main').focus({ preventScroll: true }); announce(ROUTES[route]); }
  firstRoute = false;
}

/* ---------------- Home ---------------- */

function buildHeroBars() {
  const host = $('#hero-bars');
  const n = 46;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const env = Math.sin(Math.PI * ((t * 2) % 1));
    const wobble = Math.abs(Math.sin(i * 1.31) * Math.cos(i * 0.47) + Math.sin(i * 0.23) * 0.5);
    const height = 12 + 78 * Math.min(1, wobble) * (0.5 + 0.5 * env);
    const bar = h('span', { class: t >= 0.5 ? 'to' : '' });
    bar.style.height = `${Math.round(height)}%`;
    bar.style.animationDelay = `${i * 16}ms`;
    host.append(bar);
  }
}

function updateHeroPair(s = getSettings()) {
  $('#hero-from').textContent = getLang(s.srcLang).native;
  $('#hero-to').textContent = getLang(s.tgtLang).native;
}

function initHome() {
  buildHeroBars();
  updateHeroPair();
  $('#home-record').addEventListener('click', () => begin('record'));
  $('#home-upload').addEventListener('click', () => begin('upload'));
  $('#home-youtube').addEventListener('click', () => begin('youtube'));
  $('#home-go').addEventListener('click', () => {
    if (hasInput()) { translateNow(); return; }
    $('#home-status').textContent = 'Choose or record some audio first. Use one of the three options above.';
    toast('Choose or record some audio first.', { kind: 'warn' });
  });
  on('input-changed', (job) => {
    $('#home-status').textContent = job ? `Ready: ${inputName()}` : '';
  });
}

/* ---------------- Connectivity ---------------- */

function updateNet() {
  const online = navigator.onLine !== false;
  for (const chip of $$('[data-net-chip]')) {
    chip.classList.toggle('is-offline', !online);
    chip.replaceChildren(icon(online ? 'wifi' : 'wifi-off'), online ? 'Online' : 'Offline');
  }
}

function initNet() {
  updateNet();
  window.addEventListener('online', () => { updateNet(); toast('Back online.', { kind: 'success' }); });
  window.addEventListener('offline', () => { updateNet(); toast('You are offline. Models already on this device still work.', { kind: 'warn' }); });
}

/* ---------------- Install ---------------- */

let deferredInstall = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function updateInstallUi() {
  const canOffer = !isStandalone() && (!!deferredInstall || isIOS());
  for (const b of $$('[data-install]')) {
    b.hidden = !canOffer;
    if (b.classList.contains('btn')) b.textContent = isIOS() && !deferredInstall ? 'Add to Home Screen' : 'Install app';
  }
}

async function install() {
  if (deferredInstall) {
    deferredInstall.prompt();
    const choice = await deferredInstall.userChoice.catch(() => null);
    deferredInstall = null;
    updateInstallUi();
    if (choice && choice.outcome === 'accepted') toast('Installing the app…', { kind: 'success' });
    return;
  }
  if (isIOS()) {
    await infoDialog({
      title: 'Add to Home Screen',
      body: h('ol', { class: 'steps' },
        h('li', { text: 'Open this page in Safari.' }),
        h('li', { text: 'Tap the Share button in the toolbar.' }),
        h('li', { text: 'Choose Add to Home Screen, then tap Add.' }),
      ),
    });
  }
}

function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; updateInstallUi(); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; updateInstallUi(); toast('App installed.', { kind: 'success' }); });
  for (const b of $$('[data-install]')) b.addEventListener('click', install);
  updateInstallUi();
}

/* ---------------- Offline support and updates ---------------- */

let registration = null;
let updateRequested = false;

function showUpdateBanner() { $('#update-banner').hidden = false; }

async function initServiceWorker() {
  $('#btn-update').addEventListener('click', () => {
    if (registration && registration.waiting) { updateRequested = true; registration.waiting.postMessage({ type: 'SKIP_WAITING' }); }
  });
  on('check-update', async () => {
    if (!registration) { toast('Updates are checked automatically once the app is opened from its web address.'); return; }
    try { await registration.update(); } catch (_) { toast('Could not check for updates right now.', { kind: 'warn' }); return; }
    setTimeout(() => {
      if (registration.waiting) showUpdateBanner();
      else if (registration.installing) toast('Downloading an update…');
      else toast('You have the latest version.', { kind: 'success' });
    }, 1500);
  });
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) location.reload(); });
  try {
    registration = await navigator.serviceWorker.register('service-worker.js');
    if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
      });
    });
  } catch (_) {
    /* The app still works; it just will not open offline. */
  }
}

/* ---------------- About page ---------------- */

function initAbout() {
  $('#about-purpose').textContent = APP_CONFIG.purpose;
  $('#about-version').textContent = APP_CONFIG.version;
  const list = $('#contact-list');
  const c = APP_CONFIG.contact || {};
  const rows = [];
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || '')) rows.push(h('li', {}, 'Email: ', h('a', { href: `mailto:${c.email}`, text: c.email })));
  if (/^[+\d][\d\s()-]{5,}$/.test(c.phone || '')) rows.push(h('li', {}, 'Phone: ', h('a', { href: `tel:${c.phone.replace(/[^+\d]/g, '')}`, text: c.phone })));
  try {
    const u = new URL(c.website || '');
    if (u.protocol === 'https:' || u.protocol === 'http:') rows.push(h('li', {}, 'Website: ', h('a', { href: u.href, rel: 'noopener noreferrer', target: '_blank', text: u.hostname })));
  } catch (_) { /* no website set */ }
  if (c.address) rows.push(h('li', { text: `Address: ${c.address}` }));
  if (!rows.length) rows.push(h('li', { text: 'Contact details have not been added yet. The person who publishes this app can add them in settings.js.' }));
  list.replaceChildren(...rows);
}

/* ---------------- Start ---------------- */

function boot() {
  loadSettings();
  applyAppearance();
  initLanguageControls();
  initHome();
  initTranslate();
  initHistory();
  initModels();
  initSettings();
  initAbout();
  initNet();
  initInstall();
  initServiceWorker();

  onSettings((s) => { applyAppearance(s); updateHeroPair(s); });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance());

  window.addEventListener('hashchange', showRoute);
  if (!location.hash) history.replaceState(null, '', '#/home');
  showRoute();

  window.addEventListener('unhandledrejection', (e) => {
    if (isAbort(e.reason)) return;
    console.error(e.reason);
  });
}

boot();
