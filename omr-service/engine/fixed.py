"""Handwritten student-ID strip reader (fixed reusable sheet).

The sheet has one printed box per digit. The student writes the digits by
hand, so this is an ASSIST only: every digit carries its own confidence and
the caller must confirm the result against the roster before it becomes a
result. Nothing here ever invents a digit — an unreadable box is reported as
unreadable, never as a guess.
"""
import os
import re
import shutil
import subprocess
import tempfile
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from . import digits as digit_nn
from .bubbles import Bubble, estimate_ink_ref, measure_fill
from .ocr import TESSERACT_BIN

MIN_INK_RATIO = 0.004  # a box with less ink than this is empty, not a digit
MIN_GLYPH_HEIGHT = 0.18  # glyph shorter than this fraction of the box → junk
DIGIT_RE = re.compile(r"^[0-9]$")


def _tesseract() -> Optional[str]:
    if os.path.exists(TESSERACT_BIN):
        return TESSERACT_BIN
    return shutil.which("tesseract")


def _backend() -> str:
    """tesseract when the host has it, otherwise the built-in matcher.

    Both are deterministic; neither invents a digit. The built-in matcher is
    weaker on messy handwriting and says so through a low confidence, which
    sends the sheet to review — exactly the contract of this field.
    """
    return "tesseract" if _tesseract() else "builtin"


def _read_digit_builtin(inner: np.ndarray) -> Dict[str, Any]:
    blur = cv2.GaussianBlur(inner, (3, 3), 0)
    _t, binary = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink = float(np.count_nonzero(binary)) / float(binary.size) if binary.size else 0.0
    if ink < MIN_INK_RATIO:
        return {"value": None, "confidence": 0.0, "status": "empty"}
    value, conf, status = digit_nn.classify_glyph(binary)
    return {"value": value, "confidence": conf, "status": status}


