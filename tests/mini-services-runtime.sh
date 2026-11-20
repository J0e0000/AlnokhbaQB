#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'if [ -n "${SERVICE_PID:-}" ]; then kill -TERM "$SERVICE_PID" 2>/dev/null || true; wait "$SERVICE_PID" 2>/dev/null || true; fi; rm -rf "$TEST_ROOT"' EXIT
BUILD_DIR="$TEST_ROOT/build"
mkdir -p "$BUILD_DIR"

PROJECT_DIR="$ROOT" BUILD_DIR="$BUILD_DIR" bash "$ROOT/.zscripts/mini-services-build.sh"
PROJECT_DIR="$ROOT" BUILD_DIR="$BUILD_DIR" bash "$ROOT/.zscripts/python-runtime-build.sh"
BUILD_DIR="$BUILD_DIR" bash "$ROOT/.zscripts/tesseract-runtime-build.sh"
cp "$ROOT/.zscripts/mini-services-start.sh" "$BUILD_DIR/mini-services-start.sh"
test -f "$BUILD_DIR/mini-services-dist/omr-engine/server.py"
test -f "$BUILD_DIR/mini-services-dist/omr-engine/engine/pipeline.py"
PYTHONPATH="$BUILD_DIR/python-runtime/site-packages" python3 -c 'import cv2, numpy; print("OpenCV", cv2.__version__, "NumPy", numpy.__version__)'
TESSERACT_CMD="$BUILD_DIR/tesseract-runtime/bin/tesseract" \
TESSDATA_DIR="$BUILD_DIR/tesseract-runtime/share/tessdata" \
LD_LIBRARY_PATH="$BUILD_DIR/tesseract-runtime/lib" \
PYTHONPATH="$BUILD_DIR/python-runtime/site-packages:$BUILD_DIR/mini-services-dist/omr-engine" \
python3 - <<'PY'
import base64, cv2, os, numpy as np
from engine.pipeline import ocr
image = np.full((500, 1400, 3), 255, dtype=np.uint8)
cv2.putText(image, "1. OCR deployment works", (40, 180), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 0), 4)
ok, encoded = cv2.imencode(".png", image)
assert ok
result = ocr(base64.b64encode(encoded).decode(), "eng")
assert result["ok"], result
assert "OCR" in result["text"], result["text"]
print("Bundled Tesseract OCR passed:", result["text"].strip())
PY
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
OMR_ENGINE_PORT="$PORT" sh "$BUILD_DIR/mini-services-start.sh" >"$TEST_ROOT/service.log" 2>&1 &
SERVICE_PID=$!

ready=0
for _ in $(seq 1 30); do
    if python3 - "$PORT" <<'PY' >/dev/null 2>&1
import json, sys, urllib.request
response = urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=1)
assert response.status == 200
assert json.loads(response.read())["engine"] == "python-opencv"
PY
    then
        ready=1
        break
    fi
    sleep 1
done
if [ "$ready" -ne 1 ]; then
    cat "$TEST_ROOT/service.log"
    echo "OMR service did not become healthy" >&2
    exit 1
fi

echo "mini-services runtime packaging test passed"
