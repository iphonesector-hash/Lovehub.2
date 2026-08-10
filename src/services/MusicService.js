// src/services/MusicService.js
// Phase 5 — couple-scoped music favorites / shared song library.
//
// Backed by the music_favorites table (migration 0009). RLS confines every
// read/write to the couple the caller belongs to, so one couple's library is
// never visible to another. No audio files are stored — only small metadata
// (title/artist/urls) — and playable_url is the ONLY thing the player uses.
//
// Realtime: postgres_changes on music_favorites lets both partners see new
// shared songs immediately (and powers the "partner shared a song" activity
// notification).

import { supabaseClient, isSupabaseReady } from './SupabaseClient.js';

const MAX_URL = 2000;
const MAX_TEXT = 300;

export class MusicService {
    constructor() {
        this._favChannel = null;
    }

    isReady() {
        return isSupabaseReady();
    }

    async _uid() {
        const { data } = await supabaseClient.auth.getUser();
        return data?.user?.id || null;
    }

    // ---------------- reads (RLS: couple members only) ----------------

    async getFavorites(coupleId) {
        if (!this.isReady() || !coupleId) return [];
        const { data, error } = await supabaseClient
            .from('music_favorites')
            .select('*')
            .eq('couple_id', coupleId)
            .order('created_at', { ascending: false });
        if (error) return [];
        return data || [];
    }

    // ---------------- writes (RLS + profile_id stamped server-side) ----------------

    async addFavorite(coupleId, track) {
        const uid = await this._uid();
        if (!this.isReady() || !coupleId || !uid) return { success: false, error: 'Not signed in' };

        // Phase 13 — a track is saveable when it has a direct audio stream OR
        // is a YouTube embed track (official IFrame playback — no audio URL).
        const yt = (track && track.metadata && track.metadata.youtube) || null;
        const isYtEmbed = !!(track && (track.playbackMode === 'youtube-embed' || (yt && yt.playbackMode === 'youtube-embed')));
        const ytVideoId = isYtEmbed && yt ? (yt.videoId || null) : null;
        if (!track || !(track.playableUrl || (isYtEmbed && ytVideoId))) {
            return { success: false, error: 'This result has no playable stream' };
        }

        // playable_url is NOT NULL in the DB. YouTube embed tracks have no
        // audio URL, so the official watch URL is stored there as an
        // identifier — playback always routes through the saved playbackMode.
        const fallbackUrl = (isYtEmbed && ytVideoId)
            ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(ytVideoId)
            : (track.playableUrl || '');

        const row = {
            couple_id: coupleId,
            profile_id: uid,
            title: String(track.title || 'Untitled').slice(0, MAX_TEXT),
            artist: track.artist ? String(track.artist).slice(0, MAX_TEXT) : null,
            source: track.source ? String(track.source).slice(0, 120) : null,
            page_url: track.pageUrl ? String(track.pageUrl).slice(0, MAX_URL) : null,
            playable_url: String(fallbackUrl).slice(0, MAX_URL),
            artwork_url: track.artworkUrl ? String(track.artworkUrl).slice(0, MAX_URL) : null,
            duration: track.duration ? Number(track.duration) : null,
            metadata: {
                provider: track.provider || null,
                dedupeKey: (track.dedupeKey || fallbackUrl).slice(0, 500),
                // Phase 13 — full replay metadata: a saved track must replay
                // through the SAME path it was saved with (html5-audio vs
                // youtube-embed), including the provider video id.
                playbackMode: track.playbackMode || (isYtEmbed ? 'youtube-embed' : 'html5-audio'),
                sourceType: track.sourceType || null,
                videoId: ytVideoId,
                youtube: isYtEmbed ? { videoId: ytVideoId, playbackMode: 'youtube-embed' } : null
            }
        };
        const { data, error } = await supabaseClient
            .from('music_favorites')
            .insert(row)
            .select()
            .single();
        if (error) return { success: false, error: error.message };
        return { success: true, favorite: data };
    }

    async removeFavorite(coupleId, id) {
        if (!this.isReady() || !coupleId || !id) return { success: false };
        const { error } = await supabaseClient
            .from('music_favorites')
            .delete()
            .eq('id', id)
            .eq('couple_id', coupleId);
        if (error) return { success: false, error: error.message };
        return { success: true };
    }

    // ---------------- realtime (partner shares / removes) ----------------

    subscribeToFavorites(coupleId, handlers = {}) {
        if (!this.isReady() || !coupleId) return null;
        if (this._favChannel) return this._favChannel;
        const filter = `couple_id=eq.${coupleId}`;
        this._favChannel = supabaseClient
            .channel(`music-favorites:${coupleId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'music_favorites', filter },
                (payload) => handlers.onInsert?.(payload.new))
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'music_favorites', filter },
                (payload) => handlers.onDelete?.(payload.old))
            .subscribe();
        return this._favChannel;
    }

    unsubscribeFavorites() {
        if (this._favChannel) {
            try { supabaseClient.removeChannel(this._favChannel); } catch (e) { /* ignore */ }
            this._favChannel = null;
        }
    }
}
