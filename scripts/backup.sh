#!/usr/bin/env bash
# ============================================================
# ALNOKHBA QB — backup (run from the project root or via cron)
#   bash scripts/backup.sh [destination-dir]
# Backs up: SQLite database (consistent snapshot), uploaded
# documents, OMR scan images, assignments, and .env (perms 600).
# ============================================================
set -euo pipefail

DEST="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/anqb-$STAMP"
mkdir -p "$OUT"

echo "[backup] destination: $OUT"

# 1) database — use SQLite's backup API for a consistent copy even under load
DB_FILE="${DATABASE_URL#file:}"
DB_FILE="${DB_FILE:-./db/custom.db}"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_FILE" ".backup '$OUT/custom.db'"
else
  echo "[backup] sqlite3 CLI not found — falling back to file copy"
  cp "$DB_FILE" "$OUT/custom.db"
fi

# 2) files stored on disk
[ -d db/uploads ]     && cp -r db/uploads     "$OUT/uploads"
[ -d db/scans ]       && cp -r db/scans       "$OUT/scans"
[ -d db/assignments ] && cp -r db/assignments "$OUT/assignments"

# 3) environment (keep secrets out of group/world read)
[ -f .env ] && cp .env "$OUT/.env" && chmod 600 "$OUT/.env"

# 4) archive + retention (keep the 14 most recent)
tar -czf "$OUT.tar.gz" -C "$DEST" "anqb-$STAMP"
rm -rf "$OUT"
ls -1t "$DEST"/anqb-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "[backup] done: $OUT.tar.gz"
