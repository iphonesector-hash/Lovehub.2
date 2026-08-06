// src/services/ChatService.js
// Phase 3 — private couple chat.
//
// Messages live in public.messages (migration 0004) and are fully protected
// by Row Level Security: only confirmed members of a couple can read, insert,
// or mark messages read in that couple's conversation. A non-member gets an
// empty result set / RLS rejection — the app never sees another couple's data.
//
// Realtime: subscribeToMessages() listens for INSERT/UPDATE on the couple's
// conversation so new messages and read receipts appear instantly.

import { supabaseClient, isSupabaseReady } from './SupabaseClient.js';

export class ChatService {
    isReady() {
        return isSupabaseReady();
    }

    async _uid() {
        const { data } = await supabaseClient.auth.getUser();
        return data?.user?.id || null;
    }

    // ---------------- reads ----------------

    // Full conversation, oldest first (limited to the last `limit` rows).
    async getConversation(coupleId, { limit = 200 } = {}) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        if (!coupleId) return { success: true, messages: [] };
        const { data, error } = await supabaseClient
            .from('messages')
            .select('*')
            .eq('couple_id', coupleId)
            .order('created_at', { ascending: true })
            .limit(limit);
        if (error) return { success: false, error: error.message };
        return { success: true, messages: data || [] };
    }

    // ---------------- writes (RLS-enforced) ----------------

    async sendMessage(coupleId, content) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const text = (content || '').trim();
        if (!text) return { success: false, error: 'Message is empty' };
        const senderId = await this._uid();
        if (!senderId) return { success: false, error: 'Not signed in' };

        const { data, error } = await supabaseClient
            .from('messages')
            .insert({ couple_id: coupleId, sender_id: senderId, content: text })
            .select()
            .single();
        if (error) return { success: false, error: error.message };
        return { success: true, message: data };
    }

    // Mark every unread message from the partner as read.
    async markAsRead(coupleId) {
        if (!this.isReady()) return { success: false };
        const uid = await this._uid();
        if (!uid || !coupleId) return { success: false };
        const { error } = await supabaseClient
            .from('messages')
            .update({ read_at: new Date().toISOString() })
            .eq('couple_id', coupleId)
            .neq('sender_id', uid)
            .is('read_at', null);
        return { success: !error, error: error?.message };
    }

    // ---------------- realtime ----------------

    // Subscribe to new messages (and read-receipt updates) for a couple.
    // Returns the channel so the caller can unsubscribe with unsubscribe().
    subscribeToMessages(coupleId, onMessage) {
        if (!this.isReady() || !coupleId) return null;
        const filter = `couple_id=eq.${coupleId}`;
        return supabaseClient
            .channel(`couple-chat:${coupleId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter },
                (payload) => onMessage?.(payload.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter },
                (payload) => onMessage?.(payload.new, true))
            .subscribe();
    }

    unsubscribe(channel) {
        if (channel && supabaseClient) supabaseClient.removeChannel(channel);
    }
}
