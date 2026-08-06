-- ===========================================================================
-- 0004_phase3_chat.sql — Private couple chat (Phase 3)
--
-- Additive only: a new `messages` table, indexes, RLS policies and the
-- realtime publication. Nothing existing is dropped or rewritten.
--
-- Security model
--   * Rows belong to a couple. A user may only SELECT / INSERT / UPDATE rows
--     whose couple they are a confirmed member of (public.is_couple_member
--     from 0002 — membership only exists once a couple is active).
--   * INSERT requires sender_id = auth.uid() (no spoofing another member).
--   * UPDATE is limited to the read_at column by a before-update trigger, so
--     message content is immutable once sent.
--   * There is intentionally no DELETE policy: messages are permanent.
-- ===========================================================================

-- gen_random_uuid() (pgcrypto ships enabled on Supabase, but be explicit).
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. messages table
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
    id         uuid        primary key default gen_random_uuid(),
    couple_id  uuid        not null references public.couples (id) on delete cascade,
    sender_id  uuid        not null references public.profiles (id) on delete cascade,
    content    text        not null check (char_length(content) between 1 and 4000),
    created_at timestamptz not null default now(),
    read_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- 2. indexes (conversation reads, sender lookups, unread scan)
-- ---------------------------------------------------------------------------
create index if not exists messages_couple_created_idx
    on public.messages (couple_id, created_at);
create index if not exists messages_sender_idx
    on public.messages (sender_id);
create index if not exists messages_couple_unread_idx
    on public.messages (couple_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.messages enable row level security;

-- Read: confirmed members of the row's couple only.
create policy "messages_select_couple_members"
    on public.messages for select
    using (public.is_couple_member(auth.uid(), couple_id));

-- Insert: must be yourself, into a couple you belong to.
create policy "messages_insert_couple_members"
    on public.messages for insert
    with check (
        sender_id = auth.uid()
        and public.is_couple_member(auth.uid(), couple_id)
    );

-- Update (read receipts): couple members only; the trigger below then
-- restricts the change to the read_at column.
create policy "messages_update_couple_members"
    on public.messages for update
    using (public.is_couple_member(auth.uid(), couple_id))
    with check (public.is_couple_member(auth.uid(), couple_id));

-- No delete policy — messages are permanent by design.

-- ---------------------------------------------------------------------------
-- 4. Immutability guard: only read_at may change on UPDATE.
-- ---------------------------------------------------------------------------
create or replace function public.messages_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.couple_id is distinct from old.couple_id
       or new.sender_id is distinct from old.sender_id
       or new.content   is distinct from old.content
       or new.created_at is distinct from old.created_at then
        raise exception 'messages: only read_at may be updated';
    end if;
    return new;
end;
$$;

drop trigger if exists messages_guard_update on public.messages;
create trigger messages_guard_update
    before update on public.messages
    for each row execute function public.messages_guard_update();

-- ---------------------------------------------------------------------------
-- 5. Realtime — broadcast new/updated messages to couple members.
--    (Idempotent: safe to re-run.)
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'messages'
    ) then
        alter publication supabase_realtime add table public.messages;
    end if;
end $$;
