"""Dependency-free digit recogniser used for the handwritten ID strip.

The engine cannot assume a Tesseract binary exists (the hosted Python runtime
does not ship one), so this module classifies a single segmented glyph with a
nearest-neighbour match against synthetically rendered digit templates. It is
deterministic, needs nothing but OpenCV/numpy, and — most importantly — it
reports a confidence and refuses to answer when the best match is not clearly
better than the runner-up. The caller treats every digit as an assist that a
human must confirm.
"""
from typing import Dict, List, Tuple

import cv2
import numpy as np

FONTS = (
    cv2.FONT_HERSHEY_SIMPLEX,
    cv2.FONT_HERSHEY_PLAIN,
    cv2.FONT_HERSHEY_DUPLEX,
    cv2.FONT_HERSHEY_COMPLEX,
    cv2.FONT_HERSHEY_TRIPLEX,
    cv2.FONT_HERSHEY_SCRIPT_SIMPLEX,  # closest rendered shape to pen strokes
)
GLYPH_SIZE = 20
INNER = 16
MAX_DISTANCE = 0.62  # nearest template farther than this is "unreadable"
MIN_MARGIN = 0.10  # best vs runner-up distance gap required to answer
# Calibrated on rendered sheets (300 dpi) and jittered print: a correct read
# keeps a margin well above 0.30 while the distance varies with stroke weight,
# so the margin dominates the score.
MARGIN_FULL = 0.30
DIST_FULL = 0.75

# Coarse stroke skeletons of how people actually write the digits. They are
# deliberately crude: the point is to cover the shapes a printer font does not
# have (a bare "1", an open "4", a hooked "9"), not to be pretty.
HAND_STROKES: Dict[str, List[List[Tuple[int, int]]]] = {
    "0": [[(50, 20), (30, 35), (28, 60), (50, 80), (72, 60), (70, 35), (50, 20)]],
    "1": [[(45, 30), (52, 20), (52, 80)], [(38, 80), (66, 80)]],
    "2": [[(30, 30), (50, 18), (70, 30), (65, 50), (30, 80), (75, 80)]],
    "3": [[(30, 25), (68, 28), (45, 48), (70, 62), (62, 78), (32, 76)]],
    "4": [[(62, 20), (30, 62), (78, 62)], [(62, 20), (62, 80)]],
    "5": [[(70, 20), (35, 20), (32, 45), (55, 40), (70, 55), (62, 76), (35, 74)]],
    "6": [[(66, 20), (40, 40), (30, 62), (42, 78), (64, 74), (64, 56), (40, 50)]],
    "7": [[(28, 24), (74, 24), (44, 80)]],
    "8": [[(50, 18), (34, 30), (50, 45), (66, 30), (50, 18)],
          [(50, 45), (30, 60), (50, 80), (70, 60), (50, 45)]],
    "9": [[(64, 28), (48, 18), (32, 32), (40, 48), (62, 44)], [(62, 44), (62, 80)]],
}

_templates: Dict[str, np.ndarray] | None = None


def _render(ch: str, font: int, thickness: int, scale: float) -> np.ndarray:
    canvas = np.zeros((80, 80), np.uint8)
    cv2.putText(canvas, ch, (12, 64), font, scale, 255, thickness, cv2.LINE_AA)
    return canvas


def _jitter(img: np.ndarray, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    h, w = img.shape
    angle = float(rng.uniform(-8, 8))
    shear = float(rng.uniform(-0.12, 0.12))
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    m[0, 1] += shear
    return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)


def normalize_glyph(glyph: np.ndarray) -> np.ndarray | None:
    """Ink image → 20×20 unit vector (MNIST-style normalisation)."""
    if glyph.size == 0:
        return None
    ink = glyph if glyph.dtype == np.uint8 else glyph.astype(np.uint8)
    ys, xs = np.where(ink > 0)
    if ys.size < 8:
        return None
    crop = ink[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = crop.shape
    if h < 3 or w < 1:
        return None
    scale = INNER / float(max(h, w))
    resized = cv2.resize(
        crop, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
        interpolation=cv2.INTER_AREA,
    )
    canvas = np.zeros((GLYPH_SIZE, GLYPH_SIZE), np.float32)
    oy = (GLYPH_SIZE - resized.shape[0]) // 2
    ox = (GLYPH_SIZE - resized.shape[1]) // 2
    canvas[oy : oy + resized.shape[0], ox : ox + resized.shape[1]] = resized.astype(np.float32) / 255.0
    # centre on the ink centroid so box position never influences the match
    total = float(canvas.sum())
    if total <= 0:
        return None
    cy = float((canvas.sum(axis=1) * np.arange(GLYPH_SIZE)).sum() / total)
    cx = float((canvas.sum(axis=0) * np.arange(GLYPH_SIZE)).sum() / total)
    shift = np.float32([[1, 0, GLYPH_SIZE / 2 - cx], [0, 1, GLYPH_SIZE / 2 - cy]])
    canvas = cv2.warpAffine(canvas, shift, (GLYPH_SIZE, GLYPH_SIZE), borderValue=0)
    vec = canvas.reshape(-1)
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 0 else None


def _build_templates() -> Dict[str, np.ndarray]:
    global _templates
    if _templates is not None:
        return _templates
    rows: List[np.ndarray] = []
    labels: List[int] = []
    seed = 0
    for digit in range(10):
        ch = str(digit)
        for font in FONTS:
            for thickness in (2, 3):
                for scale in (1.6, 2.0, 2.4):
                    base = _render(ch, font, thickness, scale)
                    for variant in range(3):
                        img = base if variant == 0 else _jitter(base, seed)
                        seed += 1
                        vec = normalize_glyph(img)
                        if vec is None:
                            continue
                        rows.append(vec)
                        labels.append(digit)
    for digit, strokes in HAND_STROKES.items():
        for thickness in (3, 4):
            canvas = np.zeros((100, 100), np.uint8)
            for stroke in strokes:
                cv2.polylines(
                    canvas, [np.array(stroke, np.int32)], False, 255, thickness, cv2.LINE_AA
                )
            for variant in range(4):
                img = canvas if variant == 0 else _jitter(canvas, seed)
                seed += 1
                vec = normalize_glyph(img)
                if vec is None:
                    continue
                rows.append(vec)
                labels.append(int(digit))
    _templates = {"X": np.stack(rows), "y": np.array(labels)}
    return _templates


def classify_glyph(glyph: np.ndarray) -> Tuple[str | None, float, str]:
    """Return (digit or None, confidence 0..1, status)."""
    vec = normalize_glyph(glyph)
    if vec is None:
        return None, 0.0, "empty"
    tpl = _build_templates()
    x, y = tpl["X"], tpl["y"]
    dist = np.linalg.norm(x - vec[None, :], axis=1)
    order = np.argsort(dist)
    best = int(order[0])
    best_d = float(dist[best])
    best_label = int(y[best])
    other = next((float(dist[i]) for i in order if int(y[i]) != best_label), float("inf"))
    if best_d > MAX_DISTANCE:
        return None, 0.0, "unreadable"
    margin = other - best_d
    score = 0.6 * min(1.0, max(0.0, margin / MARGIN_FULL)) + 0.4 * min(
        1.0, max(0.0, 1.0 - best_d / DIST_FULL)
    )
    if margin < MIN_MARGIN:
        return None, round(score * 0.5, 3), "unreadable"
    confidence = round(min(1.0, score), 3)
    return str(best_label), confidence, "read" if confidence >= 0.5 else "lowConfidence"
