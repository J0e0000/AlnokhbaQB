#!/usr/bin/env bash
# ============================================================
# ALNOKHBA QB — best-effort chrome-headless-shell installer
# ------------------------------------------------------------
# The project ships a pre-installed copy under ./chrome/ so
# deployments are self-contained. This script only downloads
# when that copy is missing (fresh clone / stripped snapshot)
# and NEVER fails the enclosing install/build step.
# Usage:
#   bash scripts/install-chrome.sh           # skip if present
#   bash scripts/install-chrome.sh --force   # re-download
# ============================================================
set -u
cd "$(dirname "$0")/.."

have_chrome() {
  ls chrome/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell >/dev/null 2>&1
}

if [ "${1:-}" != "--force" ] && have_chrome; then
  echo "[install-chrome] bundled chrome-headless-shell present — skipping"
  exit 0
fi

echo "[install-chrome] downloading chrome-headless-shell -> ./chrome ..."
if command -v bunx >/dev/null 2>&1; then
  bunx @puppeteer/browsers install chrome-headless-shell@stable --path ./chrome
elif command -v npx >/dev/null 2>&1; then
  npx -y @puppeteer/browsers install chrome-headless-shell@stable --path ./chrome
else
  echo "[install-chrome] WARN: neither bunx nor npx available — cannot auto-install"
  exit 0
fi

if have_chrome; then
  echo "[install-chrome] done: $(ls chrome/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell | head -1)"
else
  echo "[install-chrome] WARN: download failed — PDF/OMR export needs CHROME_PATH set to a working chrome binary"
fi
exit 0
