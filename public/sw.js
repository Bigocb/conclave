/* Conclave Dashboard — Service Worker
   Version: 1.0.0
   Cache-first for static assets, network-first for API calls. */

const CACHE_NAME = 'conclave-v1';
const STATIC_ASSETS = [
  '/dashboard.html',
  '/dashboard.css',
  '/dashboard.js',
  '/manifest.json',
  '/favicon.svg',
];

// CDN assets to cache after first load
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap',
  'https://unpkg.com/lucide@latest',
];

// Install: pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for static, network-first for API, stale-while-revalidate for CDN
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — network first, never cache
  if (url.pathname.startsWith('/v1/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ status: 'error', error: { code: 'OFFLINE', message: 'You are offline. Data may be stale.' } }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // CDN assets — stale-while-revalidate
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Static assets — cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback: return dashboard shell for page requests
        if (event.request.mode === 'navigate') {
          return caches.match('/dashboard.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// Push notification: show notification when received
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'Conclave', body: event.data.text() };
  }

  const options = {
    body: data.body || 'New update from Conclave.',
    icon: data.icon || '/favicon.svg',
    badge: '/favicon.svg',
    tag: data.tag || 'conclave-notification',
    data: data.data || {},
    vibrate: [200, 100, 200],
    requireInteraction: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Conclave', options)
  );
});

// Notification click: open or focus the dashboard
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/dashboard.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus existing dashboard tab if any
      for (const client of windowClients) {
        if (client.url.includes('/dashboard.html') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
