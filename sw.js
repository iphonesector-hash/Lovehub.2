/* LoveHub service worker — Phase 3.
 *
 * Strategy (Phase 3, additive — the previous file only handled
 * notifications and had no caching at all):
 *   - Versioned cache ("lovehub-v2"). Bump the version to invalidate.
 *   - PRECACHE on install: the app shell (HTML, CSS, JS, images, icons).
 *   - STATIC ASSETS (same-origin css/js/png/webp/svg): cache-first with
 *     network fallback + background refresh, so repeat visits are instant
 *     and the shell works offline.
 *   - NAVIGATION: network-first, falling back to the cached index.html for
 *     full offline support.
 *   - ACTIVATE: delete every older cache version, then take control.
 *   - Notification shell preserved: notificationclick focuses/deep-links;
 *     the push handler is still a stub until VAPID is wired up.
 */

const CACHE_NAME = 'lovehub-v2';
const PRECACHE_URLS = [
    './',
    './index.html',
    './style.css',
    './chat-rich.css',
    './chat-rich-fixes.css',
    './app.js',
    './chat-rich.js',
    './data.js',
    './utils.js',
    './icons.js',
    './stickers.js',
    './assets/images/lovehub-icon.png',
    './assets/images/lovehub-icon.webp',
    './assets/images/lovehub-logo.png',
    './assets/images/lovehub-logo.webp',
    './assets/images/sector-logo.png',
    './assets/images/sector-logo.webp'
];

const isStaticAsset = (url) => {
    if (url.origin !== self.location.origin) return false;
    return /\.(css|js|png|webp|svg|jpg|jpeg|gif|ico|woff2?)$/i.test(url.pathname);
};

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
            .catch((err) => console.warn('[SW] precache failed', err))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.map((key) => {
                if (key !== CACHE_NAME) return caches.delete(key);
            })))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    // Navigations: network first, cached shell for offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
                    return response;
                })
                .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./')))
        );
        return;
    }

    // Static assets: cache first, fall back to network, refresh in background.
    if (isStaticAsset(new URL(request.url))) {
        event.respondWith(
            caches.match(request).then((cached) => {
                const network = fetch(request).then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                }).catch(() => cached);
                return cached || network;
            })
        );
    }
});

// User tapped a notification → focus the app (and deep-link if provided).
self.addEventListener('notificationclick', (event) => {
    const url = (event.notification && event.notification.data && event.notification.data.url) || './';
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
                if ('focus' in client) { client.navigate(url); return client.focus(); }
            }
            return self.clients.openWindow(url);
        })
    );
});

// ---- Future Web Push (VAPID) ----------------------------------------------
// When a push service is wired up, replace this handler with:
//
//   self.addEventListener('push', (event) => {
//       const data = event.data ? event.data.json() : {};
//       event.waitUntil(
//           self.registration.showNotification(
//               data.title || 'LoveHub',
//               { body: data.body || '', icon: 'assets/images/lovehub-icon.png', data: { url: data.url } }
//           )
//       );
//   });
//
// See supabase/README.md → "Push notifications (Android / Web Push)".
self.addEventListener('push', () => { /* placeholder — VAPID not configured yet */ });
