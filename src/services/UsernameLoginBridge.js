// Cross-device username login bridge.
// Private browsing/new devices do not have the legacy username->email local map.
// Resolve and authenticate username server-side via the Supabase Edge Function
// without exposing account email addresses to the browser.

import { supabaseClient } from './SupabaseClient.js';

export function installUsernameLoginFallback(AuthServiceClass) {
    if (!AuthServiceClass?.prototype || AuthServiceClass.prototype.__usernameLoginFallbackInstalled) return;

    const original = AuthServiceClass.prototype.signInWithUsername;
    if (typeof original !== 'function') return;

    AuthServiceClass.prototype.signInWithUsername = async function(identifier, password) {
        const value = (identifier || '').trim();
        const rememberedEmail = !value.includes('@') ? this.getEmailFor?.(value) : null;

        // Preserve the established paths for direct email login and devices
        // that already have the local map populated.
        if (value.includes('@') || rememberedEmail) {
            return original.call(this, identifier, password);
        }

        if (!this.isReady?.()) return { success: false, error: 'Backend not configured' };
        if (!value || !password) return { success: false, error: 'Username and password are required' };

        const config = (typeof SUPABASE_CONFIG !== 'undefined') ? SUPABASE_CONFIG : null;
        const baseUrl = config?.url?.replace(/\/$/, '');
        const anonKey = config?.anonKey;
        if (!baseUrl || !anonKey) return { success: false, error: 'Backend not configured' };

        try {
            const response = await fetch(`${baseUrl}/functions/v1/username-login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': anonKey
                },
                body: JSON.stringify({ username: value, password })
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload?.access_token || !payload?.refresh_token) {
                return {
                    success: false,
                    error: response.status === 401
                        ? 'Invalid username or password'
                        : (payload?.error || 'Could not sign in')
                };
            }

            const { data, error } = await supabaseClient.auth.setSession({
                access_token: payload.access_token,
                refresh_token: payload.refresh_token
            });
            if (error || !data?.session) {
                return { success: false, error: error?.message || 'Could not create session' };
            }

            this.session = data.session;
            return { success: true, session: data.session, user: data.user || data.session.user || null };
        } catch (error) {
            return { success: false, error: error?.message || 'Could not sign in' };
        }
    };

    AuthServiceClass.prototype.__usernameLoginFallbackInstalled = true;
}
