-- ===========================================================================
-- 0006_phase3_rich_media.sql — Rich media messages + chat sounds (Phase 3.2)
--
-- Additive only. Builds on 0005 (premium chat). Adds:
--   * expanded message_type set (video, drawing, handwritten, sticker, gif,
--     memory) and flat media columns (media_url, thumbnail_url, file_size,
--     duration) so image/video/voice/drawing content has typed carriers
--   * content becomes nullable (media-only messages have no text)
--   * chat_preferences.sounds_enabled + sound_theme (private)
--   * a PRIVATE Supabase Storage bucket `couples-media` with member-only RLS:
--       couples/{couple_id}/images|videos|audio|drawings/<file>
--     - no public URLs; the only way to read media is the sign_couple_media()
--       RPC, which verifies confirmed couple membership before minting a
--       short-lived signed URL
--   * send_media_message() — server-validated media insert
--   * sign_couple_media()  — member-checked signed URL
--   * the 0005 update-guard is extended so the new media columns are immutable
--
-- Nothing existing is dropped. Message rows and reactions are untouched.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. messages — richer media model (additive)
-- ---------------------------------------------------------------------------
alter table public.messages
    alter column content drop not null;

alter table public.messages
    drop constraint if exists messages_message_type_check;
alter table public.messages
    add constraint messages_message_type_check
        check (message_type in ('text', 'image', 'video', 'audio', 'voice',
                                'file', 'drawing', 'handwritten', 'sticker',
                                'gif', 'memory'));

alter table public.messages
    add column if not exists media_url text,       -- storage path couples/{couple_id}/...
    add column if not exists thumbnail_url text,   -- snapshot/thumbnail storage path
    add column if not exists file_size bigint,     -- bytes (for upload UI / quotas)
    add column if not exists duration numeric;     -- seconds (voice/video)

-- media (jsonb, from 0005) continues to carry rich metadata:
--   * image/video : { width, height, mime }
--   * voice/audio : { mime, sampleRate }
--   * drawing/handwritten : { strokes: [...], width, height, mode }
--   * sticker     : { pack, name }
--   * memory      : { event }

-- ---------------------------------------------------------------------------
-- 2. chat_preferences — chat sounds (private per-user)
-- ---------------------------------------------------------------------------
alter table public.chat_preferences
    add column if not exists sounds_enabled boolean not null default true;
alter table public.chat_preferences
    add column if not exists sound_theme text not null default 'romantic'
        check (sound_theme in ('romantic', 'premium', 'night'));

-- ---------------------------------------------------------------------------
-- 3. Private media storage — couples/{couple_id}/<kind>/<file>
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'couples-media',
    'couples-media',
    false,
    10485760, -- 10 MB per file
    '{"image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","audio/webm","audio/mp4","audio/mpeg"}'
)
on conflict (id) do nothing;

-- The helper below derives the couple_id from the storage path. All LoveHub
-- media lives under couples/{couple_id}/..., so membership alone decides
-- access — a third account can neither list, upload to, nor read media.

