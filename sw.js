/* LoveHub service worker — Phase 3.
 *
 * Notification shell for the PWA experience:
 *   - notificationclick brings the app forward and jumps to the chat.
 *   - The push handler is a stub ready for Web Push / VAPID: once a Supabase
 *     Edge Function (or your Android/FCM relay) sends a push payload
 *     { title, body, url }, uncomment the body below. No secrets live here.
 */

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
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
