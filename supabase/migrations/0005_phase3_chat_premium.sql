-- ===========================================================================
-- 0005_phase3_chat_premium.sql — Premium couple messaging (Phase 3.2)
--
-- Additive only. Builds on 0004 (messages + RLS + realtime). Adds:
--   * message metadata (media/status/edited/deleted/reply/flags)
--   * emoji reactions (separate table, realtime-enabled)
--   * chat_preferences (personal) + couple_chat_settings (shared)
--   * notification_preferences (private) + profiles.last_seen_at
--   * security-definer RPCs for every message mutation (server-enforced rules)
--   * a stricter update guard (only the receiver may set delivered/read,
--     only the sender may edit/delete, flags are member-scoped)
--
-- Nothing existing is dropped or rewritten (the 0004 guard trigger is
-- recreated with the wider allowed-column set — that is an in-place upgrade).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. messages — additive metadata columns
-- ---------------------------------------------------------------------------
alter table public.messages
    add column if not exists message_type text not null default 'text'
        check (message_type in ('text', 'image', 'voice', 'file')),
    add column if not exists media jsonb,                                    -- future: {kind, url, name, size, duration, mime}
    add column if not exists delivered_at timestamptz,
    add column if not exists edited_at timestamptz,
    add column if not exists edited_by uuid references public.profiles (id) on delete set null,
    add column if not exists reply_to_id uuid references public.messages (id) on delete set null,
    add column if not exists reply_to_content text,
    add column if not exists reply_to_sender_id uuid,
    add column if not exists deleted_for uuid[] not null default '{}',
    add column if not exists deleted_at timestamptz,
    add column if not exists pinned boolean not null default false,
    add column if not exists favorite boolean not null default false,
    add column if not exists saved_to_memories boolean not null default false;

create index if not exists messages_reply_to_idx on public.messages (reply_to_id);
create index if not exists messages_live_idx on public.messages (couple_id, created_at) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. message_reactions — emoji reactions (RLS read; writes via RPC only)
-- ---------------------------------------------------------------------------
create table if not exists public.message_reactions (
    message_id uuid not null references public.messages (id) on delete cascade,
    profile_id uuid not null references public.profiles (id) on delete cascade,
    couple_id  uuid not null references public.couples (id) on delete cascade,
    emoji      text not null check (char_length(emoji) between 1 and 8),
    created_at timestamptz not null default now(),
    primary key (message_id, profile_id, emoji)
);

create index if not exists message_reactions_couple_idx on public.message_reactions (couple_id, created_at);
create index if not exists message_reactions_message_idx on public.message_reactions (message_id);

alter table public.message_reactions enable row level security;

-- Confirmed couple members may read each other's reactions.
create policy "message_reactions_select_members"
    on public.message_reactions for select
    using (public.is_couple_member(auth.uid(), couple_id));

-- No direct write policies — adding/removing reactions goes through the
-- react_to_message() RPC which validates membership and only mutates the
-- caller's own reaction.

-- ---------------------------------------------------------------------------
-- 3. chat_preferences — personal chat appearance (owner-private)
-- ---------------------------------------------------------------------------
create table if not exists public.chat_preferences (
    profile_id       uuid primary key references public.profiles (id) on delete cascade,
    couple_id        uuid references public.couples (id) on delete set null,
    background_theme text not null default 'dark'
        check (background_theme in ('romantic', 'dark', 'minimal', 'sunset', 'hearts', 'custom')),
    background_color text,
    updated_at       timestamptz not null default now()
);

alter table public.chat_preferences enable row level security;
create policy "chat_preferences_owner_select" on public.chat_preferences for select using (profile_id = auth.uid());
create policy "chat_preferences_owner_insert" on public.chat_preferences for insert with check (profile_id = auth.uid());
create policy "chat_preferences_owner_update" on public.chat_preferences for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. couple_chat_settings — couple-shared chat appearance (member-scoped)
-- ---------------------------------------------------------------------------
create table if not exists public.couple_chat_settings (
    couple_id        uuid primary key references public.couples (id) on delete cascade,
    background_theme text not null default 'dark'
        check (background_theme in ('romantic', 'dark', 'minimal', 'sunset', 'hearts', 'custom')),
    background_color text,
    updated_by       uuid references public.profiles (id) on delete set null,
    updated_at       timestamptz not null default now()
);

