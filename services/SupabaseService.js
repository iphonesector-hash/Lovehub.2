// SupabaseService.js
// Real multi-user backend layer for LoveHub Games (Phase 1).
// Requires: supabase-js CDN script + supabase/config.js loaded before this file.
//
// This service is additive — it does NOT remove AuthService/StorageService yet.
// Once SUPABASE_CONFIG is filled in and tested, app.js will be switched over
// to call these methods instead of the old localStorage-only ones.

class SupabaseService {
    constructor() {
        this.client = null;
        this.ready = false;

        if (typeof SUPABASE_CONFIG === 'undefined') {
            console.warn('[SupabaseService] Missing supabase/config.js — backend disabled, app falls back to local mode.');
            return;
        }
        if (typeof window.supabase === 'undefined') {
            console.warn('[SupabaseService] supabase-js not loaded — add the CDN script tag before this file.');
            return;
        }

        this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        this.ready = true;
    }

    // ---------------- AUTH ----------------

    async signUp(email, password, username, displayName) {
        if (!this.ready) return { success: false, error: 'Backend not configured' };
        const { data, error } = await this.client.auth.signUp({
            email, password,
            options: { data: { username, display_name: displayName } }
        });
        if (error) return { success: false, error: error.message };
        return { success: true, user: data.user };
    }

    async login(email, password) {
        if (!this.ready) return { success: false, error: 'Backend not configured' };
        const { data, error } = await this.client.auth.signInWithPassword({ email, password });
        if (error) return { success: false, error: error.message };
        return { success: true, session: data.session, user: data.user };
    }

    async logout() {
        if (!this.ready) return { success: false };
        const { error } = await this.client.auth.signOut();
        return { success: !error };
    }

    async getCurrentUser() {
        if (!this.ready) return null;
        const { data } = await this.client.auth.getUser();
        return data?.user || null;
    }

    // ---------------- PROFILE ----------------

    async getProfile(profileId) {
        const { data, error } = await this.client
            .from('profiles').select('*, player_stats(*)').eq('id', profileId).single();
        if (error) return null;
        return data;
    }

    async updateProfile(profileId, updates) {
        const { data, error } = await this.client
            .from('profiles').update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', profileId).select().single();
        if (error) return { success: false, error: error.message };
        return { success: true, profile: data };
    }

    // ---------------- FRIENDS ----------------

    async sendFriendRequest(requesterId, addresseeId) {
        const { error } = await this.client.from('friendships')
            .insert({ requester_id: requesterId, addressee_id: addresseeId });
        return { success: !error, error: error?.message };
    }

    async respondFriendRequest(friendshipId, accept) {
        const { error } = await this.client.from('friendships')
            .update({ status: accept ? 'accepted' : 'blocked', responded_at: new Date().toISOString() })
            .eq('id', friendshipId);
        return { success: !error };
    }

    async getFriends(profileId) {
        const { data, error } = await this.client
            .from('friendships')
            .select('*, requester:requester_id(*), addressee:addressee_id(*)')
            .or(`requester_id.eq.${profileId},addressee_id.eq.${profileId}`)
            .eq('status', 'accepted');
        if (error) return [];
        return data;
    }

    // ---------------- ROOMS / MATCHMAKING ----------------

    async createRoom(gameId, createdBy, isPrivate = false) {
        const roomCode = isPrivate ? Math.random().toString(36).substring(2, 8).toUpperCase() : null;
        const { data, error } = await this.client.from('game_rooms')
            .insert({ game_id: gameId, created_by: createdBy, is_private: isPrivate, room_code: roomCode })
            .select().single();
        if (error) return { success: false, error: error.message };
        await this.client.from('room_players').insert({ room_id: data.id, profile_id: createdBy });
        return { success: true, room: data };
    }

    async joinRoomByCode(roomCode) {
        const { data, error } = await this.client.rpc('join_room_by_code', {
            p_room_code: roomCode
        });
        if (error) return { success: false, error: error.message };
        const room = Array.isArray(data) ? data[0] : data;
        if (!room) return { success: false, error: 'Room not found' };
        return { success: true, room };
    }

    async findOpenRoom(gameId) {
        const { data, error } = await this.client
            .from('game_rooms')
            .select('*, room_players(count)')
            .eq('game_id', gameId).eq('status', 'waiting').eq('is_private', false)
            .limit(1);
        if (error || !data?.length) return null;
        return data[0];
    }

    // Realtime subscription for a room (state sync, presence, chat, moves)
    subscribeToRoom(roomId, onUpdate) {
        if (!this.ready) return null;
        return this.client
            .channel(`room:${roomId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` }, onUpdate)
            .subscribe();
    }

    // ---------------- LEADERBOARD ----------------

    async getGlobalLeaderboard(limit = 50) {
        const { data, error } = await this.client
            .from('leaderboard_global').select('*').limit(limit);
        if (error) return [];
        return data;
    }

    // ---------------- ECONOMY ----------------

    async addCoins(profileId, amount, reason) {
        await this.client.from('coin_transactions').insert({ profile_id: profileId, amount, reason });
        // Server-side function recommended for real balance updates (avoids race conditions);
        // for now this can be paired with an RPC once we wire the DB functions.
    }
}

const supabaseService = new SupabaseService();
