-- ===========================================================================
-- 0009 — Phase 5: Music Room + profile polish (ADDITIVE ONLY).
--
-- * Adds a few nullable personalisation columns to profiles (no-op if the
--   columns already exist — e.g. bio/status may exist from older setups).
-- * Creates ONE new table, music_favorites: the couple's shared song library.
--   It doubles as "favorites" (5.6) and the couple playlist / shared songs
--   (5.9): every confirmed couple member can read the whole list, anyone can
--   add (their profile_id is stamped), and anyone can remove. RLS keeps it
--   scoped to the couple — another couple's library is invisible.
--
-- No existing table, column, index, or RLS policy is modified.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Profile polish (5.13) — idempotent; `add column if not exists` is a no-op
--    when the column is already present.
-- ---------------------------------------------------------------------------
alter table public.profiles
    add column if not exists status text,
    add column if not exists bio text,
    add column if not exists mood text,
    add column if not exists profile_theme text not null default 'default';

-- ---------------------------------------------------------------------------
-- 2. music_favorites — couple-scoped shared song library (5.6 / 5.9).
--    Stored metadata is small (title/artist/source/urls) — never the audio
--    file itself, per the "no third-party audio storage" rule.
-- ---------------------------------------------------------------------------
create table if not exists public.music_favorites (
    id            uuid        primary key default gen_random_uuid(),
    couple_id     uuid        not null references public.couples (id) on delete cascade,
    profile_id    uuid        not null references public.profiles (id) on delete cascade,
    title         text        not null,
    artist        text,
    source        text,
    page_url      text,
    playable_url  text        not null,
    artwork_url   text,
    duration      numeric,
    metadata      jsonb       not null default '{}'::jsonb,
    created_at    timestamptz not null default now()
);

create index if not exists music_favorites_couple_idx
    on public.music_favorites (couple_id, created_at desc);

alter table public.music_favorites enable row level security;

-- Confirmed couple members may read the couple's shared song library.
create policy "music_favorites_select_members"
    on public.music_favorites for select
    using (public.is_couple_member(auth.uid(), couple_id));

-- Confirmed couple members may add a song; the row is stamped with their id.
create policy "music_favorites_insert_members"
    on public.music_favorites for insert
    with check (
        public.is_couple_member(auth.uid(), couple_id)
        and profile_id = auth.uid()
    );

-- Members may remove songs from the couple's shared library (own or partner's).
create policy "music_favorites_delete_members"
    on public.music_favorites for delete
    using (public.is_couple_member(auth.uid(), couple_id));
