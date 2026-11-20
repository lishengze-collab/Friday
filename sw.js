const CACHE = 'sidechat-shell-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './app.bundle.gz.b64', './enhancements.js', './manifest.webmanifest', './icon.svg', './icon.svg?v=2', './icon.png', './icon.png?v=2', './icon-192.png', './icon-192.png?v=2', './icon-512.png', './icon-512.png?v=2', './worker.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response;
  }).catch(() => caches.match('./index.html'))));
});