"""Tesseract OCR wrapper (subprocess + temp files, stdlib only).

Arabic: the environment ships tesseract with `eng` only — return the
documented error so the app can fall back to a VLM.
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
from typing import Any, Dict

import cv2
import numpy as np

TESSERACT_BIN = "/usr/bin/tesseract"
SUPPORTED_LANGS = ("eng",)


def _error(msg: str) -> Dict[str, Any]:
    return {"ok": False, "error": msg, "engine": "tesseract"}


def ocr(image_b64: str, lang: str = "eng") -> Dict[str, Any]:
    """Run tesseract on a base64 image; returns a JSON-serializable dict."""
    lang = (lang or "eng").strip().lower() or "eng"
    if lang not in SUPPORTED_LANGS:
        return _error("arabic tesseract language pack not installed")
    if shutil.which("tesseract") is None and not os.path.exists(TESSERACT_BIN):
        return _error("tesseract binary not available on this host")

    payload = (image_b64 or "").strip()
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        raw = base64.b64decode(payload, validate=False)
        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception as exc:  # noqa: BLE001 - reported as JSON error
        return _error(f"invalid image data: {exc}")
    if img is None:
        return _error("image could not be decoded (png/jpeg expected)")

    tmpdir = tempfile.mkdtemp(prefix="omr-ocr-")
    try:
        inp = os.path.join(tmpdir, "input.png")
        outbase = os.path.join(tmpdir, "out")
        if not cv2.imwrite(inp, img):
            return _error("failed to write temporary image")
        cmd = [TESSERACT_BIN if os.path.exists(TESSERACT_BIN) else "tesseract", inp, outbase, "-l", lang]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            return _error("tesseract timed out")
        text_path = outbase + ".txt"
        if proc.returncode != 0:
            return _error(f"tesseract failed: {(proc.stderr or proc.stdout or '').strip()[:300]}")
        text = ""
        if os.path.exists(text_path):
            with open(text_path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        return {"ok": True, "engine": "tesseract", "lang": lang, "text": text.strip()}
    except Exception as exc:  # noqa: BLE001 - never crash the server
        return _error(f"ocr error: {exc}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main() -> None:  # manual smoke: python3 -m engine.ocr '<base64>'
    import sys

    body = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    print(json.dumps(ocr(body.get("imageBase64", ""), body.get("lang", "eng"))))


if __name__ == "__main__":
    main()
