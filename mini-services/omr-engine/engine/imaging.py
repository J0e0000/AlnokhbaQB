"""Image acquisition, preprocessing, sheet detection, perspective correction
and orientation resolution for the OMR engine.

Design notes
------------
* Detection runs on a downscaled copy (<=1240 px wide) for speed; all
  coordinates are rescaled back to full resolution before warping.
* Sheet detection strategies (in priority order):
    1. "document"  — largest 4-point document contour (paper edge on a
       photo; the printed frame / image border on a flat scan). Marker
       refinement later removes any frame-vs-page offset.
    2. "markers"   — the 4 solid near-square black corner markers
       (TL/TR/BL 7 mm, BR intentionally 5 mm — the size asymmetry is the
       orientation cue and disambiguates marker correspondence).
    3. "fullframe" — assume the image is exactly the sheet (clean scanner).
* ~90°-rotated sheets are handled by rotating the detection coordinates
  (never the image data): corrective rotations are tracked as a cumulative
  cv2 rotation code and points are inverse-mapped into original image
  coordinates, so the pipeline warps the ORIGINAL image exactly once.
* Perspective correction maps the 4 detected points onto canonical mm
  geometry at 300 dpi (2480x3508 for A4). When a template is available a
  second homography refines the warp from locally re-detected marker
  centers, eliminating residual frame/paper offset.
* Orientation: QR decode (with 4 crop rotations) is authoritative; when
  the QR is unreadable the marker-size asymmetry (smallest marker must
  sit at BR) fixes 90/180/270 rotations.
"""
import math
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np

from .errors import StageError

# ---------------------------------------------------------------- constants
DETECT_MAX_WIDTH = 1240          # working width for detection passes
MIN_IMAGE_WIDTH = 800            # reject anything narrower (mission spec)
CANONICAL_PPM = 300 / 25.4       # 11.811 px/mm at reference dpi

_ROT_CODES = {
    0: None,
    1: cv2.ROTATE_90_COUNTERCLOCKWISE,
    2: cv2.ROTATE_180,
    3: cv2.ROTATE_90_CLOCKWISE,
}
_ROT_DEG = {0: 0.0, 1: -90.0, 2: 180.0, 3: 90.0}  # cumulative, CW-positive


# ---------------------------------------------------------------- acquisition
def decode_base64_image(image_b64: str) -> np.ndarray:
    """Decode a base64 PNG/JPEG (raw or data-URL) into a BGR image."""
    import base64
    import binascii

    if not image_b64 or not isinstance(image_b64, str):
        raise StageError("imageLoaded", "imageBase64 is required")
    payload = image_b64.strip()
    if payload.startswith("data:"):  # data URL
        _, _, payload = payload.partition(",")
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise StageError("imageLoaded", f"invalid base64 image data: {exc}") from exc
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise StageError("imageLoaded", "image could not be decoded (png/jpeg expected)")
    h, w = img.shape[:2]
    if w < MIN_IMAGE_WIDTH:
        raise StageError("imageLoaded", f"image too small ({w}px wide; >= {MIN_IMAGE_WIDTH} required)")
    if h < 400:
        raise StageError("imageLoaded", f"image too small ({h}px tall)")
    return img


