# LoveHub Games — Backend Setup (Phase 1)

## 1. Create Supabase project
See chat instructions — supabase.com → New Project → wait ~2 min.

## 2. Run the schema
Dashboard → **SQL Editor** → New query → paste the entire contents of
`supabase/schema.sql` → **Run**.
This creates all tables (profiles, friendships, rooms, matches, economy,
achievements, leaderboard view), Row Level Security policies, the
auto-profile-on-signup trigger, and seeds the first 4 games (bilingual).

## 3. Connect the app
1. Copy `supabase/config.example.js` → `supabase/config.js`
2. Fill in `url` and `anonKey` from Dashboard → **Project Settings → API**
3. `config.js` is git-ignored so your keys never get committed

## 4. What's wired so far
- `services/SupabaseService.js` — auth, profiles, friends, rooms,
  leaderboard, coin transactions
- Loaded in `index.html`, but **not yet replacing** `AuthService`/
  `StorageService` — it runs alongside so the existing app keeps working
  while we test the connection

## 5. Next step (once keys are added)
Migrate `app.js` login/profile/games flows to call `supabaseService`
instead of `authService`/`storage`, one screen at a time, starting with
login/signup.
