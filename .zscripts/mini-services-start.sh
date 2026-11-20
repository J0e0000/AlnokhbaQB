#!/bin/sh
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/mini-services-dist"
SITE_PACKAGES="$SCRIPT_DIR/python-runtime/site-packages"
PIDS=""

cleanup() {
    trap - INT TERM EXIT
    for pid in $PIDS; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    for pid in $PIDS; do
        wait "$pid" 2>/dev/null || true
    done
}
trap cleanup INT TERM EXIT

if [ ! -d "$DIST_DIR" ]; then
    echo "[mini-services] no service directory at $DIST_DIR"
    exit 0
fi

if [ -d "$SITE_PACKAGES" ]; then
    export PYTHONPATH="$SITE_PACKAGES${PYTHONPATH:+:$PYTHONPATH}"
fi
export PYTHONUNBUFFERED=1

if [ -f "$DIST_DIR/omr-engine/server.py" ]; then
    if ! command -v python3 >/dev/null 2>&1; then
        echo "[mini-services] python3 is required to run the OMR engine" >&2
        exit 1
    fi
    echo "[mini-services] starting Python OMR engine on 127.0.0.1:${OMR_ENGINE_PORT:-3032}"
    OMR_ENGINE_PORT="${OMR_ENGINE_PORT:-3032}" python3 -u "$DIST_DIR/omr-engine/server.py" &
    pid=$!
    PIDS="$PIDS $pid"
    ready=0
    attempt=0
    while [ "$attempt" -lt 30 ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "[mini-services] OMR engine exited during startup" >&2
            exit 1
        fi
        if python3 -c 'import os, urllib.request; urllib.request.urlopen("http://127.0.0.1:%s/health" % os.environ.get("OMR_ENGINE_PORT", "3032"), timeout=1).read()' >/dev/null 2>&1; then
            ready=1
            break
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    if [ "$ready" -ne 1 ]; then
        echo "[mini-services] OMR engine did not become healthy within 30 seconds" >&2
        exit 1
    fi
    echo "[mini-services] OMR engine is healthy"
fi

for file in "$DIST_DIR"/mini-service-*.js; do
    [ -f "$file" ] || continue
    if ! command -v bun >/dev/null 2>&1; then
        echo "[mini-services] bun is required to run $file" >&2
        exit 1
    fi
    echo "[mini-services] starting $(basename "$file")"
    bun "$file" &
    PIDS="$PIDS $!"
done

if [ -z "$(printf '%s' "$PIDS" | tr -d ' ')" ]; then
    echo "[mini-services] no runnable services found"
    exit 0
fi
wait