def to_gray(bgr: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


# ---------------------------------------------------------------- preprocessing
def _noise_estimate(gray: np.ndarray) -> float:
    """Mean absolute high-frequency residual on a sampled crop."""
    h, w = gray.shape
    y0, x0 = h // 4, w // 4
    crop = gray[y0:y0 + 600, x0:x0 + 600]
    if crop.size < 100:
        return 0.0
    sm = cv2.GaussianBlur(crop, (3, 3), 0)
    return float(np.mean(np.abs(crop.astype(np.int16) - sm.astype(np.int16))))


def preprocess(gray: np.ndarray) -> Tuple[np.ndarray, List[str]]:
    """Light, bubble-safe preprocessing.

    Heavy denoisers destroy faint pencil/ink fill gradients, so:
    - bilateral 5x5 only when real sensor noise is detected;
    - light CLAHE only for dark (low-light) captures.
    Returns (processed_gray, notes).
    """
    notes: List[str] = []
    out = gray
    noise = _noise_estimate(gray)
    if noise > 9.0:
        out = cv2.bilateralFilter(out, 5, 40, 40)
        notes.append(f"bilateral denoise applied (noiseEst={noise:.1f})")
    median = float(np.median(out))
    if median < 110:  # low-light capture
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        out = clahe.apply(out)
        notes.append(f"light CLAHE applied (median={median:.0f})")
    return out, notes


# ---------------------------------------------------------------- helpers
def order_points(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as TL, TR, BL, BR using the sum/diff trick."""
    pts = np.asarray(pts, dtype=np.float64)
    s = pts.sum(axis=1)
    d = pts[:, 1] - pts[:, 0]  # y - x
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    return np.array([tl, tr, bl, br], dtype=np.float64)


# Corner-index permutations of a geo-ordered quad [Q0=TL, Q1=TR, Q2=BL, Q3=BR]
# that map a rotated sheet onto the upright page, with the net corrective
# rotation each implies (deg, CW-positive):
#   upright          (Q0,Q1,Q2,Q3)  rot   0
#   content rot 180  (Q3,Q2,Q1,Q0)  rot +180
#   content rot 90CW (Q1,Q3,Q0,Q2)  rot  -90  (fixed by rotating CCW)
#   content rot 90CCW(Q2,Q0,Q3,Q1)  rot  +90  (fixed by rotating CW)
_PERM_UPRIGHT = (0, 1, 2, 3)
_PERM_180 = (3, 2, 1, 0)
_PERM_CW90 = (1, 3, 0, 2)
_PERM_CCW90 = (2, 0, 3, 1)


def quad_assignments(
    src: np.ndarray, aspect: float, page_aspect: float
) -> Tuple[List[np.ndarray], List[float]]:
    """Candidate src->dst corner assignments for a detected document quad.

    The pipeline validates each assignment with the QR payload (or the marker
    size asymmetry when the QR is unreadable), so both orientation options are
    offered instead of guessing one corrective rotation.
    """
    portrait_like = abs(aspect - page_aspect) / page_aspect <= 0.25
    landscape_like = abs(aspect * page_aspect - 1.0) <= 0.25
    if portrait_like:
        perms, rots = (_PERM_UPRIGHT, _PERM_180), (0.0, 180.0)
    elif landscape_like:
        perms, rots = (_PERM_CW90, _PERM_CCW90), (-90.0, 90.0)
    else:
        perms, rots = (_PERM_UPRIGHT,), (0.0,)
    return [np.array(src[list(p)], dtype=np.float64) for p in perms], list(rots)


def _inv_rotate_pts(pts: np.ndarray, rot_k: int, w0: int, h0: int) -> np.ndarray:
    """Map points from a rotated frame back into the pre-rotation frame.

    rot_k is the cumulative cv2 rotation applied to the frame (1=CCW, 2=180,
    3=CW); (w0, h0) are the PRE-rotation dimensions.
    """
    pts = np.asarray(pts, dtype=np.float64).copy()
    if rot_k == 0:
        return pts
    if rot_k == 1:      # current = CCW(det0): p' = (y, w0-1-x)
        x, y = pts[:, 0].copy(), pts[:, 1].copy()
        pts[:, 0] = w0 - 1 - y
        pts[:, 1] = x
    elif rot_k == 2:    # p' = (w0-1-x, h0-1-y)
        pts[:, 0] = w0 - 1 - pts[:, 0]
        pts[:, 1] = h0 - 1 - pts[:, 1]
    elif rot_k == 3:    # p' = (h0-1-y, x)
        x, y = pts[:, 0].copy(), pts[:, 1].copy()
        pts[:, 0] = y
        pts[:, 1] = h0 - 1 - x
    return pts


@dataclass
class SheetDetection:
    """Result of the sheet-detection stage (full-resolution coordinates)."""

    strategy: str
    src_pts: np.ndarray                          # 4x2, geo TL,TR,BL,BR order
    dst_kind: str                                # 'page' | 'markers'
    assignments: List[np.ndarray] = field(default_factory=list)  # candidate src orders
    marker_areas: Optional[np.ndarray] = None
    small_idx: Optional[int] = None              # geo index of the small (BR) marker
    pre_rotation_deg: float = 0.0                # corrective rotation applied (CW-positive)
    notes: List[str] = field(default_factory=list)
    # Per-assignment net corrective rotation (deg, CW-positive) that the
    # pipeline adds to diagnostics when that assignment is chosen.
    assignment_rots: List[float] = field(default_factory=list)
    # Marker-based alternative detection. Filled when a document-contour (or
    # full-frame) quad won: if that warp proves unstable (markers cannot be
    # re-found near their canonical positions — e.g. a scanner scan rotated
    # 3-10° with white margins, where the bright region is the canvas, not the
    # sheet), the pipeline re-warps using this detection instead.
    fallback: Optional["SheetDetection"] = None


# ------------------------------------------------------------- doc contour
def _find_doc_quad(binimg: np.ndarray, page_aspect: float) -> Optional[np.ndarray]:
    """Largest quad-like bright contour (paper edge / frame). Det-scale pts."""
    cnts, _ = cv2.findContours(binimg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    img_area = binimg.shape[0] * binimg.shape[1]
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(c)
        if area < 0.30 * img_area:
            break  # sorted desc — nothing bigger remains
        for eps in (0.02, 0.035, 0.05):
            approx = cv2.approxPolyDP(c, eps * cv2.arcLength(c, True), True)
            if len(approx) != 4:
                continue
            if not cv2.isContourConvex(approx):
                continue
            pts = approx.reshape(4, 2).astype(np.float64)
            ordered = order_points(pts)
            wq = float(np.linalg.norm(ordered[1] - ordered[0]))
            hq = float(np.linalg.norm(ordered[2] - ordered[0]))
            if wq < 10 or hq < 10:
                continue
            aspect = wq / max(hq, 1e-6)
            ra = min(aspect, 1.0 / aspect)
            rp = min(page_aspect, 1.0 / page_aspect)
            if abs(ra - rp) / rp <= 0.45:
                return ordered
    return None


# ------------------------------------------------------------- markers
def _marker_candidates(inv: np.ndarray, det_ppm: float) -> List[Tuple[float, float, float]]:
    """Solid near-square dark blobs of plausible marker size (det-scale px).

    Rejections (all calibrated on real degradations):
    - area outside [16, 130] mm^2: below 16 mm^2 excludes filled answer
      bubbles (~11 mm^2 solid disks) which otherwise masquerade as markers;
    - centroids inside the canonical QR square (18..48 mm): the QR finder
      patterns are solid ~20 mm^2 squares that otherwise join the quad.
    """
    cnts, _ = cv2.findContours(inv, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    out: List[Tuple[float, float, float]] = []
    for c in cnts:
        a = cv2.contourArea(c)
        amm2 = a / (det_ppm * det_ppm)
        # 10-20° in-plane rotation inflates the bounding box of a square
        # (a/(w*h) = 1/(cos+sin)^2 = 0.75 at 10°, 0.70 at 15°) and Otsu
        # erodes antialiased edges, so the rectangularity/area gates must
        # be rotation-tolerant.
        if amm2 < 16.0 or amm2 > 130.0:
            continue
        x, y, w, h = cv2.boundingRect(c)
        if w < 3 or h < 3:
            continue
        aspect = w / float(h)
        if not (0.60 <= aspect <= 1.67):
            continue
        hull_area = cv2.contourArea(cv2.convexHull(c))
        if hull_area <= 0 or a / hull_area < 0.86:  # solidity
            continue
        if a / (w * h) < 0.58:  # rectangularity (rotation-tolerant)
            continue
        m = cv2.moments(c)
        if m["m00"] <= 0:
            continue
        cx = float(m["m10"] / m["m00"])
        cy = float(m["m01"] / m["m00"])
        xmm, ymm = cx / det_ppm, cy / det_ppm
        if 18.0 <= xmm <= 48.0 and 18.0 <= ymm <= 48.0:
            continue  # QR finder pattern, not a corner marker
        out.append((cx, cy, float(a)))
    out.sort(key=lambda t: t[2], reverse=True)
    return out[:10]


def _quad_score(pts: np.ndarray, areas: np.ndarray, page_aspect: float) -> Optional[float]:
    """Score a geo-ordered marker quad; None if geometrically invalid.

    Favours rectangle-like quads with the 3-big + 1-small area pattern
    (BR marker is intentionally 5mm vs 7mm, area ratio ~0.51).
    """
    top = float(np.linalg.norm(pts[1] - pts[0]))
    bot = float(np.linalg.norm(pts[3] - pts[2]))
    left = float(np.linalg.norm(pts[2] - pts[0]))
    right = float(np.linalg.norm(pts[3] - pts[1]))
    if min(top, bot, left, right) < 8:
        return None

    def ang(v: np.ndarray) -> float:
        return math.degrees(math.atan2(float(v[1]), float(v[0])))

    par = max(
        abs(ang(pts[1] - pts[0]) - ang(pts[3] - pts[2])),
        abs(ang(pts[2] - pts[0]) - ang(pts[3] - pts[1])),
    )
    par = min(par, 180.0 - par)
    if par > 28:
        return None
    width = (top + bot) / 2.0
    height = (left + right) / 2.0
    aspect = width / max(height, 1e-6)
    ra = min(aspect, 1.0 / aspect)
    rp = min(page_aspect, 1.0 / page_aspect)
    if abs(ra - rp) / rp > 0.45:
        return None
    med = float(np.median(areas))
    small = float(areas.min())
    if med <= 0:
        return None
    ratio = small / med
    if ratio > 0.85:    # all similar — allow but weak pattern
        pattern = 0.35
    elif ratio < 0.20:  # something tiny crept in
        pattern = 0.20
    else:               # ideal ~0.51 for 5mm vs 7mm markers
        pattern = max(0.0, 1.0 - abs(ratio - 0.51) / 0.35)
    consist = 1.0 - (max(top, bot) - min(top, bot)) / max(top, bot)
    consist2 = 1.0 - (max(left, right) - min(left, right)) / max(left, right)
    return pattern * 2.0 + consist + consist2 + (1.0 - par / 28.0)


def _choose_marker_quad(
    cands: List[Tuple[float, float, float]], page_aspect: float
) -> Optional[Tuple[np.ndarray, np.ndarray, int]]:
    """Pick the best 4-blob subset; returns (pts geo-ordered, areas, small_idx)."""
    if len(cands) < 4:
        return None
    pts_all = np.array([[c[0], c[1]] for c in cands], dtype=np.float64)
    areas_all = np.array([c[2] for c in cands], dtype=np.float64)
    n = len(cands)
    best: Optional[Tuple[float, np.ndarray, np.ndarray, int]] = None
    for i in range(n - 3):
        for j in range(i + 1, n - 2):
            for k in range(j + 1, n - 1):
                for l in range(k + 1, n):
                    idx = [i, j, k, l]
                    sub = pts_all[idx]
                    areas = areas_all[idx]
                    ordered = order_points(sub)
                    area_ordered = np.zeros(4)
                    for oi, p in enumerate(ordered):
                        dists = np.linalg.norm(sub - p, axis=1)
                        area_ordered[oi] = areas[int(np.argmin(dists))]
                    score = _quad_score(ordered, area_ordered, page_aspect)
                    if score is None:
                        continue
                    if best is None or score > best[0]:
                        best = (score, ordered, area_ordered, int(np.argmin(area_ordered)))
    if best is None:
        return None
    _, ordered, areas, small_idx = best
    return ordered, areas, small_idx


def _big_marker_assignments(src_pts: np.ndarray, areas: np.ndarray) -> List[np.ndarray]:
    """Candidate correspondences: small marker -> BR; bigs rotate cyclically.

    Assignment #1 puts the geo-ordered big markers on canonical TL,TR,BL.
    The alternates are tried only when the QR cannot confirm the first one.
    """
    small = int(np.argmin(areas))
    bigs = [i for i in range(4) if i != small]
    out = []
    for shift in range(3):
        order = [bigs[(0 + shift) % 3], bigs[(1 + shift) % 3], bigs[(2 + shift) % 3], small]
        out.append(src_pts[order].copy())
    return out


# ------------------------------------------------------------- main detect
def detect_sheet(gray: np.ndarray, page_w_mm: float, page_h_mm: float) -> SheetDetection:
    """Detect the sheet + correspondence candidates (full-res coordinates)."""
    page_aspect = page_w_mm / page_h_mm
    scale = min(1.0, DETECT_MAX_WIDTH / float(gray.shape[1]))
    det0 = (
        cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        if scale < 1 else gray
    )
    w0, h0 = det0.shape[1], det0.shape[0]
    rot_k = 0
    pre_rot_deg = 0.0
    notes: List[str] = []

    def det() -> np.ndarray:
        return det0 if rot_k == 0 else cv2.rotate(det0, _ROT_CODES[rot_k])

    def full_pts(pts_det: np.ndarray) -> np.ndarray:
        inv = _inv_rotate_pts(pts_det, rot_k, w0, h0)
        return inv / scale

    def det_ppm() -> float:
        """Rotation-invariant px/mm estimate assuming the sheet fills the frame."""
        return math.sqrt((det().shape[0] * det().shape[1]) / (page_w_mm * page_h_mm))

    def marker_pass() -> Optional["SheetDetection"]:
        """Marker-based detection on the current det frame (fallback chain)."""
        d = det()
        _, inv = cv2.threshold(d, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        cands = _marker_candidates(inv, det_ppm())
        if len(cands) < 4:
            return None
        chosen = _choose_marker_quad(cands, page_aspect)
        if chosen is None:
            return None
        ordered, areas, small_idx = chosen
        src_m = full_pts(ordered)
        return SheetDetection(
            strategy="markers", src_pts=src_m, dst_kind="markers",
            assignments=_big_marker_assignments(src_m, areas),
            assignment_rots=[0.0, 0.0, 0.0],
            marker_areas=areas, small_idx=small_idx,
            pre_rotation_deg=pre_rot_deg, notes=notes,
        )

    # --- strategy 1: document contour (paper edge on photos; frame / image
    #     border on flat scans). Orientation is NOT guessed here: the pipeline
    #     validates corner assignments with the QR payload (both 90° options
    #     for a landscape quad, plus 180° for a portrait quad).
    d = det()
    _, binw = cv2.threshold(d, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    quad = _find_doc_quad(binw, page_aspect)
    if quad is not None:
        wq = float(np.linalg.norm(quad[1] - quad[0]))
        hq = float(np.linalg.norm(quad[2] - quad[0]))
        aspect = wq / max(hq, 1e-6)
        src = full_pts(quad)
        assign, rots = quad_assignments(src, aspect, page_aspect)
        if len(assign) > 1:
            notes.append(
                "document quad %s — rotated-corner assignments offered for QR/marker validation"
                % ("landscape" if aspect > 1.0 else "portrait")
            )
        return SheetDetection(
            strategy="document", src_pts=src, dst_kind="page",
            assignments=assign, assignment_rots=rots,
            pre_rotation_deg=pre_rot_deg, notes=notes,
            fallback=marker_pass(),
        )

    # --- strategy 2: corner markers; the 5mm BR marker fixes orientation
    for attempt in range(3):
        d = det()
        _, inv = cv2.threshold(d, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        cands = _marker_candidates(inv, det_ppm())
        chosen = _choose_marker_quad(cands, page_aspect) if len(cands) >= 4 else None
        if chosen is None:
            break
        ordered, areas, small_idx = chosen
        if small_idx == 3:
            src = full_pts(ordered)
            return SheetDetection(
                strategy="markers", src_pts=src, dst_kind="markers",
                assignments=_big_marker_assignments(src, areas),
                assignment_rots=[0.0, 0.0, 0.0],
                marker_areas=areas, small_idx=small_idx,
                pre_rotation_deg=pre_rot_deg, notes=notes,
            )
        if attempt < 2:
            delta = {0: 2, 1: 1, 2: 3}[small_idx]
            rot_k = (rot_k + delta) % 4
            pre_rot_deg += _ROT_DEG[delta]
            notes.append(
                f"small marker at geo index {small_idx} — corrective rotation "
                f"{_ROT_DEG[delta]:+.0f}°"
            )
            continue
        notes.append("marker size cue inconsistent after correction; using geometry")
        src = full_pts(ordered)
        return SheetDetection(
            strategy="markers", src_pts=src, dst_kind="markers",
            assignments=_big_marker_assignments(src, areas),
            assignment_rots=[0.0, 0.0, 0.0],
            marker_areas=areas, small_idx=small_idx,
            pre_rotation_deg=pre_rot_deg, notes=notes,
        )

    # --- strategy 3: full frame (clean scanner photo of the whole sheet)
    img_aspect = gray.shape[1] / float(gray.shape[0])
    d = det()
    dh, dw = d.shape[:2]
    corners = np.array([[0, 0], [dw - 1, 0], [0, dh - 1], [dw - 1, dh - 1]], dtype=np.float64)
    src = full_pts(corners)
    assign, rots = quad_assignments(src, img_aspect, page_aspect)
    if len(assign) > 1:
        notes.append(
            "full frame %s — rotated-corner assignments offered for QR/marker validation"
            % ("landscape" if img_aspect > 1.0 else "portrait")
        )
    return SheetDetection(
        strategy="fullframe", src_pts=src, dst_kind="page",
        assignments=assign, assignment_rots=rots,
        pre_rotation_deg=pre_rot_deg, notes=notes,
        fallback=marker_pass(),
    )


# ------------------------------------------------------------- warping
def warp_src_to_dst(
    bgr: np.ndarray, src: np.ndarray, dst: np.ndarray, out_size: Tuple[int, int]
) -> np.ndarray:
    """Single perspective warp of the ORIGINAL image into canonical geometry."""
    H = cv2.getPerspectiveTransform(
        np.asarray(src, dtype=np.float32), np.asarray(dst, dtype=np.float32)
    )
    return cv2.warpPerspective(bgr, H, out_size, flags=cv2.INTER_LINEAR)


# ------------------------------------------------------------- refinement
def refine_markers(
    gray_corr: np.ndarray,
    marker_centers_mm: Sequence[Tuple[str, float, float, float]],
    ppx: float,
    search_mm: float = 9.0,
) -> Tuple[Optional[List[Tuple[float, float]]], List[float], List[str]]:
    """Locate each marker near its canonical position in the corrected image.

    Returns (centers or None, blob_areas_px2, notes). Non-destructive: any
    failure keeps the existing warp and is reported in notes.

    Acceptance gates are deliberately tighter than the search window: a blob
    whose centroid drifts >0.72*search from the canonical center or whose
    area is outside 0.35..2.2x the expected size is treated as "marker not
    found" — a permissive window once accepted paper-corner shadows and
    produced a bogus second homography.
    """
    notes: List[str] = []
    centers: List[Tuple[float, float]] = []
    areas: List[float] = []
    h, w = gray_corr.shape[:2]
    for mid, xmm, ymm, smm in marker_centers_mm:
        ecx, ecy = xmm * ppx, ymm * ppx
        half = int((smm / 2.0 + search_mm) * ppx)
        x0, x1 = max(0, int(ecx) - half), min(w, int(ecx) + half)
        y0, y1 = max(0, int(ecy) - half), min(h, int(ecy) + half)
        if x1 - x0 < 8 or y1 - y0 < 8:
            notes.append(f"marker {mid}: search window out of image")
            return None, [], notes
        crop = gray_corr[y0:y1, x0:x1]
        t, bininv = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        cnts, _ = cv2.findContours(bininv, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        expected_area = (smm * smm) * ppx * ppx
        best = None
        for c in cnts:
            a = cv2.contourArea(c)
            if a < 0.35 * expected_area or a > 2.2 * expected_area:
                continue
            if best is None or a > best[0]:
                best = (a, c)
        if best is None:
            notes.append(f"marker {mid}: no blob in search window (otsu={t:.0f})")
            return None, [], notes
        m = cv2.moments(best[1])
        if m["m00"] <= 0:
            notes.append(f"marker {mid}: degenerate blob")
            return None, [], notes
        cx, cy = x0 + m["m10"] / m["m00"], y0 + m["m01"] / m["m00"]
        if math.hypot(cx - ecx, cy - ecy) > search_mm * ppx * 0.72:
            notes.append(f"marker {mid}: centroid too far from canonical position")
            return None, [], notes
        centers.append((float(cx), float(cy)))
        areas.append(float(best[0]))
    return centers, areas, notes


def marker_orientation_ok(areas: Sequence[float]) -> bool:
    """Marker-size sanity for upright orientation.

    The BR marker is intentionally 5 mm vs 7 mm elsewhere, so in an upright
    sheet the blob found at the BR position must not be bigger than the one
    at TL. An inverted (180°) sheet swaps them and fails this check.
    """
    if len(areas) < 4 or areas[0] <= 0:
        return False
    return bool(areas[3] <= areas[0] * 1.25)


def marker_quad_ok(
    centers: Sequence[Tuple[float, float]], page_w_mm: float, page_h_mm: float
) -> bool:
    """Geometry sanity on 4 refined marker centers (canonical order).

    True marker centers always form a near-perfect rectangle (182 x 269 mm
    with the canonical layout). A quad that is skewed, inconsistent in side
    lengths, or badly off-aspect means at least one 'marker' is actually a
    stray blob — the refinement/confirmation must be rejected.
    """
    if len(centers) != 4:
        return False
    pts = np.asarray(centers, dtype=np.float64)
    top = float(np.linalg.norm(pts[1] - pts[0]))
    bot = float(np.linalg.norm(pts[3] - pts[2]))
    left = float(np.linalg.norm(pts[2] - pts[0]))
    right = float(np.linalg.norm(pts[3] - pts[1]))
    if min(top, bot, left, right) < 8:
        return False

    def ang(v: np.ndarray) -> float:
        return math.degrees(math.atan2(float(v[1]), float(v[0])))

    par = max(
        abs(ang(pts[1] - pts[0]) - ang(pts[3] - pts[2])),
        abs(ang(pts[2] - pts[0]) - ang(pts[3] - pts[1])),
    )
    par = min(par, 180.0 - par)
    if par > 6.0:
        return False
    if abs(top - bot) / max(top, bot) > 0.10:
        return False
    if abs(left - right) / max(left, right) > 0.10:
        return False
    aspect = (top + bot) / 2.0 / max((left + right) / 2.0, 1e-6)
    ra, rp = min(aspect, 1.0 / aspect), min(page_w_mm / page_h_mm, page_h_mm / page_w_mm)
    if abs(ra - rp) / rp > 0.30:
        return False
    return True


def residual_rotation_deg(centers: List[Tuple[float, float]], dst: np.ndarray) -> float:
    """In-plane rotation still present after the first warp (degrees)."""
    src_v = np.array(centers[1]) - np.array(centers[0])
    dst_v = dst[1] - dst[0]
    a1 = math.degrees(math.atan2(src_v[1], src_v[0]))
    a2 = math.degrees(math.atan2(dst_v[1], dst_v[0]))
    d = a1 - a2
    while d > 180:
        d -= 360
    while d < -180:
        d += 360
    return float(d)


# ------------------------------------------------------------- QR
def decode_qr(
    gray_corr: np.ndarray,
    qr_mm: Optional[Tuple[float, float, float]] = None,
    ppx: float = CANONICAL_PPM,
) -> Tuple[Optional[str], int, List[str]]:
    """Decode the QR in the corrected image.

    Tries the expected region (two margins) upscaled, in 4 rotations.
    Returns (payload, rotation_k_used, notes). rotation_k is the np.rot90
    count that made the payload readable (0 = content upright).
    """
    detector = cv2.QRCodeDetector()
    notes: List[str] = []
    if qr_mm is not None:
        qx, qy, qs = qr_mm
    else:
        qx, qy, qs = 20.0, 20.0, 30.0  # generous default region
    h, w = gray_corr.shape[:2]
    # Prefer upright-crop attempts at both margins first: cv2's detector
    # sometimes decodes an upright QR only from a rotated crop (border
    # effects), so rotated-crop attempts are a last resort — the crop
    # rotation k is a weak orientation signal.
    attempts: Tuple[Tuple[float, int], ...] = (
        (3.0, 0), (6.0, 0), (3.0, 2), (6.0, 2), (3.0, 1), (6.0, 1), (3.0, 3), (6.0, 3),
        (9.0, 0), (9.0, 2), (9.0, 1), (9.0, 3),
    )
    for margin_mm, k in attempts:
        x0 = max(0, int((qx - margin_mm) * ppx))
        y0 = max(0, int((qy - margin_mm) * ppx))
        x1 = min(w, int((qx + qs + margin_mm) * ppx))
        y1 = min(h, int((qy + qs + margin_mm) * ppx))
        crop = gray_corr[y0:y1, x0:x1]
        if crop.size == 0:
            continue
        up = max(1.0, 260.0 / float(max(crop.shape[:2])))
        if up > 1.0:
            crop = cv2.resize(crop, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
        var = np.ascontiguousarray(crop if k == 0 else np.rot90(crop, k))
        # contrast-normalized + Otsu variants: phone JPEG/illumination shifts
        # often push the QR below the detector's contrast floor
        variants = [var]
        if margin_mm == attempts[-1][0]:  # widest margin — try harder per rotation
            norm = cv2.normalize(var, None, 0, 255, cv2.NORM_MINMAX)
            variants.append(norm)
            _, binv = cv2.threshold(var, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            variants.append(binv)
        for v in variants:
            try:
                payload, _, _ = detector.detectAndDecode(np.ascontiguousarray(v))
            except cv2.error as exc:  # pragma: no cover - defensive
                notes.append(f"qr detector error: {exc}")
                continue
            if payload:
                return payload, k, notes
    notes.append("QR not decoded in any region/rotation")
    return None, -1, notes
