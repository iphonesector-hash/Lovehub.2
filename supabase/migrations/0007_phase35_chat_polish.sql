-- ============================================================================
-- 0007_phase35_chat_polish.sql — LoveHub Phase 3.5 (chat stability + polish)
--
-- ADDITIVE ONLY. Adds per-user chat background preference columns to the
-- existing chat_preferences table. No auth / couple / RLS / storage changes.
-- ============================================================================

-- 1. chat_preferences.background — which LoveHub background pack the user sees
alter table public.chat_preferences
    add column if not exists background text not null default 'aurora'
        check (background in (
            'romantic', 'soft', 'moonlight', 'aurora', 'clouds',
            'sunset', 'autumn', 'ocean', 'stars', 'minimal'
        ));

-- 2. chat_preferences.background_mode — static / blurred / animated rendition
alter table public.chat_preferences
    add column if not exists background_mode text not null default 'static'
        check (background_mode in ('static', 'blur', 'animated'));

-- Existing rows automatically get the defaults; the owner-only RLS policies
-- from migration 0005 already cover the new columns.
