// src/services/ProfileService.js
// Supabase-backed profiles (Phase 1 + Phase 2 personal fields).
// Mirrors public.profiles: id, username, display_name, avatar_url, bio,
// date_of_birth, height, weight, gender, city, country, occupation,
// onboarding_completed, level, xp, coins, language, status, timestamps.
//
// Phase 2 privacy: full rows are only readable by the owner and confirmed
// couple partners (RLS). Other users' public info comes via profiles_public.

import { supabaseClient, isSupabaseReady } from './SupabaseClient.js';

const AVATAR_BUCKET = 'avatars';
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Columns the app may write from the client. RLS lets owners update their
// whole row, but we never touch protected/system columns (id, username...).
const WRITABLE = [
    'display_name', 'avatar_url', 'bio',
    'date_of_birth', 'height', 'weight', 'gender',
    'city', 'country', 'occupation',
    'onboarding_completed', 'language', 'status',
    // Phase 5 — profile personalisation (migration 0009)
    'mood', 'profile_theme'
];

function avatarExtension(file) {
    const byType = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif'
    };
    return byType[file?.type] || 'jpg';
}

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

    // Update only whitelisted columns.
    async updateProfile(userId, updates) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const clean = {};
        Object.keys(updates || {}).forEach((key) => {
            if (WRITABLE.includes(key)) clean[key] = updates[key];
        });
        if (Object.keys(clean).length === 0) {
            return { success: false, error: 'Nothing to update' };
        }
        const { data, error } = await supabaseClient
            .from('profiles')
            .update({ ...clean, updated_at: new Date().toISOString() })
            .eq('id', userId)
            .select()
            .single();
        if (error) return { success: false, error: error.message };
        return { success: true, profile: data };
    }

    async uploadAvatar(userId, file) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        if (!userId || !file) return { success: false, error: 'No image selected' };
        if (!AVATAR_TYPES.has(file.type)) return { success: false, error: 'Unsupported image type' };
        if (file.size > AVATAR_MAX_BYTES) return { success: false, error: 'Avatar must be 5 MB or smaller' };

        const path = `${userId}/avatar.${avatarExtension(file)}`;
        try {
            const { error: uploadError } = await supabaseClient.storage
                .from(AVATAR_BUCKET)
                .upload(path, file, {
                    upsert: true,
                    contentType: file.type,
                    cacheControl: '3600'
                });
            if (uploadError) return { success: false, error: uploadError.message };

            const { data: publicData } = supabaseClient.storage.from(AVATAR_BUCKET).getPublicUrl(path);
            const publicUrl = publicData?.publicUrl;
            if (!publicUrl) return { success: false, error: 'Could not resolve avatar URL' };

            // Cache-bust replacements while keeping one stable object per user.
            const avatarUrl = `${publicUrl}?v=${Date.now()}`;
            const updated = await this.updateProfile(userId, { avatar_url: avatarUrl });
            if (!updated.success) return updated;
            return { success: true, profile: updated.profile, avatarUrl };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }

    async removeAvatar(userId, currentAvatarUrl = null) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        if (!userId) return { success: false, error: 'No user' };

        try {
            // Remove all supported stable avatar filenames so a previous format
            // cannot remain publicly addressable after the profile clears it.
            const paths = ['jpg', 'png', 'webp', 'gif'].map((ext) => `${userId}/avatar.${ext}`);
            const { error: removeError } = await supabaseClient.storage.from(AVATAR_BUCKET).remove(paths);
            if (removeError) console.warn('[ProfileService] avatar object cleanup:', removeError.message);

            const updated = await this.updateProfile(userId, { avatar_url: null });
            if (!updated.success) return updated;
            return { success: true, profile: updated.profile };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    }

    async markOnboardingComplete(userId) {
        return this.updateProfile(userId, { onboarding_completed: true });
    }

    // Public subset (id, username, display_name, avatar_url, status, created_at).
    async getPublicProfile(userId) {
        if (!this.isReady()) return null;
        const { data, error } = await supabaseClient
            .from('profiles_public')
            .select('*')
            .eq('id', userId)
            .maybeSingle();
        if (error || !data) return null;
        return data;
    }

    // Field definitions for the real-user profile editor (mirrors the DB).
    getDbFieldDefinitions() {
        return [
            { key: 'display_name', label: 'Display Name', type: 'text' },
            { key: 'date_of_birth', label: 'Date of Birth', type: 'date' },
            { key: 'gender', label: 'Gender', type: 'select', options: ['male', 'female', 'other', 'prefer_not_to_say'] },
            { key: 'height', label: 'Height (cm)', type: 'number' },
            { key: 'weight', label: 'Weight (kg)', type: 'number' },
            { key: 'city', label: 'City', type: 'text' },
            { key: 'country', label: 'Country', type: 'text' },
            { key: 'occupation', label: 'Occupation', type: 'text' },
            { key: 'bio', label: 'Bio', type: 'textarea' },
            // Phase 5 — profile personalisation (additive fields)
            { key: 'status', label: 'Status', type: 'text' },
            { key: 'mood', label: 'Mood', type: 'select', options: ['❤️ In love', '😊 Happy', '🌙 Calm', '✨ Dreamy', '⚡ Energetic', '🤔 Reflective'] },
            { key: 'profile_theme', label: 'Profile Theme', type: 'select', options: ['default', 'rose', 'midnight', 'aurora', 'sunset'] }
        ];
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
