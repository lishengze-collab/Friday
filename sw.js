
const CACHE = 'friday-shell-v14-20261120';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(key =>
          key.startsWith('friday-shell-') && key !== CACHE
        )
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    try {
      const response = await fetch(
        new Request(request, { cache: 'no-store' })
      );

      if (response && response.ok) {
        await cache.put(request, response.clone());
      }

      return response;
    } catch (error) {
      const cached = await cache.match(request);

      if (cached) return cached;

      if (request.mode === 'navigate') {
        const fallback = await cache.match(
          new URL('./index.html', self.registration.scope).href
        );

        if (fallback) return fallback;
      }

      return new Response(
        'Offline. No cached copy available.',
        {
          status: 503,
          headers: {
            'Content-Type': 'text/plain;charset=utf-8'
          }
        }
      );
    }
  })());
});
