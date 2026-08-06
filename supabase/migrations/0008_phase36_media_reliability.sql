-- ===========================================================================
-- 0008_phase36_media_reliability.sql — Media delivery reliability (Phase 3.6)
--
-- Additive only. Builds on 0006. Fixes ONE diagnostic gap:
--
--   * sign_couple_media() swallowed every storage error (`exception when
--     others → v_url := null`), so a transient/real failure was reported to
--     the client as the generic "Could not create signed URL" with no way to
--     tell a permission error, a missing object, or an infra hiccup apart.
--     The client can now read the actual reason and retry intelligently.
--
-- No RLS policy, storage policy, auth, couple, or realtime behavior changes.
-- The membership check order is unchanged (auth → path → member).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. sign_couple_media — surface the real error message.
--    Same signature, same security checks, same 3600s signed URL. The inner
--    exception guard is removed so Postgres reports the true cause
--    (e.g. "row-level security policy violated", "object not found", or a
--    storage outage) instead of a generic null.
-- ---------------------------------------------------------------------------
create or replace function public.sign_couple_media(p_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_couple uuid;
    v_url text;
begin
    if auth.uid() is null then raise exception 'Not authenticated'; end if;
    v_couple := public.media_couple_id(p_path);
    if v_couple is null then raise exception 'Invalid media path'; end if;
    if not public.is_couple_member(auth.uid(), v_couple) then
        raise exception 'Not a member of this couple';
    end if;

    select signed_url into v_url
    from storage.create_signed_url('couples-media', p_path, 3600);

    -- create_signed_url may legitimately return an empty row when the object
    -- does not exist (that is not an exception) — keep a clear error for it.
    if v_url is null then raise exception 'Could not create signed URL: object not found or not accessible'; end if;
    return v_url;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Verification
-- ---------------------------------------------------------------------------
-- -- Member + existing object:
-- select public.sign_couple_media('couples/<couple_id>/images/abc.jpg');
-- -- Member + missing object: now says "object not found or not accessible"
--   instead of the old generic message.
-- -- Non-member: still errors with "Not a member of this couple".
-- -- Anonymous: still errors with "Not authenticated".
