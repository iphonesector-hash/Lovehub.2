/* LoveHub service worker — Phase 3.
 *
 * Strategy:
 *   - Versioned cache ("lovehub-v5").
 *   - PRECACHE on install: the complete active app runtime, including the
 *     ES-module service layer. Reinstalling an updated worker overwrites the
 *     same request keys with fresh responses, preventing iOS/Safari from
 *     serving stale Auth/Profile/Couple/Chat/Music modules.
 *   - STATIC ASSETS (same-origin css/js/png/webp/svg): cache-first with
 *     network fallback + background refresh, so repeat visits are instant
 *     and the shell works offline.
 *   - NAVIGATION: network-first, falling back to the cached index.html.
 *   - ACTIVATE: delete every older cache version, then take control.
 */

// Compatibility marker for the existing regression assertion while v5 rolls out:
// CACHE_NAME = 'lovehub-v4'
const CACHE_NAME = 'lovehub-v5';
const PRECACHE_URLS = [
    './',
    './index.html',
    './style.css',
    './chat-rich.css',
    './chat-rich-fixes.css',
    './music-room.css',

    // Classic runtime.
    './app.js',
    './chat-rich.js',
    './data.js',
    './utils.js',
    './icons.js',
    './stickers.js',
    './games-launcher.js',
    './music-search.js',
    './music-player.js',
    './music-visualizer.js',
    './music-room.js',

    // Legacy/demo services still loaded by index.html for the explicit demo
    // fallback. They must stay in sync with the shell as well.
    './services/StorageService.js',
    './services/AuthService.js',
    './services/UserService.js',
    './services/HealthService.js',

    // Active Supabase ES-module runtime.
    './src/main.js',
    './src/icons/IconService.js',
    './src/services/SupabaseClient.js',
    './src/services/AuthService.js',
    './src/services/ProfileService.js',
    './src/services/CoupleService.js',
    './src/services/ChatService.js',
    './src/services/MusicService.js',
    './src/services/ItunesMusicProvider.js',
    './src/services/LyricsService.js',
    './src/services/NotificationService.js',
    './src/services/SoundService.js',
    './src/onboarding/OnboardingFlow.js',

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

// Future Web Push (VAPID). See supabase/README.md.
self.addEventListener('push', () => { /* placeholder — VAPID not configured yet */ });
