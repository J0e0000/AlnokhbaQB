#!/bin/bash
# Watches /home/z/my-project/upload for nokhba-qb-source.zip
# When it appears: extracts it + writes a full inventory report.
TARGET="/home/z/my-project/upload/nokhba-qb-source.zip"
OUT="/tmp/nokhba-src"
LOG="/tmp/nokhba-upload-watcher.log"

echo "[$(date '+%H:%M:%S')] watcher started, polling every 5s..." >> "$LOG"

for i in $(seq 1 8640); do   # up to 24h
  if [ -f "$TARGET" ]; then
    SIZE=$(stat -c%s "$TARGET" 2>/dev/null || echo 0)
    # wait for upload to stabilize (size unchanged for 2 consecutive checks)
    sleep 5
    SIZE2=$(stat -c%s "$TARGET" 2>/dev/null || echo 0)
    if [ "$SIZE" != "$SIZE2" ]; then continue; fi
    echo "[$(date '+%H:%M:%S')] zip detected (${SIZE2} bytes), extracting..." >> "$LOG"
    rm -rf "$OUT" && mkdir -p "$OUT"
    if unzip -o -q "$TARGET" -d "$OUT" 2>> "$LOG"; then
      echo "[$(date '+%H:%M:%S')] extraction OK" >> "$LOG"
    else
      echo "[$(date '+%H:%M:%S')] unzip FAILED — trying as tar" >> "$LOG"
      tar -xf "$TARGET" -C "$OUT" 2>> "$LOG" && echo "extraction(tar) OK" >> "$LOG"
    fi
    # inventory report
    {
      echo "=== INVENTORY $(date) ==="
      echo "--- top level ---"
      ls -la "$OUT"
      echo "--- file count by type ---"
      find "$OUT" -type f -not -path "*/node_modules/*" | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -20
      echo "--- all source files (excluding deps) ---"
      find "$OUT" -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.json" -o -name "*.prisma" \) -not -path "*/node_modules/*" -not -path "*/.next/*" | sort
      echo "--- README/package ---"
      for f in "$OUT/README.md" "$OUT/package.json"; do [ -f "$f" ] && echo "### $f ###" && head -50 "$f"; done
    } > /tmp/nokhba-inventory.txt 2>&1
    echo "[$(date '+%H:%M:%S')] DONE — inventory at /tmp/nokhba-inventory.txt" >> "$LOG"
    exit 0
  fi
  sleep 5
done
echo "[$(date '+%H:%M:%S')] gave up after 24h" >> "$LOG"
