"""Table extraction from a scanned sheet.

The OMR sheet is a bubble form, but teachers photograph whatever is on the
desk: a marks table, a grade sheet, a handwritten summary. When the warped page
contains a ruled grid we read it and hand it back with the scan.

Detection is line based (morphological open on horizontal/vertical strokes) —
borderless tables are not detected, which is deliberate: guessing cell edges on
a bubble sheet would produce nonsense rows.

Text comes from tesseract per cell when the binary exists (self-hosted / dev).
On hosts without it the table is returned with `crop` (a base64 JPEG of the
grid) so the Node layer can OCR it once with the configured AI provider.
"""
from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import tempfile
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from .ocr import TESSERACT_BIN, _BUNDLED_TESSDATA, _mean_word_confidence

MAX_TABLES = 2
MAX_CELLS = 48
MIN_LINE_FRACTION = 0.25  # a line must span ≥25% of the candidate table box


def _tesseract() -> Optional[str]:
    if os.path.exists(TESSERACT_BIN):
        return TESSERACT_BIN
    return shutil.which("tesseract")


def _cluster(positions: List[int], gap: int) -> List[int]:
    """Collapse near-duplicate line positions (thick strokes yield several)."""
    if not positions:
        return []
    positions = sorted(positions)
    out = [positions[0]]
    for p in positions[1:]:
        if p - out[-1] > gap:
            out.append(p)
    return out


def _line_positions(mask: np.ndarray, axis: int, gap: int) -> List[int]:
    """Positions (y for axis=0, x for axis=1) of long strokes in `mask`."""
    counts = (mask > 0).sum(axis=1 if axis == 0 else 0)
    if counts.size == 0:
        return []
    threshold = max(3, int(counts.max() * 0.5))
    return _cluster([int(i) for i in np.where(counts >= threshold)[0]], gap)


