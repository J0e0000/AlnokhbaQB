#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ROOT_DIR="$PROJECT_DIR/mini-services"

if [ ! -d "$ROOT_DIR" ]; then
    echo "ℹ️ No mini-services directory at $ROOT_DIR"
    exit 0
fi

for dir in "$ROOT_DIR"/*; do
    [ -d "$dir" ] || continue
    [ -f "$dir/package.json" ] || continue
    echo "📦 Installing mini-service dependencies: $(basename "$dir")"
    (cd "$dir" && bun install)
done
