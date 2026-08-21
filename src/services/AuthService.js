// src/services/AuthService.js
// Real Supabase Auth for LoveHub. The legacy AuthService remains available
// only for the explicit no-backend demo mode handled by app.js.

import { supabaseClient, isSupabaseReady, getInitStatus } from './SupabaseClient.js';

const EMAIL_MAP_KEY = 'usernameEmails';

function buildRedirectUrl() {
    if (typeof location === 'undefined' || !location.origin) return undefined;
    let path = location.pathname || '/';
    if (path.endsWith('index.html')) path = path.slice(0, -'index.html'.length);
    if (!path.endsWith('/')) path += '/';
    return `${location.origin}${path}`;
}

function getPublicSupabaseConfig() {
    try {
        if (typeof SUPABASE_CONFIG !== 'undefined' && SUPABASE_CONFIG?.url && SUPABASE_CONFIG?.anonKey) {
            return SUPABASE_CONFIG;
        }
    } catch (_) { /* global may not exist */ }
    return null;
}

export class AuthService {
    constructor() {
        this.session = null;
        this._unsubscribe = null;
        this._initializePromise = null;
    }

    isReady() { return isSupabaseReady(); }
    getInitStatus() { return getInitStatus(); }

    getEmailFor(username) {
        const map = storage.get(EMAIL_MAP_KEY) || {};
        return map[(username || '').toLowerCase().trim()] || null;
    }

    hasEmailFor(username) { return !!this.getEmailFor(username); }

    rememberEmail(username, email) {
        const key = (username || '').toLowerCase().trim();
        const value = (email || '').toLowerCase().trim();
        if (!key || !value) return;
        const map = storage.get(EMAIL_MAP_KEY) || {};
        map[key] = value;
        storage.set(EMAIL_MAP_KEY, map);
    }

    setSession(session) { this.session = session || null; }

    isSupabaseUser() {
        return !!this.session?.user && this.session.user.id !== 'user1' && this.session.user.id !== 'user2';
    }

    initialize() {
        if (!this.isReady()) return Promise.resolve(null);
        if (!this._initializePromise) this._initializePromise = this.getSession();
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

    async checkUsernameAvailability(username) {
        const value = (username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{2,40}$/i.test(value)) {
            return { success: false, available: false, error: 'Username must be 2-40 characters and use only letters, numbers, dot, dash or underscore.' };
        }
        const config = getPublicSupabaseConfig();
        const baseUrl = config?.url?.replace(/\/$/, '');
        const anonKey = config?.anonKey;
        if (!baseUrl || !anonKey) return { success: false, available: false, error: 'Backend not configured' };
        try {
            const response = await fetch(`${baseUrl}/functions/v1/username-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: anonKey },
                body: JSON.stringify({ action: 'check-username', username: value })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) return { success: false, available: false, error: payload?.error || 'Could not check username' };
            return { success: true, available: !!payload.available };
        } catch (error) {
            return { success: false, available: false, error: error?.message || 'Could not check username' };
        }
    }

    async signUp({ email, password, username, displayName }) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const normalizedUsername = (username || '').toLowerCase().trim();
        try {
            const availability = await this.checkUsernameAvailability(normalizedUsername);
            if (!availability.success) return { success: false, error: availability.error };
            if (!availability.available) return { success: false, error: 'Username is already taken. Please choose another one.' };

            const { data, error } = await supabaseClient.auth.signUp({
                email: email.trim().toLowerCase(),
                password,
                options: {
                    data: {
                        username: normalizedUsername,
                        display_name: displayName
                    },
                    emailRedirectTo: buildRedirectUrl()
                }
            });
            if (error) {
                const message = /database error saving new user/i.test(error.message || '')
                    ? 'Could not create account. Please choose a different username and try again.'
                    : error.message;
                return { success: false, error: message };
            }

            this.session = data?.session || null;
            this.rememberEmail(normalizedUsername, email);
            return {
                success: true,
                needsEmailConfirmation: !data?.session,
                user: data?.session && data?.user
                    ? {
                        id: data.user.id,
                        username: normalizedUsername,
                        name: displayName || normalizedUsername,
                        initial: (displayName || normalizedUsername || '?')[0]?.toUpperCase()
                    }
                    : null,
                rawUser: data?.user || null
            };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }

    async signInWithUsername(identifier, password) {
        const value = (identifier || '').trim();
        const email = value.includes('@') ? value.toLowerCase() : this.getEmailFor(value);
        if (!email) return { success: false, error: 'No account found for that username.' };
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        try {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) {
                if (/not confirmed/i.test(error.message)) {
                    return { success: false, needsConfirmation: true, error: 'Please confirm your email before logging in (check your inbox).' };
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
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: buildRedirectUrl() });
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

    async changePassword(currentPassword, newPassword) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        if (!currentPassword) return { success: false, error: 'Current password is required' };
        if (!newPassword) return { success: false, error: 'New password is required' };
        try {
            const user = await this.getUser();
            const email = user?.email || this.session?.user?.email;
            if (!email) return { success: false, error: 'Could not resolve the account email' };
            const { data: reauthData, error: reauthError } = await supabaseClient.auth.signInWithPassword({ email, password: currentPassword });
            if (reauthError) return { success: false, error: 'Current password is incorrect' };
            if (reauthData?.session) this.session = reauthData.session;
            const { data, error } = await supabaseClient.auth.updateUser({ password: newPassword });
            if (error) return { success: false, error: error.message };
            return { success: true, user: data?.user || null };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }
}
