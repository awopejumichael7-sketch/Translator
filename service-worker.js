/* CAC Goodworks Audio Translator — service worker.
 *
 * Two small caches, and nothing else:
 *   SHELL   the app's own files, so the app opens offline. Replaced whenever VERSION changes.
 *   ENGINE  the pinned AI code (Transformers.js and its runtime files) fetched from jsDelivr, so the
 *           on-device engine can start offline. Safe to keep: every URL contains its exact version.
 *
 * AI MODEL FILES ARE NOT CACHED HERE. They are large, they belong to the person (who can see and remove
 * them under "AI models"), and Transformers.js keeps them in its own cache, "transformers-cache".
 */

const VERSION = '1.0.0'; // keep in sync with APP_CONFIG.version in settings.js
const PREFIX = 'cac-goodworks-audio-translator';
const SHELL_CACHE = `${PREFIX}-shell-v${VERSION}`;
const ENGINE_CACHE = `${PREFIX}-engine`; // the same name is cleared by "Clear all data" in Settings

const SHELL_FILES = [
  "./",
  "app.js",
  "apple-touch-icon.png",
  "audio.js",
  "common.js",
  "engine.js",
  "errors.js",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "icon.svg",
  "index.html",
  "languages.js",
  "manifest.json",
  "ml-client.js",
  "ml-worker.js",
  "models.js",
  "pipeline.js",
  "player.js",
  "settings.js",
  "speech.js",
  "storage.js",
  "style.css",
  "theme-init.js",
  "translator.js",
  "tts.js",
  "ui.js",
  "util.js",
  "view-history.js",
  "view-models.js",
  "view-settings.js",
  "view-translate.js",
  "youtube.js"
];

const ENGINE_URL = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:@huggingface\/transformers|onnxruntime-web)@/;

self.addEventListener('install', (event) => {
  // No skipWaiting here: an update waits until the person presses "Update" in the app.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(`${PREFIX}-shell-`) && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  else if (data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

async function fromShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  if (request.mode === 'navigate') {
    const page = (await cache.match('index.html')) || (await cache.match('./'));
    if (page) return page;
  }
  try {
    return await fetch(request);
  } catch (_) {
    return new Response('You are offline and this file has not been saved on this device yet.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function fromEngine(request) {
  const cache = await caches.open(ENGINE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request); // a network failure here is reported to the app, which explains it
  if (response.ok && response.type !== 'opaque') cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) event.respondWith(fromShell(request));
  else if (ENGINE_URL.test(request.url)) event.respondWith(fromEngine(request));
  // everything else (model files, the optional online translation service) goes straight to the network
});
