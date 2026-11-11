#!/usr/bin/env bash
# ============================================================
# ALNOKHBA QB — restore from a backup archive
#   bash scripts/restore.sh backups/anqb-YYYYmmdd-HHMMSS.tar.gz
# Stops nothing automatically — stop the app first in production!
# ============================================================
set -euo pipefail

ARCHIVE="${1:?usage: restore.sh <backup.tar.gz>}"
[ -f "$ARCHIVE" ] || { echo "archive not found: $ARCHIVE"; exit 1; }

TMP="$(mktemp -d)"
tar -xzf "$ARCHIVE" -C "$TMP"
DIR="$(find "$TMP" -maxdepth 1 -type d -name 'anqb-*' | head -1)"
[ -n "$DIR" ] || { echo "bad archive layout"; exit 1; }

echo "[restore] restoring from $DIR"

# database
cp "$DIR/custom.db" "./db/custom.db"
echo "[restore] database restored (db/custom.db)"

# files
for folder in uploads scans assignments; do
  if [ -d "$DIR/$folder" ]; then
    rm -rf "db/$folder"
    cp -r "$DIR/$folder" "db/$folder"
    echo "[restore] db/$folder restored"
  fi
done

rm -rf "$TMP"
echo "[restore] done — restart the app to pick up the restored database."
