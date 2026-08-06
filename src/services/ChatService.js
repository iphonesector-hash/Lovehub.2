// src/services/ChatService.js
// Phase 3 — premium private couple chat.
//
// Reads go through RLS (confirmed couple members only, migration 0004).
// Every mutation goes through security-definer RPCs (migration 0005) so the
// server enforces: sender-only edits/deletes, receiver-only read/delivered
// receipts, member-only reactions and flags, and time limits. A non-member
// gets an empty result set / RPC rejection — never another couple's data.
//
// Realtime:
//   * postgres_changes on messages  -> new messages + status/read updates
//   * postgres_changes on message_reactions -> live reactions
//   * broadcast channel             -> typing indicators (never stored)
//   * presence channel              -> online / last seen

import { supabaseClient, isSupabaseReady } from './SupabaseClient.js';

const MAX_CONTENT = 4000;

export class ChatService {
    constructor() {
        this._messagesChannel = null;
        this._reactionsChannel = null;
        this._typingChannel = null;
        this._typingSubscribed = false;
        this._presenceChannel = null;
        this._presenceTracked = false;
    }

    isReady() {
        return isSupabaseReady();
    }

    async _uid() {
        const { data } = await supabaseClient.auth.getUser();
        return data?.user?.id || null;
    }

    // ---------------- conversation reads (RLS) ----------------

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

    async getReactions(coupleId) {
        if (!this.isReady() || !coupleId) return [];
        const { data, error } = await supabaseClient
            .from('message_reactions')
            .select('*')
            .eq('couple_id', coupleId);
        if (error) return [];
        return data || [];
    }

    // ---------------- message mutations (RPCs) ----------------

    async sendMessage(coupleId, content, { replyToId = null } = {}) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const text = (content || '').trim();
        if (!text) return { success: false, error: 'Message is empty' };
        if (text.length > MAX_CONTENT) return { success: false, error: `Message too long (max ${MAX_CONTENT} characters)` };

