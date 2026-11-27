/* musicVer app shell service worker. Network-first for page assets, never intercepts API calls. */
const CACHE = 'musicver-shell-v1190';
const SHELL = [
  './',
  './index.html',
  './musicatlas-guide.html',
  './manifest.webmanifest',
  './pwa/icon-192.png',
  './pwa/icon-512.png',
  './guides/step-1-mcp.svg',
  './guides/step-2-folder.svg',
  './guides/step-3-login.svg',
  './guides/step-4-deploy.svg',
  './guides/step-5-app.svg',
  './assets/icons/angle-left.svg',
  './assets/icons/angle-right.svg',
  './assets/icons/bookmark-after.svg',
  './assets/icons/bookmark-before.svg',
  './assets/icons/cross-circle.svg',
  './assets/icons/feedback.svg',
  './assets/icons/home.svg',
  './assets/icons/island-icon.svg',
  './assets/icons/lyrics.svg',
  './assets/icons/pause.svg',
  './assets/icons/play.svg',
  './assets/icons/plus-hexagon.svg',
  './assets/icons/radio-alt.svg',
  './assets/icons/shuffle.svg',
  './assets/icons/volume.svg',
  './assets/icons/volume-slash.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') >= 0) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
  );
});
