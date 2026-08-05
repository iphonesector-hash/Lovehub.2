-- ============================================================
-- LoveHub — Phase 2, Migration 0003: Profile privacy (tighten now)
--
-- Before: anyone could read any full profile (profiles_select_all).
-- After:
--   * Full profiles (including personal fields) are readable only by
--     the owner and by confirmed couple partners.
--   * A minimal public view (id, username, display_name, avatar_url,
--     status, created_at) remains available to authenticated users for
--     future leaderboards / search / partner discovery.
-- ============================================================

-- Remove the old wide-open read policy.
drop policy if exists profiles_select_all on public.profiles;

-- Full row: owner or confirmed couple partner (same active couple).
create policy "profiles_select_own_or_partner" on public.profiles
  for select using (
    auth.uid() = id
    or public.are_couple_members(auth.uid(), id)
  );

-- Public-facing subset. Plain views run with the owner's (postgres)
-- privileges, so RLS on the base table is intentionally bypassed here —
-- only these columns are exposed, nothing personal.
create or replace view public.profiles_public as
  select id, username, display_name, avatar_url, status, created_at
  from public.profiles;

revoke all on public.profiles_public from anon, authenticated, public;
grant select on public.profiles_public to authenticated;

-- Sanity checks you can run afterwards:
--   select * from public.profiles_public limit 5;
--   select public.is_couple_member(auth.uid(), '<couple_id>');
--   select public.are_couple_members('<uid_a>', '<uid_b>');