def _read_digit(cell: np.ndarray, tess: Optional[str]) -> Dict[str, Any]:
    """OCR one handwritten digit box → {value, confidence, status}."""
    if cell.size == 0:
        return {"value": None, "confidence": 0.0, "status": "empty"}
    h, w = cell.shape[:2]
    # drop the printed border: it is the strongest ink in the box
    inset_y, inset_x = max(2, int(h * 0.12)), max(2, int(w * 0.12))
    inner = cell[inset_y : h - inset_y, inset_x : w - inset_x]
    if inner.size == 0:
        return {"value": None, "confidence": 0.0, "status": "empty"}

    blur = cv2.GaussianBlur(inner, (3, 3), 0)
    _t, binary = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink = float(np.count_nonzero(binary)) / float(binary.size)
    if ink < MIN_INK_RATIO:
        return {"value": None, "confidence": 0.0, "status": "empty"}

    if not tess:
        return _read_digit_builtin(inner)

    ys, xs = np.where(binary > 0)
    if ys.size == 0:
        return {"value": None, "confidence": 0.0, "status": "empty"}
    top, bottom = int(ys.min()), int(ys.max())
    left, right = int(xs.min()), int(xs.max())
    if (bottom - top + 1) < MIN_GLYPH_HEIGHT * inner.shape[0]:
        return {"value": None, "confidence": 0.0, "status": "unreadable"}

    pad = 6
    glyph = inner[
        max(0, top - pad) : min(inner.shape[0], bottom + pad),
        max(0, left - pad) : min(inner.shape[1], right + pad),
    ]
    if glyph.size == 0:
        return {"value": None, "confidence": 0.0, "status": "unreadable"}

    # tesseract wants a single glyph centred in a square with quiet margins
    scale = 96.0 / max(1, glyph.shape[0])
    glyph = cv2.resize(glyph, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    side = max(glyph.shape[:2]) + 40
    canvas = np.full((side, side), 255, np.uint8)
    oy = (side - glyph.shape[0]) // 2
    ox = (side - glyph.shape[1]) // 2
    canvas[oy : oy + glyph.shape[0], ox : ox + glyph.shape[1]] = glyph

    tmpdir = tempfile.mkdtemp(prefix="omr-id-")
    try:
        inp = os.path.join(tmpdir, "d.png")
        out = os.path.join(tmpdir, "o")
        cv2.imwrite(inp, canvas)
        subprocess.run(
            [
                tess, inp, out, "-l", "eng", "--psm", "10",
                "-c", "tessedit_char_whitelist=0123456789", "tsv",
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        path = out + ".tsv"
        if not os.path.exists(path):
            return {"value": None, "confidence": 0.0, "status": "unreadable"}
        text = ""
        conf = 0.0
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            next(fh, None)
            for line in fh:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 12 or parts[0] != "5":
                    continue
                word = (parts[11] or "").strip()
                if not word:
                    continue
                try:
                    c = float(parts[10])
                except ValueError:
                    c = 0.0
                text += word
                conf = max(conf, c)
        text = re.sub(r"\s+", "", text)
        if not DIGIT_RE.match(text):
            return {"value": None, "confidence": round(conf / 100.0, 3), "status": "unreadable"}
        return {
            "value": text,
            "confidence": round(conf / 100.0, 3),
            "status": "read" if conf >= 60 else "lowConfidence",
        }
    except Exception:  # noqa: BLE001 - a bad box must not kill the scan
        return {"value": None, "confidence": 0.0, "status": "unreadable"}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def read_id_boxes(
    gray: np.ndarray,
    id_boxes: Optional[Dict[str, Any]],
    px_per_mm: float,
) -> Optional[Dict[str, Any]]:
    """Read the handwritten ID strip.

    Returns {"digits": "314?59", "complete": bool, "confidence": float,
             "perDigit": [{index, value, confidence, status}], "source": "handwritten"}
    where "?" marks an unreadable position (never guessed).
    """
    if not id_boxes:
        return None
    boxes: List[Dict[str, Any]] = list(id_boxes.get("boxes") or [])
    if not boxes:
        return None
    tess = _tesseract()
    per_digit: List[Dict[str, Any]] = []
    digits = ""
    confs: List[float] = []
    for box in sorted(boxes, key=lambda b: int(b.get("index", 0))):
        x0 = int(round(float(box["x"]) * px_per_mm))
        y0 = int(round(float(box["y"]) * px_per_mm))
        x1 = int(round((float(box["x"]) + float(box["w"])) * px_per_mm))
        y1 = int(round((float(box["y"]) + float(box["h"])) * px_per_mm))
        cell = gray[max(0, y0) : max(0, y1), max(0, x0) : max(0, x1)]
        res = _read_digit(cell, tess)
        per_digit.append({"index": int(box.get("index", 0)), **res})
        digits += res["value"] if res["value"] else "?"
        confs.append(float(res["confidence"]))
    complete = "?" not in digits and len(digits) == len(per_digit)
    return {
        "digits": digits,
        "complete": bool(complete),
        "confidence": round(float(np.mean(confs)) if confs else 0.0, 3),
        "perDigit": per_digit,
        "source": "handwritten",
        "backend": "tesseract" if tess else "builtin",
        "stripImage": _strip_png(gray, boxes, px_per_mm),
    }


def read_id_grid(
    gray: np.ndarray,
    id_grid: Optional[Dict[str, Any]],
    px_per_mm: float,
    thresholds: Optional[Dict[str, float]] = None,
) -> Optional[Dict[str, Any]]:
    """Read the shaded digit columns of the ID grid.

    Deterministic: every column is measured like an answer bubble, and a column
    with no clear single mark stays "?" — the caller never infers a digit.
    """
    if not id_grid:
        return None
    columns: List[Dict[str, Any]] = list(id_grid.get("columns") or [])
    if not columns:
        return None
    pitch = float(id_grid.get("pitchYMm") or 0.0)
    radius = float(id_grid.get("radiusMm") or 0.0)
    if pitch <= 0 or radius <= 0:
        return None
    th = {"filled": 0.45, "empty": 0.17, "ambiguousMargin": 0.1, "minAbsoluteFill": 0.08}
    if thresholds:
        th.update({k: float(v) for k, v in thresholds.items() if k in th})

    bubbles: List[Bubble] = []
    owners: List[Tuple[int, int]] = []
    for col in columns:
        order = [int(d) for d in col.get("digitOrder") or []]
        for row, digit in enumerate(order):
            bubbles.append(
                Bubble(
                    x_mm=float(col["xMm"]),
                    y_mm=float(col["yTopMm"]) + row * pitch,
                    r_mm=radius,
                    kind="sid",
                    digit=digit,
                )
            )
            owners.append((int(col.get("index", 0)), digit))

    ink_ref = estimate_ink_ref(gray)
    measured = measure_fill(gray, px_per_mm, bubbles, ink_ref)
    ratios = measured["ratio"]

    per_column: Dict[int, List[Tuple[int, float]]] = {}
    for (index, digit), ratio in zip(owners, ratios):
        per_column.setdefault(index, []).append((digit, float(ratio)))

    digits = ""
    confs: List[float] = []
    out_cols: List[Dict[str, Any]] = []
    for col in sorted(columns, key=lambda c: int(c.get("index", 0))):
        index = int(col.get("index", 0))
        pairs = sorted(per_column.get(index, []), key=lambda t: -t[1])
        if not pairs:
            digits += "?"
            confs.append(0.0)
            out_cols.append({"index": index, "value": None, "status": "empty", "confidence": 0.0, "ratios": {}})
            continue
        (top_digit, top_ratio) = pairs[0]
        second = pairs[1][1] if len(pairs) > 1 else 0.0
        status = "selected"
        value: Optional[int] = top_digit
        if top_ratio < th["empty"]:
            status, value = "unanswered", None
        elif top_ratio < th["filled"] or top_ratio < th["minAbsoluteFill"]:
            status, value = "unclear", None
        elif second >= th["filled"] - th["ambiguousMargin"] and top_ratio - second < th["ambiguousMargin"]:
            status, value = "multiple", None
        confidence = float(np.clip((top_ratio - second) / max(0.05, top_ratio), 0.0, 1.0))
        if value is None:
            digits += "?"
            confs.append(0.0)
        else:
            digits += str(value)
            confs.append(confidence if status == "selected" else 0.0)
        out_cols.append(
            {
                "index": index,
                "value": value,
                "status": status,
                "confidence": round(confidence if value is not None else 0.0, 3),
                "top2": round(second, 3),
                "ratios": {str(d): round(r, 3) for d, r in pairs},
            }
        )

    return {
        "digits": digits,
        "complete": "?" not in digits and len(digits) == len(columns),
        "confidence": round(float(np.mean(confs)) if confs else 0.0, 3),
        "columns": out_cols,
        "source": "grid",
    }


def _strip_png(gray: np.ndarray, boxes: List[Dict[str, Any]], px_per_mm: float) -> Optional[str]:
    """The ID strip itself, base64 PNG — the reviewer confirms against the ink,
    never against the OCR text alone."""
    try:
        import base64

        x0 = int(round(min(float(b["x"]) for b in boxes) * px_per_mm)) - 4
        x1 = int(round(max(float(b["x"]) + float(b["w"]) for b in boxes) * px_per_mm)) + 4
        y0 = int(round(min(float(b["y"]) for b in boxes) * px_per_mm)) - 4
        y1 = int(round(max(float(b["y"]) + float(b["h"]) for b in boxes) * px_per_mm)) + 4
        crop = gray[max(0, y0) : max(0, y1), max(0, x0) : max(0, x1)]
        if crop.size == 0:
            return None
        h = 120
        w = max(1, int(round(crop.shape[1] * (h / crop.shape[0]))))
        crop = cv2.resize(crop, (w, h), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".png", crop)
        if not ok:
            return None
        return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("ascii")
    except Exception:  # noqa: BLE001 - a missing preview must not fail the read
        return None