def find_tables(gray: np.ndarray) -> List[Dict[str, Any]]:
    """Ruled grids in the page, biggest first. Geometry only (no text)."""
    h, w = gray.shape[:2]
    if h < 80 or w < 80:
        return []
    # binarize once, then keep only long horizontal / vertical strokes
    thr = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 12
    )
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(12, w // 30), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(12, h // 30)))
    horiz = cv2.morphologyEx(thr, cv2.MORPH_OPEN, hk, iterations=1)
    vert = cv2.morphologyEx(thr, cv2.MORPH_OPEN, vk, iterations=1)

    found: List[Dict[str, Any]] = []
    # connected clusters of strokes = candidate tables
    joined = cv2.dilate(cv2.bitwise_or(horiz, vert), np.ones((5, 5), np.uint8), 1)
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in sorted(contours, key=cv2.contourArea, reverse=True):
        x, y, bw, bh = cv2.boundingRect(c)
        if bw < w * 0.15 or bh < h * 0.04:
            continue
        if bw * bh < h * w * 0.01:
            continue
        sub_h = horiz[y : y + bh, x : x + bw]
        sub_v = vert[y : y + bh, x : x + bw]
        ys = _line_positions(sub_h, 0, gap=max(4, bh // 40))
        xs = _line_positions(sub_v, 1, gap=max(4, bw // 40))
        # keep only strokes that actually span the candidate box
        ys = [p for p in ys if (sub_h[p] > 0).sum() >= bw * MIN_LINE_FRACTION]
        xs = [p for p in xs if (sub_v[:, p] > 0).sum() >= bh * MIN_LINE_FRACTION]
        if len(ys) < 2 or len(xs) < 2:
            continue
        rows, cols = len(ys) - 1, len(xs) - 1
        # a single cell is a frame (the page border, a marker box), not a table
        if rows < 2 or cols < 2 or rows * cols > MAX_CELLS:
            continue
        found.append(
            {
                "bbox": [int(x), int(y), int(bw), int(bh)],
                "rows": int(rows),
                "cols": int(cols),
                "ys": [int(y + p) for p in ys],
                "xs": [int(x + p) for p in xs],
            }
        )
        if len(found) >= MAX_TABLES:
            break
    return found


def _read_cell(gray: np.ndarray, x0: int, y0: int, x1: int, y1: int, tess: str) -> str:
    # inset past the ruling line itself, otherwise the stroke joins the ink bbox
    pad = min(12, max(6, int(min(y1 - y0, x1 - x0) * 0.05)))
    x0, y0 = x0 + pad, y0 + pad
    x1, y1 = x1 - pad, y1 - pad
    if x1 - x0 < 6 or y1 - y0 < 6:
        return ""
    cell = gray[y0:y1, x0:x1]
    if cell.size == 0:
        return ""
    # trim to the ink: tesseract needs a tight box, a mostly-blank cell reads
    # as a random letter (a lone "9" comes back as "اه" otherwise)
    ink = (cell < int(np.percentile(cell, 25)) - 1).astype(np.uint8)
    ys, xs = np.where(ink > 0)
    if ys.size < 6:
        return ""
    m = 4
    top, bottom = max(0, int(ys.min()) - m), min(cell.shape[0], int(ys.max()) + m + 1)
    left, right = max(0, int(xs.min()) - m), min(cell.shape[1], int(xs.max()) + m + 1)
    cell = cell[top:bottom, left:right]
    if cell.size == 0 or float(cell.std()) < 6.0:  # blank cell
        return ""
    target = 64  # tesseract wants ~30-40px cap height
    scale = max(1.0, target / max(1, cell.shape[0]))
    cell = cv2.resize(cell, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    tmpdir = tempfile.mkdtemp(prefix="omr-cell-")
    try:
        inp = os.path.join(tmpdir, "c.png")
        out = os.path.join(tmpdir, "o")
        cv2.imwrite(inp, cell)
        cmd = [
            tess, inp, out, "-l", "ara+eng",
            "--tessdata-dir", _BUNDLED_TESSDATA,
            "--psm", "7", "txt",
        ]
        subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        path = out + ".txt"
        if not os.path.exists(path):
            return ""
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = " ".join(fh.read().split())
        # bidi marks and a stray Arabic letter glued to a Latin/digit cell are
        # `ara+eng` noise, not content
        text = text.replace("\u200e", "").replace("\u200f", "").replace("\u202a", "").replace("\u202b", "").replace("\u202c", "")
        latin = re.fullmatch(r"([A-Za-z0-9/.,:%+\- ]+)\s*[\u0600-\u06FF]\s*", text)
        return latin.group(1).strip() if latin else text.strip()
    except Exception:  # noqa: BLE001 - a bad cell must not kill the scan
        return ""
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _crop_b64(gray: np.ndarray, bbox: List[int], max_w: int = 1400) -> str:
    x, y, bw, bh = bbox
    crop = gray[y : y + bh, x : x + bw]
    if crop.size == 0:
        return ""
    if crop.shape[1] > max_w:
        scale = max_w / float(crop.shape[1])
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


def extract_tables(gray: np.ndarray) -> List[Dict[str, Any]]:
    """Ruled tables on the page with whatever text we can read."""
    try:
        tables = find_tables(gray)
    except Exception:  # noqa: BLE001 - never fail a scan over a table
        return []
    if not tables:
        return []
    tess = _tesseract()
    out: List[Dict[str, Any]] = []
    for t in tables:
        xs, ys = t["xs"], t["ys"]
        cells: List[List[str]] = []
        if tess:
            for r in range(t["rows"]):
                row = [
                    _read_cell(gray, xs[c], ys[r], xs[c + 1], ys[r + 1], tess)
                    for c in range(t["cols"])
                ]
                cells.append(row)
        out.append(
            {
                "bbox": t["bbox"],
                "rows": t["rows"],
                "cols": t["cols"],
                "cells": cells,
                "source": "tesseract" if tess else "none",
                "crop": None if tess else _crop_b64(gray, t["bbox"]),
            }
        )
    return out
