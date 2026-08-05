-- ============================================================
-- LoveHub — Phase 2, Migration 0001: Personal profile fields
-- ADDITIVE ONLY — nothing is dropped.
-- Personal information belongs to profiles; shared relationship
-- information lives on the couples table (migration 0002).
-- Run order: 0001 -> 0002 -> 0003 (Supabase Dashboard > SQL Editor)
-- ============================================================

alter table public.profiles
  add column if not exists date_of_birth date,
  add column if not exists height numeric(5,1),
  add column if not exists weight numeric(5,1),
  add column if not exists gender text
    check (gender is null or gender in ('male','female','other','prefer_not_to_say')),
  add column if not exists city text,
  add column if not exists country text,
  add column if not exists occupation text,
  add column if not exists onboarding_completed boolean not null default false;

-- Backfill: existing users who already have a display name are
-- considered to have completed onboarding (never forces re-entry).
update public.profiles
  set onboarding_completed = true
  where onboarding_completed = false
    and display_name is not null
    and display_name <> '';