alter table public.couple_chat_settings enable row level security;
create policy "couple_chat_settings_members_select" on public.couple_chat_settings for select using (public.is_couple_member(auth.uid(), couple_id));
create policy "couple_chat_settings_members_insert" on public.couple_chat_settings for insert with check (public.is_couple_member(auth.uid(), couple_id));
create policy "couple_chat_settings_members_update" on public.couple_chat_settings for update using (public.is_couple_member(auth.uid(), couple_id)) with check (public.is_couple_member(auth.uid(), couple_id));

-- ---------------------------------------------------------------------------
-- 5. notification_preferences — private per-user
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
    profile_id               uuid primary key references public.profiles (id) on delete cascade,
    messages_enabled         boolean not null default true,
    couple_requests_enabled  boolean not null default true,
    events_enabled           boolean not null default true,
    updated_at               timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;
create policy "notification_preferences_owner_select" on public.notification_preferences for select using (profile_id = auth.uid());
create policy "notification_preferences_owner_insert" on public.notification_preferences for insert with check (profile_id = auth.uid());
create policy "notification_preferences_owner_update" on public.notification_preferences for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. profiles.last_seen_at (presence persistence — additive)
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- 7. Updated update-guard trigger.
--    Rules (checked against auth.uid()):
--      * immutable core fields can never change
--      * only the SENDER may edit content / set deleted_at
--      * only the RECEIVER may set delivered_at / read_at
--      * either member may toggle pinned / favorite / saved_to_memories
--      * deleted_for may only ever gain the caller's own uid
-- ---------------------------------------------------------------------------
drop trigger if exists messages_guard_update on public.messages;

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

    -- deleted_for may only grow by the caller's own uid (and never shrink).
    if new.deleted_for is distinct from old.deleted_for then
        if new.deleted_for <@ old.deleted_for
           or new.deleted_for <> array_append(old.deleted_for, v_uid) then
            raise exception 'messages: can only delete for yourself';
        end if;
    end if;

    return new;
end;
$$;

create trigger messages_guard_update
    before update on public.messages
    for each row execute function public.messages_guard_update();

-- ---------------------------------------------------------------------------
-- 8. Security-definer RPCs — every message mutation goes through these so the
--    server enforces membership, sender/receiver rules and time limits.
-- ---------------------------------------------------------------------------

