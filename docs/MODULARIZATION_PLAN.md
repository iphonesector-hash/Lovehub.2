# Modularization Plan — Large Files

`app.js` (~124 KB) and `chat-rich.js` (~124 KB) are the two largest source
files. They are **not split in Phase 1-4** on purpose: a naive split of a
legacy prototype-based controller is the single highest-risk change in this
codebase. This document is the safe, incremental plan.

## Why not split now

- `app.js` defines one `LoveHub` class; `chat-rich.js` wraps its prototype
  methods via a `wrap()` helper. Splitting either file means moving methods
  across files and preserving the **exact prototype shape** — any missed
  method breaks the app silently.
- There is no module system between the two files (classic scripts, global
  `LoveHub`), so a "clean" split requires introducing a bundler or keeping
  globals.
- The immediate, safe performance wins (image compression, service worker
  caching, dead script-tag removal) are already done in Phase 1-3.

## Incremental plan (when ready)

1. **Extract pure helpers first** (zero behavior change):
   - `utils.js` already holds formatting/escape/toast helpers — move more
     stateless functions (date math, duration formatting, debounce) there.
   - `data.js` already holds static catalogs — move the `_musicTracks()`
     and `_gifRegistry()` constants there.
2. **Extract self-contained feature objects** into classic scripts loaded
   BEFORE `app.js` (same pattern as `utils.js` / `icons.js` / `stickers.js`):
   - Music Room (WebAudio scheduler) — `music-room.js`
   - AI assistant (local generator) — `ai-assistant.js`
   - Voice recording (MediaRecorder + waveform) — `voice-recorder.js`
   Each becomes a plain object (`window.LoveHubMusic = {...}`) that
   `chat-rich.js` calls — no prototype moves required.
3. **Then, and only then**, consider splitting `app.js` by page (home /
   chat / profile / memories) using the same "extend the class" pattern
   `chat-rich.js` already proves works (`LoveHub.prototype.x = ...` in
   separately loaded files).

## Guardrails

- One feature per file, loaded in order in `index.html` before the file
  that consumes it.
- Run `node --check` after every move; verify the affected page manually
  (the app has no automated test suite today).
- Never delete a method while any call site references it — use
  `grep -n` to confirm before removing.
