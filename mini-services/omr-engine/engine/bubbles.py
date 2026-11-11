"""Template-driven bubble fill analysis (NO circle detection — the template
is the single source of geometry) and answer determination.

Measurement model
-----------------
For every expected bubble the engine crops center ± 1.4r around the
template-predicted center and computes:

  fillRatio = (bgMedian - meanIntensityInside(r*0.9))
              / (bgMedian - inkRef)

where bgMedian is the local paper reference (median of an annulus
r*1.15..r*1.35) and inkRef is a per-sheet ink blackness estimate (clamped
to [35, 60] to stay robust against antialiasing/JPEG). This normalized
mean-darkness metric matches the physical instrument calibration semantics
(HB pencil ~0.40-0.55, black pen ~0.75-0.9, erased ghost ~0.10-0.16) and
is insensitive to uniform illumination changes (low light, shadows).

A coverage diagnostic (fraction of mask pixels at least 55% as dark as ink
relative to local paper) is computed alongside for diagnostics.

NOTE on cv2.adaptiveThreshold: it was evaluated for this task and rejects
uniform fills (the local window mean equals the fill level itself, so
C=12 cancels the interior); it only highlights ring/edges. The normalized
mean-darkness metric above is used instead and validated by the harness.

Answer determination (per question, thresholds = template + request merge):
  top1, top2 = two largest ratios
  top1 >= filled and top2 >= filled                  -> multiple (null)
  top1 >= filled and top1 >= minAbsoluteFill         -> selected (letter)
  top1 < empty                                       -> unanswered (null)
  otherwise                                          -> unclear (null)
A near-tie guard uses ambiguousMargin: when top2 >= filled-margin and
top1-top2 < margin the mark is genuinely ambiguous -> unclear.
"""
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

CROP_FACTOR = 1.4       # crop half-width = r * CROP_FACTOR
MASK_FACTOR = 0.9       # measurement mask radius = r * MASK_FACTOR
ANN_IN, ANN_OUT = 1.15, 1.35  # background annulus (paper reference)
INK_REF_MIN, INK_REF_MAX = 35.0, 60.0
DARK_COVER_FRACTION = 0.55    # coverage diagnostic threshold (of ink darkness)


@dataclass
class Bubble:
    """One expected bubble from the canonical template (mm coordinates)."""

    x_mm: float
    y_mm: float
    r_mm: float
    kind: str                     # 'answer' | 'sid'
    question: Optional[int] = None
    letter: Optional[str] = None
    digit: Optional[int] = None
    value: Optional[int] = None


def build_bubbles(template: Any, sheet: int) -> List[Bubble]:
    """Expand the template into the bubble list for one sheet."""
    bubbles: List[Bubble] = []
    for q in template.questions_for_sheet(sheet):
        r = float(q.get("radiusMm", template.raw.get("grid", {}).get("radiusMm", 2.0)))
        number = int(q["number"])
        for letter, pos in q["options"].items():
            bubbles.append(
                Bubble(float(pos["x"]), float(pos["y"]), r, "answer", question=number, letter=letter)
            )
    sid = template.student_id
    if sid and sheet == 0:
        r = float(sid.get("bubbleRMm", 1.6))
        for d, cx in enumerate(sid["digitColumnXs"]):
            for v, cy in enumerate(sid["valueYs"]):
                bubbles.append(
                    Bubble(float(cx), float(cy), r, "sid", digit=d, value=v)
                )
    return bubbles


