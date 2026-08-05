// src/services/AuthService.js
// Real Supabase Auth (Phase 1). Replaces the fake username@lovehub.local emails.
//
// Hybrid login design (approved):
//   - Signup collects a real email (email confirmation works).
//   - Sign-in stays username + password: we remember the username->email
//     mapping in localStorage (lovehub_usernameEmails) at signup time.
//   - Usernames that are NOT Supabase accounts fall through to the legacy
//     demo accounts (Pourya/Sarina) in app.js.
//
// Session persistence is handled natively by supabase-js (persistSession),
// so a signed-in user stays signed in across reloads.

import { supabaseClient, isSupabaseReady, getInitStatus } from './SupabaseClient.js';

const EMAIL_MAP_KEY = 'usernameEmails';

export class AuthService {
    constructor() {
        this.session = null;
        this._unsubscribe = null;
    }

    isReady() {
        return isSupabaseReady();
    }

    // Why is the backend unavailable? { status: 'ok'|'missing-config'|'missing-sdk'|'init-error', reason }
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
        const map = storage.get(EMAIL_MAP_KEY) || {};
        map[(username || '').toLowerCase().trim()] = (email || '').toLowerCase().trim();
        storage.set(EMAIL_MAP_KEY, map);
    }

    // ---------------- session ----------------

    setSession(session) {
        this.session = session;
    }

    // True when the current session is a real Supabase user (legacy demo
    // accounts use the ids 'user1'/'user2').
    isSupabaseUser() {
        const user = this.session?.user;
        if (!user) return false;
        return user.id !== 'user1' && user.id !== 'user2';
    }

    async getUser() {
        if (!this.isReady()) return null;
        const { data } = await supabaseClient.auth.getUser();
        return data?.user || null;
    }

    async getSession() {
        if (!this.isReady()) return null;
        const { data } = await supabaseClient.auth.getSession();
        this.session = data.session;
        return data.session;
    }

    // Called once at boot. Fires on SIGNED_IN (incl. returning from an email
    // confirmation / recovery link), TOKEN_REFRESHED, SIGNED_OUT, etc.
    onAuthStateChange(callback) {
        if (!this.isReady()) return () => {};
        const { data } = supabaseClient.auth.onAuthStateChange((event, session) => {
            this.session = session;
            callback(event, session);
        });
        return () => data.subscription.unsubscribe();
    }

    // ---------------- auth actions ----------------

    // Sign up with a REAL email. options.data carries the username +
    // display_name that the DB trigger (handle_new_user) uses to auto-create
    // the profile row.
    async signUp({ email, password, username, displayName }) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };

        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                data: { username: (username || '').toLowerCase().trim(), display_name: displayName },
                emailRedirectTo: `${location.origin}${location.pathname}`
            }
        });
        if (error) return { success: false, error: error.message };

        this.rememberEmail(username, email);

        // No session returned -> Supabase is enforcing email confirmation.
        const needsEmailConfirmation = !data.session;
        return {
            success: true,
            needsEmailConfirmation,
            user: data.session
                ? { id: data.user.id, username, name: displayName || username, initial: (displayName || username || '?')[0]?.toUpperCase() }
                : null,
            rawUser: data.user
        };
    }

    // Sign in with the username the user typed. Only works for usernames that
    // signed up through this app (we remember the email). Anything else is
    // signalled with fallbackToDemo so app.js can try the legacy accounts.
    async signInWithUsername(username, password) {
        const email = this.getEmailFor(username);
        if (!email) return { success: false, error: 'Unknown username', fallbackToDemo: true };
        if (!this.isReady()) return { success: false, error: 'Backend not configured', fallbackToDemo: true };

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

        this.session = data.session;
        return { success: true, session: data.session, user: data.user };
    }

    async signOut() {
        if (!this.isReady()) return { success: true };
        const { error } = await supabaseClient.auth.signOut();
        this.session = null;
        return { success: !error, error: error?.message };
    }

    // Password reset preparation — sends the recovery email. The user clicks
    // the link, lands back on the app (detectSessionInUrl), and can set a new
    // password via updatePassword().
    async resetPasswordForEmail(email) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: `${location.origin}${location.pathname}`
        });
        return { success: !error, error: error?.message };
    }

    // Set a new password for the signed-in Supabase user.
    async updatePassword(newPassword) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
        return { success: !error, error: error?.message };
    }
}
