# LoveHub — Supabase migrations (Phase 2)

All migrations are **additive**: new nullable columns, new tables, new
functions. Nothing is dropped or rewritten. Apply them in order in
**Supabase Dashboard → SQL Editor → New query → Run**.

## Apply order

| # | File | What it does |
|---|------|--------------|
| 1 | `0001_phase2_profile_fields.sql` | Adds personal fields to `profiles` (`date_of_birth`, `height`, `weight`, `gender`, `city`, `country`, `occupation`, `onboarding_completed`) |
| 2 | `0002_phase2_couples.sql` | Creates `couples`, `couple_members`, `couple_requests` + helper functions + RLS + security-definer RPCs |
| 3 | `0003_phase2_profile_privacy.sql` | **Tightens** `profiles` RLS to owner-or-confirmed-partner only; adds public `profiles_public` view |
| 4 | `0004_phase3_chat.sql` | Adds `messages` table (couple conversations) + indexes + RLS (couple-members only, `sender_id = auth.uid()` on insert, read-at-only updates) + realtime publication |

> `0003` depends on the `are_couple_members()` helper from `0002` — apply in order.

## Verification queries (run after applying)

```sql
-- 1. Public view exists and exposes ONLY public columns
select id, username, display_name, avatar_url, status
from public.profiles_public
limit 5;

-- 2. Helpers work (replace ids)
select public.is_couple_member('<uid>', '<couple_id>');
select public.are_couple_members('<uid_a>', '<uid_b>');

-- 3. Create a couple (as a verified, logged-in user from the app)
select public.create_couple('partner@example.com');

-- 4. Join with code + exact email (as the partner, from the app)
select public.join_couple('<CODE>', 'partner@example.com');

-- 5. Approve (as the creator, from the app)
select public.respond_to_couple_request('<request_id>', true);

-- 6. After approval: couple is active and both can read each other's profile
select status, relationship_started_on from public.couples;
select count(*) from public.couple_members;
```

## Notes / intended behavior

- **Writes to couple tables are RPC-only.** There are no client
  INSERT/UPDATE/DELETE policies on `couples` / `couple_members` /
  `couple_requests`; everything goes through `create_couple`,
  `join_couple`, `respond_to_couple_request`, `cancel_couple`,
  `leave_couple`.
- **Both users must be email-verified** before creating/joining.
- **Exact email match**: the partner's email must match the one the
  creator specified (case-insensitive). The join error is generic
  (`Invalid invite code or email.`) so invite codes can't be probed.
- **Leaving** removes the whole couple (both members are freed).
- `profiles_public` runs as the view owner (postgres) so RLS on the
  base table is bypassed **only for those 6 public columns**.
- **Chat (0004):** `messages` reads/inserts/updates are RLS-scoped to
  `is_couple_member(auth.uid(), couple_id)`; inserts require
  `sender_id = auth.uid()`; a trigger restricts updates to `read_at` only;
  there is no DELETE policy (messages are permanent).
