# ============================================================
# ALNOKHBA QB — OMR accuracy guard for client-side compression
#
# Simulates the on-device compression done by
# src/lib/image/prepareUpload.ts (long side → 2200 px, JPEG q85)
# against the REAL printed fixture, then the caller reruns the
# verification harness on the downsized sheets:
#
#   python3 scripts/downscale-fixtures.py
#   OMR_HARNESS_FIXTURES=tests/omr-fixtures-downscaled \
#     python3 tests/omr-engine-harness.py
#
# OMR accuracy must NOT regress vs the full-size harness run.
# (If it does: raise MAX_LONG_SIDE in prepareUpload.ts, or move
# scans to direct-to-storage upload and skip compression.)
# ============================================================
import json
import os
import shutil

import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tests", "omr-fixtures")
DST = os.path.join(ROOT, "tests", "omr-fixtures-downscaled")
MAX_LONG_SIDE = 2200
JPEG_QUALITY = 85

os.makedirs(DST, exist_ok=True)

# Non-image fixture metadata travels unchanged (template + key).
for name in ("template.json", "key_by_number.json"):
    src = os.path.join(SRC, name)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(DST, name))

for name in sorted(os.listdir(SRC)):
    if not name.lower().endswith((".png", ".jpg", ".jpeg")):
        continue
    path = os.path.join(SRC, name)
    img = cv2.imread(path)
    if img is None:
        continue
    h, w = img.shape[:2]
    long_side = max(h, w)
    if long_side > MAX_LONG_SIDE:
        scale = MAX_LONG_SIDE / long_side
        img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    out = os.path.join(DST, os.path.splitext(name)[0] + ".jpg")
    cv2.imwrite(out, img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    print(f"{name}: {w}x{h} -> {img.shape[1]}x{img.shape[0]} (jpeg q{JPEG_QUALITY}, {os.path.getsize(out)//1024} KB)")

print("downscaled fixtures written to", os.path.relpath(DST, ROOT))
