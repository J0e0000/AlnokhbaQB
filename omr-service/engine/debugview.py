"""Debug/annotated image rendering + JPEG base64 encoding.

Overlays (drawn on the perspective-corrected sheet, downscaled to <=1000px):
  - bubble circles: green(selected) / red(multiple) / orange(unclear) /
    gray(unanswered) / magenta(invalid)
  - per-question fill % + detected letter text
  - student-ID digit circles + decoded digits
  - marker boxes (green) and the QR region (yellow)
ASCII-only text (OpenCV fonts cannot render Arabic).
"""
import base64
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

# BGR colors
C_SELECTED = (60, 200, 60)     # green
C_MULTIPLE = (40, 40, 230)     # red
C_UNCLEAR = (0, 150, 255)      # orange
C_EMPTY = (170, 170, 170)      # gray
C_INVALID = (230, 0, 230)      # magenta
C_MARKER = (60, 200, 60)
C_QR = (40, 220, 230)          # yellow

STATUS_COLOR = {
    "selected": C_SELECTED,
    "multiple": C_MULTIPLE,
    "unclear": C_UNCLEAR,
    "unanswered": C_EMPTY,
    "invalid": C_INVALID,
}


def encode_jpeg_b64(bgr: np.ndarray, max_width: int = 1000, quality: int = 80) -> Optional[str]:
    """Downscale + JPEG-encode an image to base64 (None for empty input)."""
    if bgr is None or bgr.size == 0:
        return None
    h, w = bgr.shape[:2]
    if w > max_width:
        s = max_width / float(w)
        bgr = cv2.resize(bgr, (max_width, max(1, int(round(h * s)))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _s(corner_mm: float, ppx: float, scale: float) -> int:
    return int(round(corner_mm * ppx * scale))


def render_debug(
    corrected_bgr: np.ndarray,
    ppx: float,
    bubbles: Sequence[Any],
    results_by_bubble: Dict[int, Dict[str, Any]],
    marker_centers: Optional[List[Tuple[float, float]]],
    marker_sizes_mm: Optional[Sequence[float]] = None,
    qr_rect_mm: Optional[Tuple[float, float, float]] = None,
    max_width: int = 1000,
) -> Optional[str]:
    """Render the annotated debug image and return base64 JPEG."""
    if corrected_bgr is None or corrected_bgr.size == 0:
        return None
    h, w = corrected_bgr.shape[:2]
    scale = min(1.0, max_width / float(w))
    out = (
        cv2.resize(corrected_bgr, (max_width, max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)
        if scale < 1 else corrected_bgr.copy()
    )
    if out.ndim == 2:
        out = cv2.cvtColor(out, cv2.COLOR_GRAY2BGR)

    # bubble overlays
    for i, b in enumerate(bubbles):
        res = results_by_bubble.get(i)
        if res is None:
            continue
        cx, cy = int(round(b.x_mm * ppx * scale)), int(round(b.y_mm * ppx * scale))
        rr = max(2, int(round(b.r_mm * ppx * scale)))
        color = STATUS_COLOR.get(res.get("status", "unanswered"), C_EMPTY)
        cv2.circle(out, (cx, cy), rr, color, 1 if b.kind == "sid" else 2)
        if res.get("detected"):
            cv2.circle(out, (cx, cy), max(2, rr - 2), color, 1)

    # per-question text (fill % + detected letter)
    font = cv2.FONT_HERSHEY_SIMPLEX
    q_rows: Dict[int, Dict[str, Any]] = {}
    for i, b in enumerate(bubbles):
        if b.kind != "answer" or b.question is None:
            continue
        res = results_by_bubble.get(i, {})
        q = q_rows.setdefault(b.question, {"top": 0.0, "detected": None, "status": "unanswered", "x": b.x_mm, "y": b.y_mm})
        q["top"] = max(q["top"], float(res.get("ratio", 0.0)))
        if res.get("detected"):
            q["detected"] = res["detected"]
            q["status"] = res.get("status", q["status"])
    for number in sorted(q_rows):
        q = q_rows[number]
        label = f"{number}:{q['detected'] or '-'} {q['top'] * 100:.0f}%"
        org = (int(round((q["x"] - 26.0) * ppx * scale)), int(round(q["y"] * ppx * scale)) + 4)
        color = STATUS_COLOR.get(q["status"], C_EMPTY)
        cv2.putText(out, label, org, font, 0.42, (30, 30, 30), 3, cv2.LINE_AA)
        cv2.putText(out, label, org, font, 0.42, color, 1, cv2.LINE_AA)

    # student ID digits text
    sid_digits: Dict[int, Dict[str, Any]] = {}
    for i, b in enumerate(bubbles):
        if b.kind != "sid" or b.digit is None:
            continue
        res = results_by_bubble.get(i, {})
        d = sid_digits.setdefault(b.digit, {"top": 0.0, "value": None, "status": "unanswered"})
        if float(res.get("ratio", 0.0)) > d["top"]:
            d["top"] = float(res.get("ratio", 0.0))
            d["value"] = b.value
            d["status"] = res.get("status", "unanswered")
    for d in sorted(sid_digits):
        info = sid_digits[d]
        first = next(b for b in bubbles if b.kind == "sid" and b.digit == d)
        label = str(info["value"]) if (info["status"] == "selected" and info["value"] is not None) else "?"
        org = (int(round(first.x_mm * ppx * scale)) - 4, int(round((first.y_mm - 4.0) * ppx * scale)))
        color = STATUS_COLOR.get(info["status"], C_EMPTY)
        cv2.putText(out, label, org, font, 0.5, (30, 30, 30), 3, cv2.LINE_AA)
        cv2.putText(out, label, org, font, 0.5, color, 1, cv2.LINE_AA)

    # marker boxes
    if marker_centers:
        for i, (cx, cy) in enumerate(marker_centers):
            size_mm = marker_sizes_mm[i] if marker_sizes_mm and i < len(marker_sizes_mm) else 7.0
            half = size_mm / 2.0 * ppx * scale
            p1 = (int(round(cx * scale - half)), int(round(cy * scale - half)))
            p2 = (int(round(cx * scale + half)), int(round(cy * scale + half)))
            cv2.rectangle(out, p1, p2, C_MARKER, 2)
            cv2.putText(out, ["TL", "TR", "BL", "BR"][i] if i < 4 else "M", (p1[0], max(12, p1[1] - 4)),
                        font, 0.4, C_MARKER, 1, cv2.LINE_AA)

    # QR region
    if qr_rect_mm:
        qx, qy, qs = qr_rect_mm
        p1 = (_s(qx, ppx, scale), _s(qy, ppx, scale))
        p2 = (_s(qx + qs, ppx, scale), _s(qy + qs, ppx, scale))
        cv2.rectangle(out, p1, p2, C_QR, 2)

    return encode_jpeg_b64(out, max_width=max_width, quality=80)
