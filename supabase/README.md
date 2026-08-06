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

## 7. Premium couple chat (Phase 3.2)

Migrations `0004` + `0005` implement the private couple chat:

- **Reads** → RLS on `messages` / `message_reactions` (confirmed couple
  members only — a third account sees zero rows).
- **Writes** → security-definer RPCs only (`send_message`, `edit_message`,
  `delete_message_for_me`, `delete_message_for_everyone`,
  `mark_message_delivered`, `mark_messages_read`, `toggle_message_flag`,
  `react_to_message`). Server rules: sender-only edits (15 min),
  sender-only delete-for-everyone (1 hour), receiver-only read/delivered
  receipts (a sender cannot fake read status), member-only reactions/flags.
- **Realtime** → `messages` + `message_reactions` postgres_changes for
  instant messages, receipts and reactions; a **broadcast** channel for
  typing indicators (never stored); a **presence** channel for online /
  last-seen (`profiles.last_seen_at` persisted via `touch_last_seen`).
- **Preferences** → `chat_preferences` (personal background, owner-private),
  `couple_chat_settings` (shared background, member-scoped),
  `notification_preferences` (private).

### Media messages (architecture — not yet implemented)

`messages.message_type` (`text | image | voice | file`) and `messages.media`
(jsonb) already exist in the schema. When uploads are built:

1. Client uploads to a **Supabase Storage bucket** (`couple-media`,
   path `{couple_id}/{message_id}` — folder RLS via a `couple_id`-owned
   object naming convention, bucket policy keyed to `is_couple_member`).
2. Client calls `send_message` with `media = { kind, url, name, size,
   duration, mime }` + `message_type`.
3. Existing realtime handles the rest — no chat schema changes needed.

### Push notifications (Web / future Android)

In-app (foreground + background-tab) notifications are implemented via the
**Notification API** + `sw.js` (register on user opt-in, never notify while
chat is open, preferences in `notification_preferences`).

Real **Web Push** (works when the tab is closed) requires:

1. Generate a **VAPID key pair** (e.g. `npx web-push generate-vapid-keys`).
2. Add a Supabase **Edge Function** (`send-push`) that verifies the caller
   is a couple member and calls your push provider with the VAPID keys.
3. Expose `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`VAPID_PUBLIC_KEY` as Vercel
   env vars (VAPID_PRIVATE_KEY stays server-side only).
4. Uncomment the `push` handler stub in `sw.js`.

Future Android builds can route through the same Edge Function (FCM) or a
native push service — the client-side `NotificationService` and preference
storage are transport-agnostic.
