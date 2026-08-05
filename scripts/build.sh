#!/bin/sh
# LoveHub static production build — writes output to dist/.
#
# Runs in a CLEAN deploy checkout, where gitignored files do not exist —
# so supabase/config.js is GENERATED here from deployment environment
# variables instead of relying on a local file (which the workspace only
# has because it serves the live filesystem).
#
#   SUPABASE_URL       e.g. https://xxxxxxxxxxxx.supabase.co
#   SUPABASE_ANON_KEY  the public anon key (never the service_role key)
#
# The generated file keeps the exact SUPABASE_CONFIG interface the app
# already reads ({ url, anonKey }), so no app code needs to change.
# Local/dev builds (env vars unset) fall back to the on-disk config.js.
#
# IMPORTANT: in a clean checkout (GitHub Actions, Freebuff hosting) a missing
# SUPABASE_URL/SUPABASE_ANON_KEY means auth will silently break, so the build
# FAILS loudly instead of shipping a demo-only site.

set -e

rm -rf dist
mkdir -p dist
cp -r index.html style.css app.js data.js utils.js icons.js assets services supabase src dist

if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_ANON_KEY" ]; then
  printf 'const SUPABASE_CONFIG = { url: "%s", anonKey: "%s" };\n' \
    "$SUPABASE_URL" "$SUPABASE_ANON_KEY" > dist/supabase/config.js
  echo "build: generated dist/supabase/config.js from SUPABASE_URL + SUPABASE_ANON_KEY"
elif [ -f dist/supabase/config.js ]; then
  echo "build: shipped local supabase/config.js (dev/preview build)"
else
  echo "build: ERROR — no supabase/config.js produced. Set SUPABASE_URL + SUPABASE_ANON_KEY to enable production auth." >&2
  exit 1
fi
