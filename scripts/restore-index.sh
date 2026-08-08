#!/bin/sh
# Reconstruct index.html from base64 parts
set -e
PARTS_DIR="scripts/index-restore"
OUT="${1:-index.html}"
if [ ! -d "$PARTS_DIR" ]; then
  echo "restore-index: no parts dir" >&2
  exit 1
fi
TMP=$(mktemp)
cat "$PARTS_DIR"/p*.b64 | base64 -d > "$TMP"
if ! grep -q "LoveHub" "$TMP"; then
  echo "restore-index: invalid decode" >&2
  rm -f "$TMP"
  exit 1
fi
mv "$TMP" "$OUT"
echo "restore-index: wrote $OUT ($(wc -c < "$OUT") bytes)"
