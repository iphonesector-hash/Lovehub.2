// src/services/ProfileService.js
// Supabase-backed profiles (Phase 1). Mirrors the public.profiles table:
// id, username, display_name, avatar_url, bio, level, xp, coins, language,
// status, created_at, updated_at.
//
// The DB trigger (handle_new_user in supabase/schema.sql) auto-creates the
// profile row on signup; ensureProfile() is a defensive fallback so the app
// still works if that trigger was never installed.

import { supabaseClient, isSupabaseReady } from './SupabaseClient.js';

export class ProfileService {
    isReady() {
        return isSupabaseReady();
    }

    async getProfile(userId) {
        if (!this.isReady()) return null;
        const { data, error } = await supabaseClient
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle();
        if (error || !data) return null;
        return data;
    }

    // Guarantees a profile row exists for a user id (first sign-in).
    async ensureProfile(userId, { username, displayName } = {}) {
        const existing = await this.getProfile(userId);
        if (existing) return existing;
        if (!this.isReady()) return null;

        const fallback = username || 'user';
        const { data, error } = await supabaseClient
            .from('profiles')
            .insert({
                id: userId,
                username: fallback,
                display_name: displayName || fallback
            })
            .select()
            .single();
        if (error) {
            console.warn('[ProfileService] ensureProfile failed:', error.message);
            return null;
        }
        return data;
    }

    async updateProfile(userId, updates) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { data, error } = await supabaseClient
            .from('profiles')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', userId)
            .select()
            .single();
        if (error) return { success: false, error: error.message };
        return { success: true, profile: data };
    }

    // Shape used by the app: { id, username, name, initial }.
    toAppUser(profile, sbUser) {
        if (!profile && !sbUser) return null;
        const username =
            profile?.username ||
            sbUser?.user_metadata?.username ||
            (sbUser?.email ? sbUser.email.split('@')[0] : 'user');
        const displayName =
            profile?.display_name ||
            sbUser?.user_metadata?.display_name ||
            username;
        return {
            id: sbUser?.id || profile?.id,
            username,
            name: displayName,
            initial: (displayName || username || '?')[0]?.toUpperCase()
        };
    }
}