create or replace function public.media_couple_id(p_name text)
returns uuid
language sql
immutable
as $$
    select case
        when (storage.foldername(p_name))[1] = 'couples'
             and (storage.foldername(p_name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (storage.foldername(p_name))[2]::uuid
        else null
    end;
$$;

-- Storage objects RLS is enabled by Supabase by default; these policies are
-- the ONLY access path. Insert/update/select are restricted to confirmed
-- members of the couple named in the path. There is deliberately NO anon or
-- public policy — private bucket, no public URLs.
create policy "couples_media_member_insert"
    on storage.objects for insert
    with check (
        bucket_id = 'couples-media'
        and auth.uid() is not null
        and public.media_couple_id(name) is not null
        and public.is_couple_member(auth.uid(), public.media_couple_id(name))
    );

create policy "couples_media_member_update"
    on storage.objects for update
    using (
        bucket_id = 'couples-media'
        and auth.uid() is not null
        and public.media_couple_id(name) is not null
        and public.is_couple_member(auth.uid(), public.media_couple_id(name))
    )
    with check (
        bucket_id = 'couples-media'
        and auth.uid() is not null
        and public.media_couple_id(name) is not null
        and public.is_couple_member(auth.uid(), public.media_couple_id(name))
    );

create policy "couples_media_member_select"
    on storage.objects for select
    using (
        bucket_id = 'couples-media'
        and auth.uid() is not null
        and public.media_couple_id(name) is not null
        and public.is_couple_member(auth.uid(), public.media_couple_id(name))
    );

-- ---------------------------------------------------------------------------
-- 4. Security-definer RPCs
-- ---------------------------------------------------------------------------

-- 4.1 Send a media message (validates membership + type; content optional).
create or replace function public.send_media_message(
    p_couple_id uuid,
    p_message_type text,
    p_content text default null,
    p_media_url text default null,
    p_thumbnail_url text default null,
    p_file_size bigint default null,
    p_duration numeric default null,
    p_metadata jsonb default null,
    p_reply_to_id uuid default null
)
returns public.messages
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
    v_reply public.messages;
    v_msg public.messages;
begin
    if v_uid is null then raise exception 'Not authenticated'; end if;
    if not public.is_couple_member(v_uid, p_couple_id) then
        raise exception 'Not a member of this couple';
    end if;
    if p_message_type is null
       or p_message_type not in ('text', 'image', 'video', 'audio', 'voice',
                                 'file', 'drawing', 'handwritten', 'sticker',
                                 'gif', 'memory') then
        raise exception 'Invalid message type';
    end if;
    if p_content is not null and char_length(p_content) > 4000 then
        raise exception 'Message too long (max 4000 characters)';
    end if;

    if p_reply_to_id is not null then
        select * into v_reply
        from public.messages
        where id = p_reply_to_id
          and public.is_couple_member(v_uid, couple_id);
        if v_reply is null then raise exception 'Reply message not found'; end if;
    end if;

    insert into public.messages (
        couple_id, sender_id, content, message_type,
        media, media_url, thumbnail_url, file_size, duration,
        reply_to_id, reply_to_content, reply_to_sender_id
    ) values (
        p_couple_id, v_uid, p_content, p_message_type,
        p_metadata, p_media_url, p_thumbnail_url, p_file_size, p_duration,
        p_reply_to_id, v_reply.content, v_reply.sender_id
    )
    returning * into v_msg;

    return v_msg;
end;
$$;

-- 4.2 Mint a short-lived signed URL for couple media — ONLY for confirmed
--     members of the couple in the path. Non-members get a hard error (and
--     RLS means they could never obtain the object anyway).
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

    begin
        select signed_url into v_url
        from storage.create_signed_url('couples-media', p_path, 3600);
    exception when others then
        v_url := null;
    end;

    if v_url is null then raise exception 'Could not create signed URL'; end if;
    return v_url;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Update-guard upgrade — the new media columns are immutable once sent.
--    (create or replace keeps the existing trigger attached.)
-- ---------------------------------------------------------------------------
create or replace function public.messages_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null or not public.is_couple_member(v_uid, old.couple_id) then
        raise exception 'messages: not a member of this couple';
    end if;

    -- Immutable core.
    if new.id is distinct from old.id
       or new.couple_id is distinct from old.couple_id
       or new.sender_id is distinct from old.sender_id
       or new.created_at is distinct from old.created_at
       or new.message_type is distinct from old.message_type
       or new.media is distinct from old.media
       or new.media_url is distinct from old.media_url
       or new.thumbnail_url is distinct from old.thumbnail_url
       or new.file_size is distinct from old.file_size
       or new.duration is distinct from old.duration
       or new.reply_to_id is distinct from old.reply_to_id
       or new.reply_to_content is distinct from old.reply_to_content
       or new.reply_to_sender_id is distinct from old.reply_to_sender_id then
        raise exception 'messages: immutable fields cannot change';
    end if;

    -- Only the sender may edit content.
    if (new.content is distinct from old.content
        or new.edited_at is distinct from old.edited_at
        or new.edited_by is distinct from old.edited_by)
       and v_uid <> old.sender_id then
        raise exception 'messages: only the sender can edit';
    end if;

    -- Only the receiver may mark delivered / read.
    if (new.delivered_at is distinct from old.delivered_at
        or new.read_at is distinct from old.read_at)
       and v_uid = old.sender_id then
        raise exception 'messages: only the receiver can mark delivered/read';
    end if;

    -- delete_for_everyone: sender only.
    if new.deleted_at is distinct from old.deleted_at and v_uid <> old.sender_id then
        raise exception 'messages: only the sender can delete for everyone';
    end if;

    -- deleted_for may only ever grow by the caller's own uid (and never shrink).
    if new.deleted_for is distinct from old.deleted_for then
        if new.deleted_for <@ old.deleted_for
           or new.deleted_for <> array_append(old.deleted_for, v_uid) then
            raise exception 'messages: can only delete for yourself';
        end if;
    end if;

    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Realtime — messages + reactions are already published (0004/0005).
--    No new tables here, so nothing else to publish.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 7. Verification
-- ---------------------------------------------------------------------------
-- -- 1. Media message (as a couple member):
-- select public.send_media_message(
--   '<couple_id>', 'image',
--   p_media_url => 'couples/<couple_id>/images/abc.jpg',
--   p_thumbnail_url => 'couples/<couple_id>/images/abc_thumb.jpg',
--   p_file_size => 204800, p_metadata => '{"width":1600,"height":1200,"mime":"image/jpeg"}'::jsonb
-- );
-- -- 2. Signed URL (member): returns a URL valid for 1 hour
-- select public.sign_couple_media('couples/<couple_id>/images/abc.jpg');
-- -- 3. Non-member calls error on both RPCs (is_couple_member fails).
-- -- 4. Text path still works unchanged:
-- select public.send_message('<couple_id>', 'Hello love ❤️');
