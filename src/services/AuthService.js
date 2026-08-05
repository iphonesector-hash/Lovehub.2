// src/services/AuthService.js
// Real Supabase Auth for LoveHub. The legacy AuthService remains available
// only for the explicit no-backend demo mode handled by app.js.

import { supabaseClient, isSupabaseReady, getInitStatus } from './SupabaseClient.js';

const EMAIL_MAP_KEY = 'usernameEmails';

// Build the redirect URL used in Supabase email-confirmation / password-reset
// links. The app is served under a sub-path on GitHub Pages (/Lovehub.2/) and
// users can land on /index.html, so normalize to a stable app-root URL — it
// must match a Supabase Auth "Redirect URLs" allowlist entry exactly.
function buildRedirectUrl() {
    if (typeof location === 'undefined' || !location.origin) return undefined;
    let path = location.pathname || '/';
    if (path.endsWith('index.html')) path = path.slice(0, -'index.html'.length);
    if (!path.endsWith('/')) path += '/';
    return `${location.origin}${path}`;
}

export class AuthService {
    constructor() {
        this.session = null;
        this._unsubscribe = null;
        this._initializePromise = null;
    }

    isReady() {
        return isSupabaseReady();
    }

    getInitStatus() {
        return getInitStatus();
    }

    // ---------------- username <-> email map ----------------

    getEmailFor(username) {
        const map = storage.get(EMAIL_MAP_KEY) || {};
        return map[(username || '').toLowerCase().trim()] || null;
    }

    hasEmailFor(username) {
        return !!this.getEmailFor(username);
    }

    rememberEmail(username, email) {
        const key = (username || '').toLowerCase().trim();
        const value = (email || '').toLowerCase().trim();
        if (!key || !value) return;
        const map = storage.get(EMAIL_MAP_KEY) || {};
        map[key] = value;
        storage.set(EMAIL_MAP_KEY, map);
    }

    // ---------------- session lifecycle ----------------

    setSession(session) {
        this.session = session || null;
    }

    // Supabase is the source of truth whenever it is configured. The legacy
    // demo IDs are intentionally not treated as Supabase sessions.
    isSupabaseUser() {
        return !!this.session?.user && this.session.user.id !== 'user1' && this.session.user.id !== 'user2';
    }

    // One shared boot promise prevents app.js and main.js from racing to read
    // the persisted session independently.
    initialize() {
        if (!this.isReady()) return Promise.resolve(null);
        if (!this._initializePromise) {
            this._initializePromise = this.getSession();
        }
        return this._initializePromise;
    }

    async getUser() {
        if (!this.isReady()) return null;
        try {
            const { data, error } = await supabaseClient.auth.getUser();
            if (error) {
                console.warn('[LoveHubAuth] getUser failed:', error.message);
                return null;
            }
            return data?.user || null;
        } catch (error) {
            console.warn('[LoveHubAuth] getUser failed:', error);
            return null;
        }
    }

    async getSession() {
        if (!this.isReady()) return null;
        try {
            const { data, error } = await supabaseClient.auth.getSession();
            if (error) {
                console.warn('[LoveHubAuth] getSession failed:', error.message);
                this.session = null;
                return null;
            }
            this.session = data?.session || null;
            return this.session;
        } catch (error) {
            console.warn('[LoveHubAuth] getSession failed:', error);
            this.session = null;
            return null;
        }
    }

    // Install exactly one listener for the lifetime of the app. Returning the
    // same cleanup function makes accidental repeated setup harmless.
    onAuthStateChange(callback) {
        if (!this.isReady()) return () => {};
        if (this._unsubscribe) return this._unsubscribe;

        const { data } = supabaseClient.auth.onAuthStateChange((event, session) => {
            this.session = session || null;
            callback(event, session || null);
        });
        const subscription = data?.subscription;
        const unsubscribe = () => {
            subscription?.unsubscribe();
            if (this._unsubscribe === unsubscribe) this._unsubscribe = null;
        };
        this._unsubscribe = unsubscribe;
        return unsubscribe;
    }

    // ---------------- auth actions ----------------

    async signUp({ email, password, username, displayName }) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };

        try {
            const { data, error } = await supabaseClient.auth.signUp({
                email: email.trim().toLowerCase(),
                password,
                options: {
                    data: {
                        username: (username || '').toLowerCase().trim(),
                        display_name: displayName
                    },
                    emailRedirectTo: buildRedirectUrl()
                }
            });
            if (error) return { success: false, error: error.message };

            this.session = data?.session || null;
            this.rememberEmail(username, email);
            return {
                success: true,
                needsEmailConfirmation: !data?.session,
                user: data?.session && data?.user
                    ? {
                        id: data.user.id,
                        username,
                        name: displayName || username,
                        initial: (displayName || username || '?')[0]?.toUpperCase()
                    }
                    : null,
                rawUser: data?.user || null
            };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }

    // The UI keeps username login. On another device, an email may also be
    // entered directly; this avoids making the local username map a security
    // or availability dependency for a real Supabase account.
    async signInWithUsername(identifier, password) {
        const value = (identifier || '').trim();
        const email = value.includes('@') ? value.toLowerCase() : this.getEmailFor(value);
        if (!email) return { success: false, error: 'No account found for that username.' };
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };

        try {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) {
                if (/not confirmed/i.test(error.message)) {
                    return {
                        success: false,
                        needsConfirmation: true,
                        error: 'Please confirm your email before logging in (check your inbox).'
                    };
                }
                return { success: false, error: error.message };
            }
            this.session = data?.session || null;
            return { success: true, session: this.session, user: data?.user || null };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }

    async signOut() {
        if (!this.isReady()) return { success: true };
        try {
            const { error } = await supabaseClient.auth.signOut();
            if (error) return { success: false, error: error.message };
            this.session = null;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }

    async resetPasswordForEmail(email) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        try {
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
                redirectTo: buildRedirectUrl()
            });
            return { success: !error, error: error?.message };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }

    async updatePassword(newPassword) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        try {
            const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
            return { success: !error, error: error?.message };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }
}
