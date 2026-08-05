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

## 6. Production deploys (Vercel)

`supabase/config.js` is git-ignored, so a clean deploy checkout never has it.
The build (`scripts/build.sh`) therefore GENERATES `dist/supabase/config.js`
from environment variables, keeping the exact `SUPABASE_CONFIG` interface
`SupabaseClient.js` already reads — no app code changes between environments.

### Vercel project setup

`vercel.json` pins the build:

```json
{
  "buildCommand": "sh ./scripts/build.sh",
  "outputDirectory": "dist",
  "framework": null
}
```

1. Import the repo on Vercel (framework detection falls back to "Other" —
   `vercel.json` supplies the build command and output directory).
2. Add environment variables (Project → Settings → Environment Variables),
   applying them to Production, Preview, and Development:
   - `SUPABASE_URL` — e.g. `https://xxxx.supabase.co`
   - `SUPABASE_ANON_KEY` — the public anon key (never the service_role key)
3. Deploy. The build script writes `dist/supabase/config.js` from those env
   vars. If they are missing the build fails loudly with
   "no supabase/config.js produced" instead of shipping a demo-only site.

### Freebuff hosting (optional)

The same build script works there: set `SUPABASE_URL` and `SUPABASE_ANON_KEY`
as deployment env vars (`freebuff-deploy env set` …) so the deploy build
generates the config too.

### Supabase Auth — URL configuration

Dashboard → Authentication → URL Configuration:

- **Site URL:** your Vercel production domain
  (e.g. `https://lovehub.vercel.app` or your custom domain)
- **Redirect URLs** — add each environment, with `**` for sub-paths:
  - `https://<your-vercel-project>.vercel.app/**` (production)
  - `https://<your-vercel-project>-git-*.vercel.app/**` (preview branches)
  - the Freebuff preview URL (e.g. `https://*.daytonaproxy01.net/**`)

`AuthService` sends `redirectTo` = current origin + path (normalized to the
app root, `index.html` stripped), so email-confirmation and password-reset
links land back on the app on whichever domain it is served from, where
`detectSessionInUrl` processes the token.
