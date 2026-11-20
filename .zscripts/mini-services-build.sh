#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BUILD_DIR="${BUILD_DIR:-/tmp/build_fullstack_${BUILD_ID:-local}}"
DIST_DIR="$BUILD_DIR/mini-services-dist"
SOURCE_DIR="$PROJECT_DIR/mini-services"

mkdir -p "$DIST_DIR"

if [ -d "$SOURCE_DIR/omr-engine" ]; then
    echo "📦 Packaging Python OMR engine..."
    mkdir -p "$DIST_DIR/omr-engine"
    cp -a "$SOURCE_DIR/omr-engine/." "$DIST_DIR/omr-engine/"
else
    echo "⚠️ Python OMR engine not found at $SOURCE_DIR/omr-engine"
fi

if [ -d "$SOURCE_DIR" ]; then
    for dir in "$SOURCE_DIR"/*; do
        [ -d "$dir" ] || continue
        [ -f "$dir/package.json" ] || continue
        [ "$(basename "$dir")" = "omr-engine" ] && continue
        project_name="$(basename "$dir")"
        entry_path=""
        for entry in src/index.ts index.ts src/index.js index.js; do
            if [ -f "$dir/$entry" ]; then
                entry_path="$dir/$entry"
                break
            fi
        done
        if [ -z "$entry_path" ]; then
            echo "⚠️ Skipping $project_name: no supported JS entry file"
            continue
        fi
        echo "🔨 Building JavaScript mini-service: $project_name"
        bun build "$entry_path" --outfile "$DIST_DIR/mini-service-$project_name.js" --target bun --minify
    done
fi

cp "$SCRIPT_DIR/mini-services-start.sh" "$BUILD_DIR/mini-services-start.sh"
chmod +x "$BUILD_DIR/mini-services-start.sh"
echo "✅ Mini-services packaged in $DIST_DIR"