-- 8.1 Send a message (optionally a reply to another message, snapshot stored).
create or replace function public.send_message(
    p_couple_id uuid,
    p_content text,
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
    if p_content is null or length(trim(p_content)) = 0 then
        raise exception 'Message is empty';
    end if;
    if length(p_content) > 4000 then
        raise exception 'Message too long (max 4000 characters)';
    end if;

    if p_reply_to_id is not null then
        select * into v_reply
        from public.messages
        where id = p_reply_to_id
          and public.is_couple_member(v_uid, couple_id);
        if v_reply is null then raise exception 'Reply message not found'; end if;
    end if;

    insert into public.messages (couple_id, sender_id, content, reply_to_id, reply_to_content, reply_to_sender_id)
    values (p_couple_id, v_uid, p_content, p_reply_to_id, v_reply.content, v_reply.sender_id)
    returning * into v_msg;

    return v_msg;
end;
$$;

-- 8.2 Edit your own message (15-minute window).
create or replace function public.edit_message(p_message_id uuid, p_content text)
returns public.messages
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
    v_msg public.messages;
begin
    if v_uid is null then raise exception 'Not authenticated'; end if;
    if p_content is null or length(trim(p_content)) = 0 then
        raise exception 'Message is empty';
    end if;
    if length(p_content) > 4000 then raise exception 'Message too long (max 4000 characters)'; end if;

    update public.messages m
       set content = p_content, edited_at = now(), edited_by = v_uid
     where m.id = p_message_id
       and m.sender_id = v_uid
       and m.deleted_at is null
       and now() - m.created_at < interval '15 minutes'
     returning * into v_msg;

    if v_msg is null then
        raise exception 'Cannot edit: message not found, not yours, already deleted, or past the 15-minute window';
    end if;
    return v_msg;
end;
$$;

-- 8.3 Delete for me (soft — hides the row only for the caller).
create or replace function public.delete_message_for_me(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Not authenticated'; end if;
    update public.messages m
       set deleted_for = case
                            when v_uid = any (coalesce(m.deleted_for, '{}')) then m.deleted_for
                            else array_append(coalesce(m.deleted_for, '{}'), v_uid)
                         end
     where m.id = p_message_id
       and public.is_couple_member(v_uid, m.couple_id);
    if not found then raise exception 'Message not found'; end if;
end;
$$;

-- 8.4 Delete for everyone (sender only, 1-hour window).
create or replace function public.delete_message_for_everyone(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Not authenticated'; end if;
    update public.messages m
       set deleted_at = now(), content = null
     where m.id = p_message_id
       and m.sender_id = v_uid
       and m.deleted_at is null
       and now() - m.created_at < interval '1 hour';
    if not found then
        raise exception 'Cannot delete: not your message, already deleted, or past the 1-hour window';
    end if;
end;
$$;

-- 8.5 Mark a partner message as delivered (receiver only).
create or replace function public.mark_message_delivered(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Not authenticated'; end if;
    update public.messages m
       set delivered_at = now()
     where m.id = p_message_id
       and m.sender_id <> v_uid
       and public.is_couple_member(v_uid, m.couple_id)
       and m.delivered_at is null;
    if not found then raise exception 'Message not found or not deliverable'; end if;
end;
$$;

-- 8.6 Mark all partner messages read (receiver only).
create or replace function public.mark_messages_read(p_couple_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Not authenticated'; end if;
    if not public.is_couple_member(v_uid, p_couple_id) then
        raise exception 'Not a member of this couple';
    end if;
    update public.messages m
       set read_at = now()
     where m.couple_id = p_couple_id
       and m.sender_id <> v_uid
       and m.read_at is null;
end;
$$;

-- 8.7 Toggle a member flag (pinned / favorite / saved_to_memories).
create or replace function public.toggle_message_flag(p_message_id uuid, p_flag text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Not authenticated'; end if;
    if p_flag not in ('pinned', 'favorite', 'saved_to_memories') then
        raise exception 'Invalid flag';
    end if;
    execute format(
        'update public.messages m set %I = not %I where m.id = $1 and public.is_couple_member($2, m.couple_id)',
        p_flag, p_flag
    ) using p_message_id, v_uid;
    if not found then raise exception 'Message not found'; end if;
end;
$$;

-- 8.8 Toggle the caller's emoji reaction (returns true when added, false when removed).
create or replace function public.react_to_message(p_message_id uuid, p_emoji text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
    v_couple uuid;
    v_added boolean;
begin
    if v_uid is null then raise exception 'Not authenticated'; end if;
    if p_emoji is null or char_length(p_emoji) > 8 then raise exception 'Invalid emoji'; end if;

    select couple_id into v_couple from public.messages where id = p_message_id;
    if v_couple is null or not public.is_couple_member(v_uid, v_couple) then
        raise exception 'Message not found';
    end if;

    if exists (
        select 1 from public.message_reactions
        where message_id = p_message_id and profile_id = v_uid and emoji = p_emoji
    ) then
        delete from public.message_reactions
        where message_id = p_message_id and profile_id = v_uid and emoji = p_emoji;
        v_added := false;
    else
        insert into public.message_reactions (message_id, profile_id, couple_id, emoji)
        values (p_message_id, v_uid, v_couple, p_emoji);
        v_added := true;
    end if;

    return v_added;
end;
$$;

-- 8.9 Persist "last seen" for presence (called when the app goes hidden).
create or replace function public.touch_last_seen()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then return; end if;
    update public.profiles set last_seen_at = now() where id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Realtime — reactions join the publication (idempotent).
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'message_reactions'
    ) then
        alter publication supabase_realtime add table public.message_reactions;
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Verification queries
-- ---------------------------------------------------------------------------
-- -- 1. Send + reply
-- select public.send_message('<couple_id>', 'Hello love ❤️');
-- select public.send_message('<couple_id>', 'Replied', '<message_id>');
-- -- 2. Receipts (as the PARTNER): delivered then read
-- select public.mark_message_delivered('<message_id>');
-- select public.mark_messages_read('<couple_id>');
-- -- 3. Sender cannot fake read status (must error)
-- --   (as the SENDER) select public.mark_message_delivered('<message_id>');
-- -- 4. Edit / delete limits
-- select public.edit_message('<message_id>', 'Edited text');
-- select public.delete_message_for_everyone('<message_id>');
-- -- 5. Reactions
-- select public.react_to_message('<message_id>', '❤️');
-- select emoji, count(*) from public.message_reactions where couple_id = '<couple_id>' group by emoji;
-- -- 6. A non-member select returns zero rows (RLS):
-- select count(*) from public.messages where couple_id = '<other_couple_id>';
