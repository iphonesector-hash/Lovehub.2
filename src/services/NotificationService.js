// src/services/NotificationService.js
// Phase 3 — browser / PWA notifications.
//
//   * Notification API for foreground/background alerts (permission-gated).
//   * Service worker registration (sw.js) — a shell ready for future Web
//     Push / VAPID, which will let Android/PWA deliver messages even when
//     the app is closed (see supabase/README.md → "Push notifications").
//   * The app decides WHEN to notify (never while the user is looking at the
//     chat) and consults notification_preferences stored via ChatService.

const ICON_URL = 'assets/images/lovehub-icon.png';

export class NotificationService {
    isSupported() {
        return typeof window !== 'undefined' && 'Notification' in window;
    }

    permission() {
        if (!this.isSupported()) return 'unsupported';
        return Notification.permission; // 'default' | 'granted' | 'denied'
    }

    // Must be called from a user gesture (e.g. the settings toggle).
    async requestPermission() {
        if (!this.isSupported()) {
            return { success: false, error: 'Notifications are not supported in this browser.' };
        }
        if (Notification.permission === 'granted') {
            return { success: true, permission: 'granted' };
        }
        try {
            const result = await Notification.requestPermission();
            if (result === 'granted') await this.ensureRegistered();
            return { success: result === 'granted', permission: result };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }

    async ensureRegistered() {
        if (!('serviceWorker' in navigator)) return null;
        try {
            const url = new URL('sw.js', window.location.href);
            const reg = await navigator.serviceWorker.register(url, { scope: './' });
            return reg;
        } catch (error) {
            console.warn('[Notifications] service worker registration failed:', error.message);
            return null;
        }
    }

    // Fire a notification (no-op unless permission granted).
    notify(title, { body = '', icon = ICON_URL, tag = null, url = null } = {}) {
        if (!this.isSupported() || Notification.permission !== 'granted') return false;
        try {
            const options = { body, icon, badge: icon, tag: tag || undefined };
            if (url) options.data = { url };
            const n = new Notification(title, options);
            n.onclick = () => {
                try { window.focus(); } catch (e) { /* ignore */ }
                if (url) window.location.href = url;
                n.close();
            };
            return true;
        } catch (error) {
            console.warn('[Notifications] notify failed:', error.message);
            return false;
        }
    }
}
