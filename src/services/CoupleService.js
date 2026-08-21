// src/services/CoupleService.js
// Phase 2 — couple system. All writes go through security-definer RPCs
// (create / join / respond / cancel / leave); reads use RLS (members only).

import { supabaseClient, isSupabaseReady } from './SupabaseClient.js';

export class CoupleService {
    isReady() {
        return isSupabaseReady();
    }

    async _uid() {
        const { data } = await supabaseClient.auth.getUser();
        return data?.user?.id || null;
    }

    // ---------------- writes (RPCs) ----------------

    async createCouple(partnerEmail) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { data, error } = await supabaseClient.rpc('create_couple', {
            p_partner_email: partnerEmail
        });
        if (error) return { success: false, error: error.message };
        return { success: true, couple: data };
    }

    async joinCouple(inviteCode, email) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { data, error } = await supabaseClient.rpc('join_couple', {
            p_invite_code: inviteCode,
            p_email: email
        });
        if (error) return { success: false, error: error.message };
        return { success: true, request: data };
    }

    async respondToRequest(requestId, approve) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { data, error } = await supabaseClient.rpc('respond_to_couple_request', {
            p_request_id: requestId,
            p_approve: approve
        });
        if (error) return { success: false, error: error.message };
        return { success: true, data };
    }

    async cancelCouple(coupleId) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { error } = await supabaseClient.rpc('cancel_couple', { p_couple_id: coupleId });
        if (error) return { success: false, error: error.message };
        return { success: true };
    }

    async leaveCouple(coupleId) {
        if (!this.isReady()) return { success: false, error: 'Backend not configured' };
        const { error } = await supabaseClient.rpc('leave_couple', { p_couple_id: coupleId });
        if (error) return { success: false, error: error.message };
        return { success: true };
    }

    // ---------------- reads (RLS) ----------------

    // The user's couple (if any) plus the partner's profile. Partner
    // profile is fully readable once the couple is active (RLS).
    async getMyCouple() {
        if (!this.isReady()) return null;
        const uid = await this._uid();
        if (!uid) return null;

        const { data: memberships } = await supabaseClient
            .from('couple_members')
            .select('couple_id, role')
            .eq('profile_id', uid);
        if (!memberships?.length) return null;

        const coupleId = memberships[0].couple_id;
        const { data: couple } = await supabaseClient
            .from('couples')
            .select('*')
            .eq('id', coupleId)
            .single();
        if (!couple) return null;

        const { data: partnerMembers } = await supabaseClient
            .from('couple_members')
            .select('profile_id')
            .eq('couple_id', coupleId)
            .neq('profile_id', uid);

        let partner = null;
        if (partnerMembers?.length) {
            const { data: partnerProfile } = await supabaseClient
                .from('profiles')
                .select('*')
                .eq('id', partnerMembers[0].profile_id)
                .maybeSingle();
            partner = partnerProfile;
        }

        return { ...couple, myRole: memberships[0].role, partner };
    }

    // Requests I sent (join status).
    async getMyRequests() {
        if (!this.isReady()) return [];
        const uid = await this._uid();
        if (!uid) return [];
        const { data, error } = await supabaseClient
            .from('couple_requests')
            .select('*')
            .eq('requester_id', uid)
            .order('created_at', { ascending: false });
        return error ? [] : (data || []);
    }

    // Pending requests for my couple, enriched with the requester's safe
    // public subset. A pending requester is not a confirmed partner yet, so
    // the normal profiles RLS intentionally cannot expose their full row.
    async getPendingRequests(coupleId) {
        if (!this.isReady()) return [];
        const { data, error } = await supabaseClient
            .from('couple_requests')
            .select('id, status, created_at, requester_id')
            .eq('couple_id', coupleId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
        if (error) return [];

        const enriched = [];
        for (const req of data || []) {
            const { data: pub, error: profileError } = await supabaseClient.rpc('get_public_profile', {
                p_user_id: req.requester_id
            });
            const requester = profileError ? null : (Array.isArray(pub) ? (pub[0] || null) : (pub || null));
            enriched.push({ ...req, requester });
        }
        return enriched;
    }
}
