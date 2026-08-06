# LoveHub — Supabase Backend Setup

## 1. Create Supabase project
supabase.com → New Project → wait ~2 min.

## 2. Run the migrations (source of truth)
Dashboard → **SQL Editor** → New query → paste the numbered migration files
in `supabase/migrations/` **in order** (0001 → 0008) and run each one.

> ⚠️ `supabase/schema.sql` at the repo root is a **stale legacy file** from
> the games-era and must NOT be used — it contains none of the chat,
> couples, or media schema the app depends on.

See **`supabase/migrations/README.md`** for the full apply order, what each
migration does, and verification queries.

## 3. Connect the app
1. Copy `supabase/config.example.js` → `supabase/config.js`
2. Fill in `url` and `anonKey` from Dashboard → **Project Settings → API**
3. `config.js` is git-ignored so your keys never get committed

## 4. Auth flow (active layer)
The **active** auth layer is the ES-module `src/services/AuthService.js`
(owned by `src/main.js`), which talks to Supabase Auth directly. The legacy
`services/` folder is a dev-only demo fallback (see
`docs/SERVICE_MIGRATION_PLAN.md`).

## 5. Production deploys (Vercel)

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

## 6. Supabase Auth — URL configuration

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

### Rich media messages (Phase 3.2 — implemented in migration 0006)

`messages.message_type` now supports `text | image | video | audio | voice |
file | drawing | handwritten | sticker | gif | memory`, with flat carriers
`media_url`, `thumbnail_url`, `file_size`, `duration` and the `media` jsonb
column for metadata (e.g. drawing strokes). `content` is nullable so
media-only messages work.

**Secure media flow** (all in `0006_phase3_rich_media.sql`):

1. Client uploads to the **private** `couples-media` Storage bucket under
   `couples/{couple_id}/images|videos|audio|drawings/<file>` — object
   policies only allow confirmed couple members (via `is_couple_member`).
2. Client calls `send_media_message(...)` (security definer) which
   re-validates membership + type and inserts the row.
3. Bubbles never receive raw paths — `sign_couple_media(path)` returns a
   **1-hour signed URL** only to confirmed members (`ChatService.getMediaUrl`).
4. Existing realtime delivers the new message instantly; no extra schema.

Image/video uploads are client-compressed (max 1600px JPEG) and previewed
before sending; drawings/handwritten notes store stroke data for replay;
voice messages store WebM with duration + waveform.

### Chat sounds (Phase 3.2)

Soft send/receive chimes are generated with **WebAudio** (`SoundService`, no
assets). `chat_preferences.sounds_enabled` + `sound_theme` (romantic /
premium / night) are private per user. The app never plays a receive sound
while the chat is the active, visible page, and dedupes by message id.

### Music Room & AI Love Assistant (Phase 3.2)

- **Music Room** plays procedural ambient "LoveHub originals" generated in
  the browser via WebAudio (no audio files). Replacing this with real tracks
  later needs no schema change.
- **AI Love Assistant** is a curated local generator (love messages, date
  ideas, gifts, goodnight). To plug in a real model later, swap
  `chat-rich.js → aiAnswer()` for a Supabase Edge Function call — the
  sheet UI, chips and preferences stay as-is. No keys are required today.

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
