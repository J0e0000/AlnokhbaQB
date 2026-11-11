"""Tesseract OCR wrapper (subprocess + temp files, stdlib only).

Language packs are BUNDLED with the service (tessdata/, from the
tesseract-ocr/tessdata_fast project, Apache-2.0):
  - eng.traineddata  (copied from the system pack)
  - ara.traineddata  (Arabic, tessdata_fast)
so Arabic OCR works offline with no system-font/pack requirements.

Each result carries a self-assessed confidence (mean word confidence
from tesseract's TSV output, 0..1). The TS DocumentProcessor pipeline
uses it: confident results are accepted, weak Arabic results escalate
to the VLM processor automatically.

Mixed-language documents: lang "ara+eng" or "eng+ara" is supported.
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
# Bundled language packs live next to the engine package (mini-services/omr-engine/tessdata).
_BUNDLED_TESSDATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tessdata")
SUPPORTED_LANGS = ("eng", "ara", "ara+eng", "eng+ara")


def _error(msg: str) -> Dict[str, Any]:
    return {"ok": False, "error": msg, "engine": "tesseract"}


def _mean_word_confidence(tsv_path: str) -> float | None:
    """Mean of word-level confidences (tesseract TSV level 5), 0..1; None if no words."""
    confs: list[float] = []
    try:
        with open(tsv_path, "r", encoding="utf-8", errors="replace") as fh:
            header = fh.readline().rstrip("\n").split("\t")
            try:
                i_conf = header.index("conf")
                i_text = header.index("text")
                i_level = header.index("level")
            except ValueError:
                return None
            for line in fh:
                cols = line.rstrip("\n").split("\t")
                if len(cols) <= max(i_conf, i_text, i_level):
                    continue
                if cols[i_level] != "5":  # level 5 = word
                    continue
                word = cols[i_text].strip()
                if not word:
                    continue
                try:
                    conf = float(cols[i_conf])
                except ValueError:
                    continue
                if conf >= 0:
                    confs.append(conf)
    except OSError:
        return None
    if not confs:
        return None
    return round(sum(confs) / len(confs) / 100.0, 4)


def ocr(image_b64: str, lang: str = "eng") -> Dict[str, Any]:
    """Run tesseract on a base64 image; returns a JSON-serializable dict."""
    lang = (lang or "eng").strip().lower() or "eng"
    if lang not in SUPPORTED_LANGS:
        return _error(f"unsupported language '{lang}' (supported: eng, ara, ara+eng)")
    tess_bin = TESSERACT_BIN if os.path.exists(TESSERACT_BIN) else shutil.which("tesseract")
    if not tess_bin:
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
        cmd = [
            tess_bin, inp, outbase, "-l", lang,
            "--tessdata-dir", _BUNDLED_TESSDATA,
            "tsv",
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            return _error("tesseract timed out")
        tsv_path = outbase + ".tsv"
        if proc.returncode != 0:
            return _error(f"tesseract failed: {(proc.stderr or proc.stdout or '').strip()[:300]}")

        text = ""
        if os.path.exists(tsv_path):
            # Plain text comes free: re-run is wasteful — reconstruct from TSV text column
            # (level 5 words joined with their line boundaries is lossy; simpler to also
            # request the txt output by running the plain invocation when needed).
            pass
        # Run once more for clean .txt (fast, cached model, still well under timeout)
        cmd_txt = [
            tess_bin, inp, outbase + "_t", "-l", lang,
            "--tessdata-dir", _BUNDLED_TESSDATA,
        ]
        proc2 = subprocess.run(cmd_txt, capture_output=True, text=True, timeout=60)
        text_path = outbase + "_t.txt"
        if proc2.returncode == 0 and os.path.exists(text_path):
            with open(text_path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()

        confidence = _mean_word_confidence(tsv_path) if os.path.exists(tsv_path) else None
        return {
            "ok": True,
            "engine": "tesseract",
            "lang": lang,
            "text": text.strip(),
            "confidence": confidence,
        }
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
