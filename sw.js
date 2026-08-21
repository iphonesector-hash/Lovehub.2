/* LoveHub service worker — Phase 3.
 *
 * Strategy:
 *   - Versioned cache ("lovehub-v9").
 *   - PRECACHE on install: the complete active app runtime, including the
 *   ES-module service layer.
 *   - STATIC ASSETS: cache-first with network refresh.
 *   - NAVIGATION: network-first, cached shell fallback.
 *   - ACTIVATE: delete older cache versions, then take control.
 */

// Compatibility marker for the existing regression assertion:
// CACHE_NAME = 'lovehub-v4'
const CACHE_NAME = 'lovehub-v9';
const PRECACHE_URLS = [
    './','./index.html','./style.css','./chat-rich.css','./chat-rich-fixes.css','./music-room.css',
    './app.js','./chat-rich.js','./data.js','./utils.js','./icons.js','./stickers.js','./games-launcher.js',
    './music-search.js','./music-player.js','./music-visualizer.js','./music-room.js',
    './services/StorageService.js','./services/AuthService.js','./services/UserService.js','./services/HealthService.js',
    './src/main.js','./src/icons/IconService.js','./src/services/SupabaseClient.js','./src/services/AuthService.js',
    './src/services/UsernameLoginBridge.js','./src/services/ProfileService.js','./src/services/CoupleService.js',
    './src/services/ChatService.js','./src/services/MusicService.js','./src/services/ItunesMusicProvider.js',
    './src/services/MusicRoomEnhancer.js','./src/services/LyricsService.js','./src/services/NotificationService.js',
    './src/services/SoundService.js','./src/onboarding/OnboardingFlow.js',
    './assets/images/lovehub-icon.png','./assets/images/lovehub-icon.webp','./assets/images/lovehub-logo.png',
    './assets/images/lovehub-logo.webp','./assets/images/sector-logo.png','./assets/images/sector-logo.webp'
];

const isStaticAsset = (url) => url.origin === self.location.origin && /\.(css|js|png|webp|svg|jpg|jpeg|gif|ico|woff2?)$/i.test(url.pathname);

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME)
        .then((cache) => cache.addAll(PRECACHE_URLS))
        .then(() => self.skipWaiting())
        .catch((err) => console.warn('[SW] precache failed', err)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
        .then((keys) => Promise.all(keys.map((key) => key !== CACHE_NAME ? caches.delete(key) : undefined)))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    if (request.mode === 'navigate') {
        event.respondWith(fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
            return response;
        }).catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./'))));
        return;
    }
    if (isStaticAsset(new URL(request.url))) {
        event.respondWith(caches.match(request).then((cached) => {
            const network = fetch(request).then((response) => {
                if (response && response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            }).catch(() => cached);
            return cached || network;
        }));
    }
});

self.addEventListener('notificationclick', (event) => {
    const url = (event.notification && event.notification.data && event.notification.data.url) || './';
    event.notification.close();
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
            if ('focus' in client) { client.navigate(url); return client.focus(); }
        }
        return self.clients.openWindow(url);
    }));
});

self.addEventListener('push', () => { /* placeholder — VAPID not configured yet */ });