def estimate_ink_ref(gray: np.ndarray) -> float:
    """Per-sheet ink blackness estimate (gray level of true print)."""
    small = cv2.resize(gray, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    t, _ = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    dark = small[small < t]
    if dark.size > 500:
        return float(np.clip(np.percentile(dark, 15), INK_REF_MIN, INK_REF_MAX))
    return 45.0


def measure_fill(
    gray: np.ndarray,
    ppx: float,
    bubbles: Sequence[Bubble],
    ink_ref: float,
) -> Dict[str, np.ndarray]:
    """Vectorized fill measurement for all bubbles.

    Returns {"ratio", "mean", "bg", "cover"} arrays aligned with `bubbles`.
    """
    n = len(bubbles)
    ratio = np.zeros(n, dtype=np.float64)
    mean_out = np.zeros(n, dtype=np.float64)
    bg_out = np.full(n, 255.0, dtype=np.float64)
    cover_out = np.zeros(n, dtype=np.float64)
    if n == 0:
        return {"ratio": ratio, "mean": mean_out, "bg": bg_out, "cover": cover_out}

    # Group by radius so crops/masks are uniform per group (vectorized).
    by_r: Dict[float, List[int]] = {}
    for i, b in enumerate(bubbles):
        by_r.setdefault(round(b.r_mm, 3), []).append(i)

    # Pad so crops never leave the image (constant paper white).
    halves = [int(math.ceil(CROP_FACTOR * b.r_mm * ppx)) for b in bubbles]
    pad = max(2, max(halves) if halves else 2)
    work = cv2.copyMakeBorder(gray, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)

    for r_mm, idxs in by_r.items():
        r_px = r_mm * ppx
        half = int(math.ceil(CROP_FACTOR * r_px))
        size = 2 * half + 1
        stack = np.empty((len(idxs), size, size), dtype=np.float32)
        for row, i in enumerate(idxs):
            b = bubbles[i]
            cx = int(round(b.x_mm * ppx)) + pad
            cy = int(round(b.y_mm * ppx)) + pad
            stack[row] = work[cy - half:cy + half + 1, cx - half:cx + half + 1]

        yy, xx = np.mgrid[-half:half + 1, -half:half + 1]
        dist = np.sqrt((xx * xx + yy * yy).astype(np.float32))
        inner = (dist <= MASK_FACTOR * r_px).astype(np.float32)
        ann = (dist >= ANN_IN * r_px) & (dist <= ANN_OUT * r_px)
        inner_sum = float(inner.sum())
        ann_any = ann.any()

        # local paper reference: median of annulus (robust to stray print)
        if ann_any:
            masked = np.where(ann[None, :, :], stack, np.nan)
            with np.errstate(all="ignore"):
                bg = np.nanmedian(masked.reshape(len(idxs), -1), axis=1)
            bg = np.nan_to_num(bg, nan=255.0)
        else:
            bg = np.full(len(idxs), 255.0)
        bg = np.clip(bg, 40.0, 255.0)

        mean_in = (stack * inner[None, :, :]).sum(axis=(1, 2)) / max(inner_sum, 1.0)

        denom = np.maximum(bg - ink_ref, 60.0)
        r_out = np.clip((bg - mean_in) / denom, 0.0, 1.15)

        # coverage diagnostic: pixels >= 55% as dark as ink vs local paper
        t_local = bg - DARK_COVER_FRACTION * (bg - ink_ref)
        dark = (stack < t_local[:, None, None]).astype(np.float32) * inner[None, :, :]
        cover = dark.sum(axis=(1, 2)) / max(inner_sum, 1.0)

        for row, i in enumerate(idxs):
            ratio[i] = r_out[row]
            mean_out[i] = mean_in[row]
            bg_out[i] = bg[row]
            cover_out[i] = cover[row]

    return {"ratio": ratio, "mean": mean_out, "bg": bg_out, "cover": cover_out}


def determine_answer(
    ratios: Dict[str, float],
    thresholds: Dict[str, float],
) -> Tuple[Optional[str], str, float]:
    """Map one question's per-letter ratios to (detected, status, confidence).

    Confidence semantics: probability-like 0..1 that the STATUS is correct
    (for `selected` it also reflects separation from the runner-up).
    """
    filled = thresholds["filled"]
    empty = thresholds["empty"]
    margin = thresholds.get("ambiguousMargin", 0.10)
    min_abs = thresholds.get("minAbsoluteFill", 0.08)

    ranked = sorted(ratios.items(), key=lambda kv: kv[1], reverse=True)
    top_letter, top1 = ranked[0]
    top2 = ranked[1][1] if len(ranked) > 1 else 0.0

    if top1 >= filled and top2 >= filled:
        conf = 0.5 + 0.5 * (min(top1, top2) - filled) / max(1.0 - filled, 0.2)
        return None, "multiple", float(np.clip(conf, 0.5, 1.0))
    if top1 >= filled:
        if top1 < min_abs:  # only reachable with custom thresholds
            return None, "unclear", 0.4
        if (top1 - top2) < margin and top2 >= filled - margin:
            # near-tie single mark — genuinely ambiguous, never force a letter
            return None, "unclear", float(np.clip(0.5 - (top1 - top2) / max(margin, 1e-6) * 0.25, 0.25, 0.5))
        conf = min(1.0, 0.5 + 0.5 * (top1 - top2) / 0.30)
        return top_letter, "selected", float(np.clip(conf, 0.0, 1.0))
    if top1 < empty:
        return None, "unanswered", float(np.clip(1.0 - top1 / max(empty, 1e-6), 0.0, 1.0))
    conf = float(np.clip((top1 - empty) / max(filled - empty, 1e-6) * 0.5, 0.0, 0.5))
    return None, "unclear", conf


def sanity_check(ratios: np.ndarray, thresholds: Dict[str, float]) -> Tuple[List[str], bool]:
    """Global sheet sanity. Returns (warnings, invalidate_all)."""
    warnings: List[str] = []
    if ratios.size == 0:
        return warnings, False
    med = float(np.median(ratios))
    if med > 0.70:
        warnings.append(
            f"sheet appears dirty/inverted (median fill {med:.2f} > 0.70) — answers invalidated"
        )
        return warnings, True
    if med > 0.45:
        warnings.append(f"sheet appears dirty/inverted (median fill {med:.2f} > 0.45)")
    return warnings, False
