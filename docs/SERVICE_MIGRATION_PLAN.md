# Service Layer Migration Plan

LoveHub currently has **two service layers**. This document records the
audit (which files are active / legacy / dead), the migration target, and a
safe, incremental plan. **No legacy file is deleted as part of Phase 1-4** —
the plan below is the roadmap.

---

## Current state (audited)

### `src/services/` — ACTIVE (ES modules, Supabase-backed)

| File | Used by | Notes |
|---|---|---|
| `SupabaseClient.js` | everything | Singleton client + init status; `isSupabaseReady()` |
| `AuthService.js` | `src/main.js`, `app.js` | Real Supabase auth; single listener + shared boot promise |
| `ProfileService.js` | `src/main.js`, `app.js` | Profile read/update, onboarding, public profile |
| `CoupleService.js` | `src/main.js`, `app.js` | Create/join/leave couples, requests |
| `ChatService.js` | `src/main.js`, `app.js`, `chat-rich.js` | Messages, media, realtime, receipts, prefs, stats |
| `NotificationService.js` | `src/main.js`, `app.js` | Web notifications opt-in + shell |
| `SoundService.js` | `src/main.js`, `chat-rich.js` | WebAudio chimes |

### `services/` — LEGACY (classic scripts loaded by `index.html`)

| File | Status | Evidence |
|---|---|---|
| `StorageService.js` | **Active** | Defines the global `storage` object consumed by `services/AuthService.js` **and** `src/services/AuthService.js` (`usernameEmails` map). Keep. |
| `AuthService.js` | **Active (dev-only)** | Global `authService` used by `app.js` demo fallback (`login`, `getCurrentUser`, `logout`, `changePassword`). Gated behind `isDevMode()` since Phase 1. |
| `UserService.js` | **Active (demo data)** | `userService.getAvatar(...)` used by `app.js` (demo avatars). |
| `HealthService.js` | **Active (demo data)** | `healthService.getTodayData()/getMetrics()` used by `app.js` (demo health screen). |
| `SupabaseService.js` | **Dead** | No references anywhere in app code (only the old `index.html` script tag, removed in Phase 1). |
| `LocalizationService.js` | **Dead** | No references anywhere in app code (script tag removed in Phase 1). |

---

## Migration target

1. **One service layer** — `src/services/` — as the single source of truth.
2. **Legacy files** become: kept-but-unloaded → removed once no references
   remain. No file is deleted in this phase; the two dead files are already
   **unloaded** (Phase 1 removed their `<script>` tags from `index.html`).

## Incremental plan

1. **Demo fallback** (done in Phase 1): legacy `services/AuthService.js` is
   gated behind `isDevMode()` and never persists passwords. When demo mode is
   eventually retired, remove `services/AuthService.js` + its script tag and
   replace the `app.js` demo branches with an explicit "backend not
   configured" screen.
2. **Demo data services** (`UserService`, `HealthService`): fold their two
   small getter surfaces into a single `DemoDataService` under
   `src/services/` (or inline in `data.js`), then unload the legacy files.
3. **StorageService**: keep as the localStorage wrapper for now (used by the
   active `AuthService` username→email map). Its API is already tiny —
   migrate the three methods into `src/services/` and remove the global.
4. **Dead files** (`SupabaseService.js`, `LocalizationService.js`): already
   unloaded; delete them once the above steps land (they are tracked for
   history only).
5. **`supabase/schema.sql`**: stale legacy games-era schema — documented in
   README as "do NOT use". Prefer the numbered migrations.

## Risk notes

- `services/` files define **globals**; `src/services/` files are **ES
  modules**. Any migration must keep both available until the last legacy
  caller is gone.
- `app.js` is a large legacy controller — it is intentionally not rewritten
  (see `MODULARIZATION_PLAN.md`).