        const { data, error } = await supabaseClient.rpc('send_message', {
            p_couple_id: coupleId,
            p_content: text,
            p_reply_to_id: replyToId || null
        });
        if (error) return { success: false, error: error.message };
        return { success: true, message: data };
    }

    // ---------------- media (private couples-media bucket, migration 0006) ----------------

    // Upload a file for this couple. Storage RLS only permits confirmed
    // couple members to write into couples/{coupleId}/..., so a non-member
    // upload is rejected server-side.
    //
    // Phase 3.4 fix: this method NEVER throws and never accesses
    // `file.name` on a plain Blob. Compressed images, canvas exports and
    // MediaRecorder audio are Blobs WITHOUT a `.name`, so the previous
    // `file.name.split('.')` raised a TypeError that left the UI stuck in
    // "Uploading…". The extension now falls back to the MIME type / kind.
    async uploadCoupleFile(coupleId, kind, file, { onProgress = null } = {}) {
        try {
            if (!this.isReady()) return { success: false, error: 'Backend not configured' };
            const uid = await this._uid();
            if (!uid || !coupleId || !file) return { success: false, error: 'Not signed in' };
            if (file.size && file.size > 10485760) {
                return { success: false, error: 'File too large (max 10 MB)' };
            }
            const ext = this._fileExtension(file, kind);
            const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            const path = `couples/${coupleId}/${kind}/${uuid}.${ext}`;
            const { data, error } = await supabaseClient.storage
                .from('couples-media')
                .upload(path, file, {
                    cacheControl: '3600',
                    contentType: file.type || 'application/octet-stream',
                    upsert: false,
                    ...(onProgress ? { onUploadProgress: (e) => onProgress(e.total ? Math.round((e.loaded / e.total) * 100) : 0) } : {})
                });
            if (error) return { success: false, error: error.message || 'Upload failed' };
            return { success: true, path: data?.path || path };
        } catch (err) {
            return { success: false, error: (err && err.message) || 'Upload failed' };
        }
    }

    // Safe extension for Files AND Blobs: File.name first (only a real
    // extension, i.e. a dot), then the MIME subtype, then the folder kind.
    _fileExtension(file, kind) {
        const name = file.name || '';
        const dotIdx = name.lastIndexOf('.');
        const fromName = dotIdx > -1 ? name.slice(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
        if (fromName && fromName.length <= 8) return fromName;
        const mime = (file.type || '').toLowerCase();
        const mimeMap = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
            'video/mp4': 'mp4', 'video/webm': 'webm',
            'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3'
        };
        if (mimeMap[mime]) return mimeMap[mime];
        const sub = mime.split('/')[1];
        if (sub && /^[a-z0-9]+$/.test(sub)) return sub.slice(0, 8);
        const kindMap = { images: 'jpg', videos: 'mp4', audio: 'webm', drawings: 'png' };
        return kindMap[kind] || 'bin';
    }

    // Server-checked signed URL (members only). Never expose raw paths.
    async getMediaUrl(path) {
        if (!this.isReady() || !path) return null;
        const { data, error } = await supabaseClient.rpc('sign_couple_media', { p_path: path });
        if (error || !data) return null;
        return data;
    }

    async sendMediaMessage(coupleId, {
        type = 'image', content = null, mediaUrl = null, thumbnailUrl = null,
        fileSize = null, duration = null, metadata = null, replyToId = null
    } = {}) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { data, error } = await supabaseClient.rpc('send_media_message', {
            p_couple_id: coupleId,
            p_message_type: type,
            p_content: content || null,
            p_media_url: mediaUrl || null,
            p_thumbnail_url: thumbnailUrl || null,
            p_file_size: fileSize || null,
            p_duration: duration || null,
            p_metadata: metadata || null,
            p_reply_to_id: replyToId || null
        });
        if (error) return { success: false, error: error.message };
        return { success: true, message: data };
    }

    async editMessage(messageId, content) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const text = (content || '').trim();
        if (!text) return { success: false, error: 'Message is empty' };
        const { data, error } = await supabaseClient.rpc('edit_message', {
            p_message_id: messageId,
            p_content: text
        });
        if (error) return { success: false, error: error.message };
        return { success: true, message: data };
    }

    async deleteForMe(messageId) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { error } = await supabaseClient.rpc('delete_message_for_me', { p_message_id: messageId });
        if (error) return { success: false, error: error.message };
        return { success: true };
    }

    async deleteForEveryone(messageId) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { error } = await supabaseClient.rpc('delete_message_for_everyone', { p_message_id: messageId });
        if (error) return { success: false, error: error.message };
        return { success: true };
    }

    // ---------------- receipts (receiver only, server-enforced) ----------------

    async markDelivered(messageId) {
        if (!this.isReady() || !messageId) return { success: false };
        const { error } = await supabaseClient.rpc('mark_message_delivered', { p_message_id: messageId });
        return { success: !error, error: error?.message };
    }

    async markAsRead(coupleId) {
        if (!this.isReady() || !coupleId) return { success: false };
        const { error } = await supabaseClient.rpc('mark_messages_read', { p_couple_id: coupleId });
        return { success: !error, error: error?.message };
    }

    // ---------------- flags & reactions (RPCs) ----------------

    async toggleFlag(messageId, flag) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { error } = await supabaseClient.rpc('toggle_message_flag', {
            p_message_id: messageId,
            p_flag: flag
        });
        if (error) return { success: false, error: error.message };
        return { success: true };
    }

    async react(messageId, emoji) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { data, error } = await supabaseClient.rpc('react_to_message', {
            p_message_id: messageId,
            p_emoji: emoji
        });
        if (error) return { success: false, error: error.message };
        return { success: true, added: data === true };
    }

    // ---------------- realtime: messages + reactions ----------------

    subscribeToMessages(coupleId, onMessage) {
        if (!this.isReady() || !coupleId) return null;
        if (this._messagesChannel) return this._messagesChannel;
        const filter = `couple_id=eq.${coupleId}`;
        this._messagesChannel = supabaseClient
            .channel(`couple-chat:${coupleId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter },
                (payload) => onMessage?.(payload.new, false))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter },
                (payload) => onMessage?.(payload.new, true))
            .subscribe();
        return this._messagesChannel;
    }

    subscribeToReactions(coupleId, onReaction) {
        if (!this.isReady() || !coupleId) return null;
        if (this._reactionsChannel) return this._reactionsChannel;
        const filter = `couple_id=eq.${coupleId}`;
        this._reactionsChannel = supabaseClient
            .channel(`couple-reactions:${coupleId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions', filter },
                (payload) => onReaction?.(payload.new, false))
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions', filter },
                (payload) => onReaction?.(payload.old, true))
            .subscribe();
        return this._reactionsChannel;
    }

    // ---------------- realtime: typing (broadcast, never stored) ----------------

    _getTypingChannel(coupleId) {
        if (this._typingChannel) return this._typingChannel;
        this._typingChannel = supabaseClient
            .channel(`typing:${coupleId}`, { config: { broadcast: { self: false } } });
        return this._typingChannel;
    }

    async startTyping(coupleId) {
        if (!this.isReady() || !coupleId) return;
        const uid = await this._uid();
        if (!uid) return;
        const ch = this._getTypingChannel(coupleId);
        if (!this._typingSubscribed) { ch.subscribe(); this._typingSubscribed = true; }
        ch.send({ type: 'broadcast', event: 'typing', payload: { user_id: uid, typing: true } });
    }

    async stopTyping(coupleId) {
        if (!this.isReady() || !coupleId || !this._typingChannel) return;
        const uid = await this._uid();
        if (!uid) return;
        this._typingChannel.send({ type: 'broadcast', event: 'typing', payload: { user_id: uid, typing: false } });
    }

    subscribeTyping(coupleId, onTyping) {
        if (!this.isReady() || !coupleId) return () => {};
        const ch = this._getTypingChannel(coupleId);
        ch.on('broadcast', { event: 'typing' }, (payload) => onTyping?.(payload?.payload || {}));
        if (!this._typingSubscribed) { ch.subscribe(); this._typingSubscribed = true; }
        return () => {};
    }

    // ---------------- realtime: presence ----------------

    async trackPresence(coupleId, handlers = {}) {
        if (!this.isReady() || !coupleId) return null;
        const uid = await this._uid();
        if (!uid) return null;
        if (this._presenceChannel) {
            if (this._presenceTracked) this._presenceChannel.untrack();
            supabaseClient.removeChannel(this._presenceChannel);
            this._presenceChannel = null;
        }
        const ch = supabaseClient.channel(`presence:${coupleId}`);
        if (handlers.onSync) ch.on('presence', { event: 'sync' }, () => handlers.onSync(ch.presenceState()));
        if (handlers.onJoin) ch.on('presence', { event: 'join' }, ({ newPresences }) => handlers.onJoin(newPresences || []));
        if (handlers.onLeave) ch.on('presence', { event: 'leave' }, ({ leftPresences }) => handlers.onLeave(leftPresences || []));
        ch.subscribe(async (status) => {
            if (status === 'SUBSCRIBED' && !this._presenceTracked) {
                this._presenceTracked = true;
                await ch.track({ user_id: uid, online_at: Date.now() });
            }
        });
        this._presenceChannel = ch;
        return ch;
    }

    untrackPresence() {
        if (this._presenceChannel && this._presenceTracked) {
            this._presenceChannel.untrack();
            this._presenceTracked = false;
        }
    }

    // ---------------- preferences (owner / member RLS) ----------------

    async getChatPreferences() {
        const uid = await this._uid();
        if (!this.isReady() || !uid) return null;
        const { data } = await supabaseClient
            .from('chat_preferences')
            .select('*')
            .eq('profile_id', uid)
            .maybeSingle();
        return data;
    }

    async saveChatPreferences(prefs) {
        const uid = await this._uid();
        if (!this.isReady() || !uid) return { success: false, error: 'Not signed in' };
        const { data, error } = await supabaseClient
            .from('chat_preferences')
            .upsert({ profile_id: uid, ...prefs, updated_at: new Date().toISOString() }, { onConflict: 'profile_id' })
            .select()
            .single();
        if (error) return { success: false, error: error.message };
        return { success: true, prefs: data };
    }

    async getCoupleChatSettings(coupleId) {
        if (!this.isReady() || !coupleId) return null;
        const { data } = await supabaseClient
            .from('couple_chat_settings')
            .select('*')
            .eq('couple_id', coupleId)
            .maybeSingle();
        return data;
    }

    async saveCoupleChatSettings(coupleId, settings) {
        const uid = await this._uid();
        if (!this.isReady() || !coupleId || !uid) return { success: false, error: 'Not signed in' };
        const { data, error } = await supabaseClient
            .from('couple_chat_settings')
            .upsert({ couple_id: coupleId, ...settings, updated_by: uid, updated_at: new Date().toISOString() }, { onConflict: 'couple_id' })
            .select()
            .single();
        if (error) return { success: false, error: error.message };
        return { success: true, settings: data };
    }

    async getNotificationPreferences() {
        const uid = await this._uid();
        if (!this.isReady() || !uid) return null;
        const { data } = await supabaseClient
            .from('notification_preferences')
            .select('*')
            .eq('profile_id', uid)
            .maybeSingle();
        return data || { messages_enabled: true, couple_requests_enabled: true, events_enabled: true };
    }

    async saveNotificationPreferences(prefs) {
        const uid = await this._uid();
        if (!this.isReady() || !uid) return { success: false, error: 'Not signed in' };
        const { data, error } = await supabaseClient
            .from('notification_preferences')
            .upsert({ profile_id: uid, ...prefs, updated_at: new Date().toISOString() }, { onConflict: 'profile_id' })
            .select()
            .single();
        if (error) return { success: false, error: error.message };
        return { success: true, prefs: data };
    }

    async touchLastSeen() {
        if (!this.isReady()) return;
        try { await supabaseClient.rpc('touch_last_seen'); } catch (e) { /* best-effort */ }
    }

    // ---------------- chat statistics ----------------

    async getChatStats(coupleId) {
        const uid = await this._uid();
        if (!this.isReady() || !coupleId || !uid) return null;
        const [sentRes, receivedRes, reactionsRes] = await Promise.all([
            supabaseClient.from('messages')
                .select('id', { count: 'exact', head: true })
                .eq('couple_id', coupleId).eq('sender_id', uid).is('deleted_at', null),
            supabaseClient.from('messages')
                .select('id', { count: 'exact', head: true })
                .eq('couple_id', coupleId).neq('sender_id', uid).is('deleted_at', null),
            supabaseClient.from('message_reactions').select('emoji').eq('couple_id', coupleId)
        ]);
        const emojiCounts = {};
        (reactionsRes.data || []).forEach((r) => {
            emojiCounts[r.emoji] = (emojiCounts[r.emoji] || 0) + 1;
        });
        const topEmoji = Object.entries(emojiCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
        return {
            sent: sentRes.count || 0,
            received: receivedRes.count || 0,
            total: (sentRes.count || 0) + (receivedRes.count || 0),
            topEmoji
        };
    }

    // ---------------- teardown ----------------

    // Called on logout / couple switch: removes every realtime channel so a
    // signed-out session can never keep receiving couple events.
    disconnectAll() {
        const channels = [this._messagesChannel, this._reactionsChannel, this._typingChannel, this._presenceChannel];
        channels.forEach((ch) => {
            if (ch) {
                try { ch.untrack(); } catch (e) { /* ignore */ }
                supabaseClient.removeChannel(ch);
            }
        });
        this._messagesChannel = null;
        this._reactionsChannel = null;
        this._typingChannel = null;
        this._typingSubscribed = false;
        this._presenceChannel = null;
        this._presenceTracked = false;
    }
}
