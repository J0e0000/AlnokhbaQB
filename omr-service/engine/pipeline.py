# ============================================================
# ALNOKHBA QB — OMR Recognition Pipeline (OpenCV)
# Canonical-template-driven: every bubble location comes from the
# SAME OMRTemplate JSON that generated the printed sheet.
# Pipeline: validate → preprocess → sheet detect → perspective
#   correction → orientation fix → template identity → bubble
#   fill analysis → answer determination → confidence → grading.
# ============================================================
import base64
import hashlib
import io
import math
import time
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

QR_DETECTOR = cv2.QRCodeDetector()
A4 = {"widthMm": 210.0, "heightMm": 297.0}

# Per-request QR v2 signing secret (set by process(); same for every request
# in a deployment, so the module-global races of ThreadingHTTPServer are moot).
_QR_SECRET: Optional[str] = None


def _find_contours(binary: np.ndarray, mode=cv2.RETR_LIST):
    """findContours wrapper. NOTE: OpenCV 4.13.0 has a RETR_EXTERNAL/CCOMP
    regression (disjoint blobs collapse into one contour), so we use RETR_LIST
    and filter top-level contours via the hierarchy (parent == -1)."""
    contours, hierarchy = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy.reshape(-1, 4)
    if mode == cv2.RETR_EXTERNAL:
        return [contours[i] for i in range(len(contours)) if hierarchy[i][3] == -1]
    return list(contours)


# ---------------- QR payload helpers (mirror of TS omr-template.ts) ----------

def omr_checksum(exam_version_id: str, template_id: str, sheet: int) -> str:
    raw = f"{exam_version_id}|{template_id}|{sheet}".encode()
    return hashlib.sha256(raw).hexdigest()[:8].upper()


def _qr_hmac(exam_version_id: str, template_id: str, sheet: int, sheets: int, secret: str) -> str:
    import hmac as _hmac

    raw = f"2|{exam_version_id}|{template_id}|{sheet}|{sheets}".encode()
    return _hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()[:10].upper()


def parse_qr_payload(payload: str, secret: Optional[str] = None) -> Optional[Dict[str, Any]]:
    try:
        parts = payload.strip().split("|")
        # ---- v2 (HMAC-signed): ANQB2|evid|tid|sheet|sheets|mac10
        if len(parts) == 6 and parts[0] == "ANQB2":
            _, exam_version_id, template_id, sheet_s, sheets_s, mac = parts
            if not secret:
                # v2 payloads MUST be verified; without the secret reject —
                # the Next.js layer always passes it server-to-server.
                return None
            sheet = int(sheet_s)
            sheets = int(sheets_s)
            if sheet < 0 or sheets < 1 or sheet >= sheets:
                return None
            expected = _qr_hmac(exam_version_id, template_id, sheet, sheets, secret)
            if mac.upper() != expected:
                return None
            return {
                "examVersionId": exam_version_id,
                "templateId": template_id,
                "sheet": sheet,
                "sheets": sheets,
                "v": 2,
            }
        # ---- v1 (legacy, sha256-8 checksum): ANQB|1|evid|tid|sheet|sheets|check
        if len(parts) != 7 or parts[0] != "ANQB":
            return None
        _, ver, exam_version_id, template_id, sheet_s, sheets_s, check = parts
        if ver != "1":
            return None
        sheet = int(sheet_s)
        sheets = int(sheets_s)
        if sheet < 0 or sheets < 1 or sheet >= sheets:
            return None
        expected = omr_checksum(exam_version_id, template_id, sheet)
        if check.upper() != expected:
            return None
        return {
            "examVersionId": exam_version_id,
            "templateId": template_id,
            "sheet": sheet,
            "sheets": sheets,
            "v": 1,
        }
    except Exception:
        return None


# ---------------- Stage 1: load & validate ----------------

def load_image_b64(image_b64: str) -> np.ndarray:
    """Decode base64 (png/jpeg) → BGR ndarray. Raises ValueError on bad input."""
    if not image_b64 or not isinstance(image_b64, str):
        raise ValueError("imageBase64 is required")
    # tolerate data URLs
    if "," in image_b64 and image_b64.strip().startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    try:
        buf = base64.b64decode(image_b64, validate=False)
    except Exception as e:
        raise ValueError(f"invalid base64 image: {e}")
    arr = np.frombuffer(buf, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image (unsupported format?)")
    h, w = img.shape[:2]
    if w < 500 or h < 500:
        raise ValueError(f"image too small ({w}x{h}) — need at least 500x500")
    # Cap the long edge: phone photos ship at 12-108MP; every downstream stage
    # (flat-field, marker detection, QR decode, warp) is ~linear in pixels.
    # A4 at 3600px ≈ 306 DPI — matches the engine's canonical warp resolution
    # and bounds worst-case latency on slow serverless CPU. The cap is ALSO an
    # accuracy control: re-sampling borderline fills shifts measured ratios by
    # ~0.01-0.015, so the cap must stay as close as possible to the warp DPI
    # (300) where the fill thresholds were calibrated.
    long_edge = max(w, h)
    if long_edge > 3600:
        scale = 3600.0 / long_edge
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    elif w * h > 40_000_000:
        scale = math.sqrt(40_000_000 / (w * h))
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


# ---------------- Stage 2: preprocessing ----------------

def preprocess(img_bgr: np.ndarray) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """Light, bubble-safe preprocessing + flat-field illumination normalization.
    Returns (normalized_gray, raw_gray, info)."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    info: Dict[str, Any] = {}
    # Noise estimate via Laplacian variance; denoise only when clearly noisy.
    lap_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    info["laplacianVar"] = round(float(lap_var), 1)
    work = gray
    if lap_var < 120:  # very blurry/noisy
        work = cv2.bilateralFilter(gray, 5, 40, 40)
        info["denoised"] = True
        info["warnings"] = ["الصورة غير واضحة (اهتزاز/تمويه في التصوير) — تم تقليل الضجيج تلقائيًا"]
    # ---- Exposure quality (port of the legacy assessor in nokhba-qb) ----
    # Same thresholds as the original client: <55 too dark, >250 blown out.
    mean_l = float(gray.mean())
    info["brightness"] = round(mean_l, 1)
    qwarn: List[str] = list(info.get("warnings") or [])
    if mean_l < 55:
        qwarn.append("الإضاءة ضعيفة جدًا")
    elif mean_l > 250:
        qwarn.append("الصورة محروقة من الإضاءة")
    if qwarn:
        info["warnings"] = qwarn
    # ---- Flat-field normalization (kills lighting gradients / shadows) ----
    # Background estimate: close with a kernel much larger than any dark mark
    # (markers ~83px) so marks stay dark while slow shading is captured.
    # PERF: the background is a SMOOTH illumination field — estimating it on a
    # downscaled copy (max edge 800px) and upscaling it back is numerically
    # equivalent for the divide, and the huge-kernel morphology runs ~12x less
    # pixels (was 1.8s of the total 5s on 12MP inputs).
    sh, sw = work.shape[:2]
    fscale = min(1.0, 800.0 / max(sh, sw))
    if fscale < 1.0:
        small = cv2.resize(work, (max(1, int(sw * fscale)), max(1, int(sh * fscale))), interpolation=cv2.INTER_AREA)
    else:
        small = work
    k = max(61, int(min(small.shape) * 0.05) | 1)
    bg = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    bg = cv2.GaussianBlur(bg, (0, 0), max(4.0, k / 12.0))
    if fscale < 1.0:
        bg = cv2.resize(bg, (sw, sh), interpolation=cv2.INTER_LINEAR)
    bg = np.maximum(bg, 1)
    norm = cv2.divide(work, bg, scale=255)
    info["normalized"] = True
    info["meanIntensity"] = round(float(norm.mean()), 1)
    return norm, gray, info


# ---------------- Stage 3: sheet detection ----------------

def _order_points(pts: np.ndarray) -> np.ndarray:
    """Order 4 points: TL, TR, BR, BL. Uses angular sorting around the
    centroid (robust for diamond/45° quads where sum/diff heuristics tie),
    anchored so the first point is the most top-left one."""
    pts = np.array(pts, dtype=np.float32)
    c = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    order = np.argsort(ang)  # clockwise in y-down coords
    pts = pts[order]
    # rotate sequence so the point with min (x+y) — the TL-most — is first
    start = int(np.argmin(pts[:, 0] + pts[:, 1]))
    pts = np.roll(pts, -start, axis=0)
    return pts


def _marker_candidates(
    binary: np.ndarray,
    min_sz: float,
    max_sz: float,
    aspect_max: float,
    rect_min: float,
    fill_min: float,
) -> List[Tuple[float, float, float, float]]:
    """Solid, near-square dark blobs within the given mm-based size bounds."""
    contours = _find_contours(binary, cv2.RETR_EXTERNAL)
    candidates: List[Tuple[float, float, float, float]] = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_sz * min_sz * 0.6 or area > max_sz * max_sz:
            continue
        (cx, cy), (rw, rh), _angle = cv2.minAreaRect(c)
        if rw == 0 or rh == 0:
            continue
        size = float(max(rw, rh))
        if size < min_sz or size > max_sz:
            continue
        rectangularity = area / (rw * rh)
        aspect = size / max(1e-6, min(rw, rh))
        if rectangularity < rect_min or aspect > aspect_max:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        mask = np.zeros((bh, bw), dtype=np.uint8)
        cv2.drawContours(mask, [c], -1, 255, -1, offset=(-x, -y))
        mask_nz = cv2.countNonZero(mask)
        if mask_nz <= 0:
            continue
        fill = cv2.countNonZero(cv2.bitwise_and(binary[y:y + bh, x:x + bw], mask)) / float(mask_nz)
        if fill < fill_min:
            continue
        candidates.append((float(cx), float(cy), size, area))
    return candidates


def _pick_corner_markers(
    candidates: List[Tuple[float, float, float, float]], w: int, h: int
) -> Optional[List[Tuple[float, float, float]]]:
    """Keep the 4 biggest candidates that sit in the page's corner zones and
    span the sheet. Rejects clustered blobs — a garbage homography that
    silently misreads every bubble is worse than a clean failure."""
    if not candidates:
        return None

    def corner_zone(c: Tuple[float, float, float, float]) -> bool:
        cx, cy = c[0], c[1]
        near_x = cx < w * 0.32 or cx > w * 0.68
        near_y = cy < h * 0.32 or cy > h * 0.68
        return near_x and near_y

    zoned = [c for c in candidates if corner_zone(c)]
    pool = zoned if len(zoned) >= 3 else candidates
    if len(pool) < 3:
        return None
    pool.sort(key=lambda t: -t[3])
    chosen = [(c[0], c[1], c[2]) for c in pool[:4]]
    if len(chosen) >= 3:
        xs = [c[0] for c in chosen]
        ys = [c[1] for c in chosen]
        span_x = (max(xs) - min(xs)) / max(1, w)
        span_y = (max(ys) - min(ys)) / max(1, h)
        if len(chosen) == 4 and (span_x < 0.5 or span_y < 0.5):
            return None
        if len(chosen) == 3 and (span_x < 0.4 or span_y < 0.4):
            return None
    return chosen


def find_corner_markers(gray: np.ndarray) -> Optional[List[Tuple[float, float, float]]]:
    """Find the 4 largest solid near-square dark blobs (the corner markers).
    Prefers blobs lying in the page's corner zones. Markers print at 5-7mm;
    QR finder inners (~1.5mm), text and frame fragments are excluded by
    mm-based size bounds (page width assumed A4 for scale).

    Oblique phone photos distort the markers (a square becomes a trapezoid,
    and a marker touching the printed frame merges into one blob), so a strict
    Otsu pass alone misses them. Three passes run in order of strictness and
    the first one that yields a spatially valid set wins — the strict pass
    still handles flatbed scans exactly as before."""
    h, w = gray.shape[:2]
    # area-based scale estimate — orientation-independent (works for rotated
    # landscape captures of a portrait A4 sheet)
    px_per_mm_est = (w * h / (210.0 * 297.0)) ** 0.5
    # smallest real marker is 5mm; QR finder rings (~3.5mm) must stay excluded.
    min_sz = 4.2 * px_per_mm_est
    max_sz = 11.0 * px_per_mm_est

    otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    close5 = cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
    # opening separates a marker that bled into the frame edge
    split = cv2.morphologyEx(
        cv2.morphologyEx(close5, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))),
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
    )
    # local threshold survives uneven lighting the global Otsu pass smears out
    adaptive = cv2.adaptiveThreshold(
        cv2.GaussianBlur(gray, (5, 5), 0), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 51, 12,
    )
    adaptive = cv2.morphologyEx(adaptive, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))

    passes = (
        (close5, min_sz, max_sz, 1.35, 0.75, 0.75),
        (split, 3.6 * px_per_mm_est, 13.0 * px_per_mm_est, 1.6, 0.65, 0.60),
        (adaptive, 3.6 * px_per_mm_est, 13.0 * px_per_mm_est, 1.6, 0.65, 0.55),
    )
    for binary, lo, hi, aspect_max, rect_min, fill_min in passes:
        cands = _marker_candidates(binary, lo, hi, aspect_max, rect_min, fill_min)
        chosen = _pick_corner_markers(cands, w, h)
        if chosen:
            return chosen
    return None


def detect_document_quad(gray: np.ndarray) -> Optional[np.ndarray]:
    """Largest 4-point contour (the paper edges), if clearly visible."""
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    thr = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    thr = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)))
    contours = _find_contours(thr, cv2.RETR_EXTERNAL)
    h, w = gray.shape[:2]
    best, best_area = None, 0
    for c in contours:
        area = cv2.contourArea(c)
        if area < h * w * 0.35:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx) and area > best_area:
            best, best_area = approx, area
    if best is None:
        return None
    return _order_points(best.reshape(4, 2))


# ---------------- Stage 4: perspective correction ----------------

# Canonical marker layout (mirrors OMR_GEOMETRY in src/lib/qb/omr-template.ts).
# The generator ALWAYS prints markers at these positions, so the engine can
# warp by markers even before the template is resolved.
CANONICAL_MARKERS = [
    {"id": "TL", "x": 14.0, "y": 14.0, "sizeMm": 7},
    {"id": "TR", "x": 196.0, "y": 14.0, "sizeMm": 7},
    {"id": "BL", "x": 14.0, "y": 283.0, "sizeMm": 7},
    {"id": "BR", "x": 196.0, "y": 283.0, "sizeMm": 5},
]


def _rotate_bound(img: np.ndarray, angle_deg: float) -> Tuple[np.ndarray, np.ndarray]:
    """Rotate around center with canvas expansion (no corner cropping).
    getRotationMatrix2D convention: positive angle rotates the content
    counter-clockwise on screen (y-down display coords).
    Returns (rotated_img, M) — M maps ORIGINAL image coords → rotated coords
    (needed to carry decoded QR corner points across the rotation)."""
    h, w = img.shape[:2]
    center = (w / 2.0, h / 2.0)
    M = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
    cos_v, sin_v = abs(M[0, 0]), abs(M[0, 1])
    nw = int(h * sin_v + w * cos_v) + 1
    nh = int(h * cos_v + w * sin_v) + 1
    M[0, 2] += nw / 2.0 - center[0]
    M[1, 2] += nh / 2.0 - center[1]
    border = 255 if img.ndim == 2 else (255, 255, 255)
    return cv2.warpAffine(img, M, (nw, nh), flags=cv2.INTER_LINEAR, borderValue=border), M


def _rot90_pts(pts: np.ndarray, k: int, w0: int, h0: int) -> np.ndarray:
    """Map points through np.rot90(m, k=k) (counter-clockwise image rotation).
    (x, y) → k=1: (y, w0-1-x) · k=2: (w0-1-x, h0-1-y) · k=3: (h0-1-y, x)."""
    x, y = pts[:, 0], pts[:, 1]
    if k == 1:
        return np.stack([y, w0 - 1 - x], axis=1)
    if k == 2:
        return np.stack([w0 - 1 - x, h0 - 1 - y], axis=1)
    if k == 3:
        return np.stack([h0 - 1 - y, x], axis=1)
    return pts.copy()


def _orientation_from_markers(
    gray: np.ndarray,
    markers: Optional[List[Tuple[float, float, float]]] = None,
) -> Optional[float]:
    """Rotation cue from the printed markers when the QR is unreadable.
    The BR marker is intentionally the SMALLEST; the vector from the centroid
    of all markers toward the smallest must point down-right (+45° in y-down
    image coords) on an upright page. Returns the exact corrective angle for
    cv2.getRotationMatrix2D, or None when inconclusive."""
    markers = markers if markers is not None else find_corner_markers(gray)
    if not markers or len(markers) != 4:
        return None
    smallest = min(markers, key=lambda m: m[2])
    others = [m for m in markers if m is not smallest]
    cx = sum(m[0] for m in others) / 3.0
    cy = sum(m[1] for m in others) / 3.0
    vx, vy = smallest[0] - cx, smallest[1] - cy
    if math.hypot(vx, vy) < 1e-6:
        return None
    ang = math.degrees(math.atan2(vy, vx))  # y-down: 45° == down-right
    # corrective rotation R such that after rotating by R the vector sits at 45°
    R = ang - 45.0
    R = (R + 180.0) % 360.0 - 180.0
    if abs(R) < 2.0:
        return 0.0
    return R


def try_qr(
    gray: np.ndarray,
    raw_gray: Optional[np.ndarray] = None,
    prefer_crop: bool = False,
) -> Optional[Dict[str, Any]]:
    """Attempt QR decode with several normalizations (degraded phone photos need
    retries: upscale / binarize / raw-illumination variant).
    Returned pts are ALWAYS in the coordinate system of the `gray` input.

    PERF: `prefer_crop=True` tries the top-left quadrant FIRST — on an upright
    page the QR is printed at (24,24)mm, so a 50%x40% crop decodes ~5x faster
    than the full frame. The full frame and other normalizations remain as
    fallbacks, so recall is unchanged (order: cheap → expensive)."""
    candidates: List[Tuple[np.ndarray, float, Tuple[int, int]]] = []

    def add(img: np.ndarray, scale: float, off: Tuple[int, int] = (0, 0)) -> None:
        candidates.append((img, scale, off))

    if prefer_crop:
        h, w = gray.shape[:2]
        ch, cw = int(h * 0.40), int(w * 0.50)
        crop = gray[0:ch, 0:cw]
        add(crop, 1.0, (0, 0))
        if raw_gray is not None:
            add(raw_gray[0:ch, 0:cw], 1.0, (0, 0))
        # modest upscale of the small crop — cheap and rescues soft QRs
        add(cv2.resize(crop, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC), 1.6, (0, 0))
    # downscaled full frame: QR (18mm) stays >100px at 1400px width — decodes
    # reliably at ~2.5x less CPU than the full-res frame
    h, w = gray.shape[:2]
    dscale = min(1.0, 1400.0 / max(h, w))
    if dscale < 1.0:
        add(cv2.resize(gray, (int(w * dscale), int(h * dscale)), interpolation=cv2.INTER_AREA), dscale, (0, 0))
        if raw_gray is not None:
            rh, rw = raw_gray.shape[:2]
            add(cv2.resize(raw_gray, (int(rw * dscale), int(rh * dscale)), interpolation=cv2.INTER_AREA), dscale, (0, 0))
    add(gray, 1.0)
    if raw_gray is not None:
        add(raw_gray, 1.0)
    try:
        binarized = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
        add(binarized, 1.0)
        if raw_gray is not None:
            bin_raw = cv2.threshold(raw_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
            add(bin_raw, 1.0)
    except cv2.error:
        pass
    for cand, scale, (off_x, off_y) in candidates:
        res = _try_qr_once(cand)
        if res:
            pts = res["pts"] / scale if scale != 1.0 else res["pts"]
            res["pts"] = pts + np.array([off_x, off_y], dtype=np.float32)
            return res
    return None


def _try_qr_once(gray: np.ndarray) -> Optional[Dict[str, Any]]:
    try:
        payload, pts, _ = QR_DETECTOR.detectAndDecode(gray)[:3]
    except cv2.error:
        payload, pts = None, None
    if payload and pts is not None:
        parsed = parse_qr_payload(payload, _QR_SECRET)
        if parsed:
            pts = np.array(pts, dtype=np.float32).reshape(-1, 2)
            if len(pts) == 4:
                # IMPORTANT: OpenCV returns corners in the QR code's LOCAL frame order
                # (TL, TR, BR, BL of the printed code) — this order is INVARIANT to image
                # rotation (verified empirically). Do NOT re-sort by image coordinates:
                # that corrupts the mapping for rotated sheets.
                return {"payload": payload, "parsed": parsed, "pts": pts}
    # Fallback: pyzbar (zbar). Decodes at ANY rotation angle where cv2's
    # detector gives up (e.g. 45°-tilted captures) and handles small/soft QRs.
    try:
        from pyzbar.pyzbar import decode as _zbar_decode
        from pyzbar.pyzbar import ZBarSymbol

        for r in _zbar_decode(gray, symbols=[ZBarSymbol.QRCODE]):
            payload = (r.data or b"").decode("utf-8", "ignore")
            parsed = parse_qr_payload(payload, _QR_SECRET)
            if not parsed or r.polygon is None or len(r.polygon) != 4:
                continue
            pts = np.array([(p.x, p.y) for p in r.polygon], dtype=np.float32)
            # zbar polygon order is TL, BL, BR, TR (CCW) — reorder to the
            # cv2 convention TL, TR, BR, BL (symbol-local, rotation-invariant)
            pts = pts[[0, 3, 2, 1]]
            return {"payload": payload, "parsed": parsed, "pts": pts}
    except ImportError:
        pass
    except Exception:  # noqa: BLE001
        pass
    return None


def _match_markers_to_slots(
    markers: List[Tuple[float, float, float]],
) -> List[Tuple[Tuple[float, float, float], str]]:
    """Assign detected marker blobs to canonical slots (TL/TR/BR/BL) using
    normalized positions within the blobs' bounding box + the size cue
    (BR is intentionally smaller). Robust when 3 of 4 markers are visible.
    Spurious small blobs are DROPPED rather than risk a wrong 180° swap."""
    markers = list(markers)

    def assign(ms: List[Tuple[float, float, float]]) -> List[Tuple[Tuple[float, float, float], str]]:
        xs = [m[0] for m in ms]
        ys = [m[1] for m in ms]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        span_x = max(1e-6, max_x - min_x)
        span_y = max(1e-6, max_y - min_y)
        out = []
        for m in ms:
            nx = (m[0] - min_x) / span_x
            ny = (m[1] - min_y) / span_y
            if nx < 0.5 and ny < 0.5:
                slot = "TL"
            elif nx >= 0.5 and ny < 0.5:
                slot = "TR"
            elif nx >= 0.5 and ny >= 0.5:
                slot = "BR"
            else:
                slot = "BL"
            out.append((m, slot))
        return out

    slots = assign(markers)
    if len(markers) == 4:
        by_slot = {s: m for m, s in slots}
        sizes = {s: by_slot[s][2] for s in by_slot}
        smallest = min(sizes, key=sizes.get)
        others = [v for s, v in sizes.items() if s != smallest]
        others_median = float(np.median(others)) if others else 0.0
        if smallest == "TL":
            if others_median > 0 and sizes["TL"] >= 0.68 * others_median:
                # plausible 180° flip: TL holds the 5mm marker (5/7 ≈ 0.71)
                swap = {"TL": "BR", "BR": "TL", "TR": "BL", "BL": "TR"}
                slots = [(m, swap[s]) for m, s in slots]
            else:
                # too small to be a real marker (e.g. QR finder ring) — drop it
                keep = [(m, s) for m, s in slots if s != "TL"]
                slots = assign([m for m, _ in keep])
    return slots


def build_homography(
    gray: np.ndarray,
    template: Optional[Dict[str, Any]],
    px_per_mm: float,
    raw_gray: Optional[np.ndarray] = None,
    manual_markers: Optional[List[List[float]]] = None,
    qr_preknown: Optional[Dict[str, Any]] = None,
    markers_preknown: Optional[List[Tuple[float, float, float]]] = None,
) -> Tuple[Optional[np.ndarray], np.ndarray, Dict[str, Any]]:
    """Estimate image→canonical-page homography from markers and/or QR corners.
    Returns (H, page_size_px, diag). Strategies (best first):
      manual(4 user-clicked) > markers(4) > markers+qr(≥4 pairs) > qr(4 pairs) > quad > fullframe.

    PERF: `qr_preknown` (a try_qr result already computed on THIS image, e.g.
    by the pre-rotation step) skips the redundant full-frame QR decode."""
    page = (template or {}).get("page") or A4
    W = int(round(page["widthMm"] * px_per_mm))
    Hpx = int(round(page["heightMm"] * px_per_mm))
    diag: Dict[str, Any] = {"perspectiveApplied": False, "strategy": None, "warnings": []}
    tmarks = {m["id"]: m for m in ((template or {}).get("markers") or CANONICAL_MARKERS)}

    def dst_marker(slot: str) -> Tuple[float, float]:
        m = tmarks[slot]
        return (m["x"] * px_per_mm, m["y"] * px_per_mm)

    # ---- Manual fallback (port of the legacy 4-corner tap calibration) ----
    # The user clicked the printed TL,TR,BR,BL markers on the photo in order;
    # trust those points exactly — NO auto pre-rotation/orientation is applied
    # because the user's clicks define the upright frame.
    if manual_markers and template is not None and len(manual_markers) == 4:
        src_pts = [[float(p[0]), float(p[1])] for p in manual_markers]
        dst_pts = [list(dst_marker(slot)) for slot in ("TL", "TR", "BR", "BL")]
        src_arr = np.array(src_pts, dtype=np.float32)
        dst_arr = np.array(dst_pts, dtype=np.float32)
        M, _ = cv2.findHomography(src_arr, dst_arr, 0)
        diag["perspectiveApplied"] = True
        diag["strategy"] = "manual"
        diag["markersFound"] = 4
        diag["manualMarkers"] = True
        diag["qrRawDecoded"] = False
        return M, np.array([W, Hpx]), diag

    markers = markers_preknown if markers_preknown is not None else find_corner_markers(gray)
    diag["markersFound"] = len(markers or [])
    if qr_preknown is not None:
        # reuse the pre-rotation decode result (identical coordinate frame)
        qr = qr_preknown if qr_preknown.get("parsed") else None
        diag["qrRawDecoded"] = bool(qr)
        diag["qrRawParsed"] = qr["parsed"] if qr else None
    else:
        qr = try_qr(gray, raw_gray)
        if qr:
            diag["qrRawDecoded"] = True
            diag["qrRawParsed"] = qr["parsed"]
        else:
            diag["qrRawDecoded"] = False

    src_pts: List[List[float]] = []
    dst_pts: List[List[float]] = []
    strategy = None

    if markers and len(markers) >= 3:
        slots = _match_markers_to_slots(list(markers))
        if len(markers) == 3:
            diag["warnings"].append("one corner marker missing/occluded — using markers+QR alignment")
        for m, slot in slots:
            src_pts.append([m[0], m[1]])
            dx, dy = dst_marker(slot)
            dst_pts.append([dx, dy])
        if qr and qr.get("parsed") and len(markers) == 3:
            # 3-marker rescue: the QR corners provide the missing 4th+
            # correspondences. IMPORTANT: NEVER add them with 4 markers —
            # OpenCV's QR corner ORDER is orientation-dependent (verified:
            # a 90°-rotated sheet decoded with image-axes ordering instead
            # of the code's local TL,TR,BR,BL), so with 4 precise printed
            # markers they only POLLUTE the least-squares homography.
            qx, qy = (template or {}).get("qr", {}).get("x", 24.0), (template or {}).get("qr", {}).get("y", 24.0)
            qsize = (template or {}).get("qr", {}).get("sizeMm", 18.0)
            for px, py in qr["pts"]:
                src_pts.append([float(px), float(py)])
            dst_pts.extend(
                [
                    [qx * px_per_mm, qy * px_per_mm],
                    [(qx + qsize) * px_per_mm, qy * px_per_mm],
                    [(qx + qsize) * px_per_mm, (qy + qsize) * px_per_mm],
                    [qx * px_per_mm, (qy + qsize) * px_per_mm],
                ]
            )
        strategy = "markers" if len(markers) == 4 else "markers+qr"
    elif qr and qr.get("parsed"):
        qx, qy = (template or {}).get("qr", {}).get("x", 24.0), (template or {}).get("qr", {}).get("y", 24.0)
        qsize = (template or {}).get("qr", {}).get("sizeMm", 18.0)
        for px, py in qr["pts"]:
            src_pts.append([float(px), float(py)])
        dst_pts.extend(
            [
                [qx * px_per_mm, qy * px_per_mm],
                [(qx + qsize) * px_per_mm, qy * px_per_mm],
                [(qx + qsize) * px_per_mm, (qy + qsize) * px_per_mm],
                [qx * px_per_mm, (qy + qsize) * px_per_mm],
            ]
        )
        strategy = "qr"
        diag["warnings"].append("fewer than 3 corner markers found — aligned by QR only")

    M = None
    if len(src_pts) >= 4:
        src_arr = np.array(src_pts, dtype=np.float32)
        dst_arr = np.array(dst_pts, dtype=np.float32)
        M, _ = cv2.findHomography(src_arr, dst_arr, 0)
        diag["perspectiveApplied"] = True
    elif len(src_pts) == 3:
        src_arr = np.array(src_pts, dtype=np.float32)
        dst_arr = np.array(dst_pts, dtype=np.float32)
        M = cv2.getAffineTransform(src_arr, dst_arr)
        strategy = (strategy or "markers") + "~affine"
        diag["perspectiveApplied"] = True
        diag["warnings"].append("affine-only alignment (3 correspondences)")

    if M is None:
        quad = detect_document_quad(gray)
        if quad is not None:
            strategy = "quad"
            src = quad.astype(np.float32)
            dst = np.array([[0, 0], [W - 1, 0], [W - 1, Hpx - 1], [0, Hpx - 1]], dtype=np.float32)
            M = cv2.getPerspectiveTransform(src, dst)
            diag["perspectiveApplied"] = True
        else:
            strategy = "fullframe"
            diag["perspectiveApplied"] = False

    diag["strategy"] = strategy
    return M, np.array([W, Hpx]), diag


def warp_with(
    gray: np.ndarray, M: np.ndarray, size_px: np.ndarray
) -> np.ndarray:
    W, Hpx = int(size_px[0]), int(size_px[1])
    return cv2.warpPerspective(gray, M, (W, Hpx), flags=cv2.INTER_LINEAR, borderValue=255)


def refine_homography(
    warped: np.ndarray,
    template: Optional[Dict[str, Any]],
    px_per_mm: float,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Second pass: verify alignment inside the warped page and self-heal.
    PERF: re-detects each printed marker LOCALLY (crop windows around the
    canonical slots) instead of re-running the full marker+QR detection over
    the whole page (~5x cheaper, no redundant QR decode). When the local
    windows cannot produce 4 correspondences, falls back to the full
    build_homography so recall never drops."""
    diag: Dict[str, Any] = {"refined": False}
    page = (template or {}).get("page") or A4
    tmarks = {m["id"]: m for m in ((template or {}).get("markers") or CANONICAL_MARKERS)}
    src_pts: List[List[float]] = []
    dst_pts: List[List[float]] = []
    H, W = warped.shape[:2]
    for slot in ("TL", "TR", "BR", "BL"):
        m = tmarks.get(slot)
        if not m:
            continue
        ecx, ecy = float(m["x"]) * px_per_mm, float(m["y"]) * px_per_mm
        r = int(9.0 * px_per_mm)  # ±9mm window covers 7mm markers + drift
        x0, x1 = max(0, int(ecx - r)), min(W, int(ecx + r))
        y0, y1 = max(0, int(ecy - r)), min(H, int(ecy + r))
        crop = warped[y0:y1, x0:x1]
        if crop.size == 0:
            continue
        thr = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
        contours = _find_contours(thr, cv2.RETR_EXTERNAL)
        best_c, best_area = None, 0.0
        for c in contours:
            a = cv2.contourArea(c)
            # plausible printed marker: 3.5..9.5mm square (excludes QR finder
            # rings ~1.5mm and any stray marks)
            if a < (3.5 * px_per_mm) ** 2 * 0.6 or a > (9.5 * px_per_mm) ** 2:
                continue
            if a > best_area:
                best_c, best_area = c, a
        if best_c is None:
            continue
        mz = cv2.moments(best_c)
        if mz["m00"] <= 0:
            continue
        src_pts.append([mz["m10"] / mz["m00"] + x0, mz["m01"] / mz["m00"] + y0])
        dst_pts.append([ecx, ecy])

    if len(src_pts) < 4:
        # rare: local windows failed (heavy occlusion/drift) — full fallback
        M2, _size2, _ = build_homography(warped, template, px_per_mm)
        if M2 is None:
            return np.eye(3), diag
        h, w = warped.shape[:2]
        corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32).reshape(-1, 1, 2)
        proj = cv2.perspectiveTransform(corners, M2).reshape(-1, 2)
        ideal = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
        dev = float(np.max(np.linalg.norm(proj - ideal, axis=1)))
        diag["refineDeviationPx"] = round(dev, 1)
        if dev > 6:
            diag["refined"] = True
            return M2, diag
        return np.eye(3), diag

    devs = [math.hypot(s[0] - d[0], s[1] - d[1]) for s, d in zip(src_pts, dst_pts)]
    med_dev = float(np.median(devs))
    diag["refineDeviationPx"] = round(med_dev, 1)
    if med_dev > 4.0:
        M2, _ = cv2.findHomography(
            np.array(src_pts, dtype=np.float32), np.array(dst_pts, dtype=np.float32), 0
        )
        if M2 is not None:
            diag["refined"] = True
            return M2, diag
    return np.eye(3), diag


# ---------------- Stage 5: orientation correction ----------------

def _marker_sizes_at_slots(warped: np.ndarray, px_per_mm: float) -> Dict[str, float]:
    """Measure the dark square size (mm) near each canonical marker slot on a
    warped page. Deterministic orientation cue: BR is printed 5mm, others 7mm."""
    sizes: Dict[str, float] = {}
    for m in CANONICAL_MARKERS:
        cx, cy = int(m["x"] * px_per_mm), int(m["y"] * px_per_mm)
        r = int(6.5 * px_per_mm)  # 13mm window covers both 5mm and 7mm markers
        x0, x1 = max(0, cx - r), min(warped.shape[1], cx + r)
        y0, y1 = max(0, cy - r), min(warped.shape[0], cy + r)
        crop = warped[y0:y1, x0:x1]
        if crop.size == 0:
            sizes[m["id"]] = 0.0
            continue
        thr = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
        contours = _find_contours(thr, cv2.RETR_EXTERNAL)
        best = 0.0
        for c in contours:
            a = cv2.contourArea(c)
            if a > best:
                best = a
        sizes[m["id"]] = (best ** 0.5) / px_per_mm if best > 0 else 0.0
    return sizes


def fix_orientation(
    warped: np.ndarray,
    template: Optional[Dict[str, Any]],
    px_per_mm: float,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Fix page rotation (0/90/180/270). Primary cue: QR position (the QR is
    always top-left on the sheet). Fallback: printed marker sizes (BR is 5mm,
    others 7mm) counting only slots where a plausible marker (≥4mm) is present."""
    diag: Dict[str, Any] = {"rotationDeg": 0, "qrDecoded": False, "qrPayload": None, "qrParsed": None, "warnings": []}
    W_mm = (template or {}).get("page", A4)["widthMm"]
    H_mm = (template or {}).get("page", A4)["heightMm"]

    # --- primary: QR position cue (crop-first: the QR is printed top-left) ---
    qr = try_qr(warped, prefer_crop=True)
    if qr and qr.get("parsed"):
        diag["qrDecoded"] = True
        diag["qrPayload"] = qr["payload"]
        diag["qrParsed"] = qr["parsed"]
        cx_mm = float(np.mean(qr["pts"][:, 0])) / px_per_mm
        cy_mm = float(np.mean(qr["pts"][:, 1])) / px_per_mm
        if cx_mm < W_mm / 2 and cy_mm < H_mm / 2:
            k = 0
        elif cx_mm >= W_mm / 2 and cy_mm < H_mm / 2:
            k = 1
        elif cx_mm >= W_mm / 2 and cy_mm >= H_mm / 2:
            k = 2
        else:
            k = 3
        if k:
            diag["rotationDeg"] = k * 90
            diag["warnings"].append(f"rotated {k*90}° (QR-position cue) — corrected")
            warped = np.rot90(warped, k=k).copy()
            qr2 = try_qr(warped, prefer_crop=True)
            if qr2 and qr2.get("parsed"):
                diag["qrPayload"] = qr2["payload"]
                diag["qrParsed"] = qr2["parsed"]
        return warped, diag

    # --- fallback: marker sizes at canonical slots (presence ≥ 4mm) ---
    sizes = _marker_sizes_at_slots(warped, px_per_mm)
    diag["markerSizesMm"] = {k: round(v, 1) for k, v in sizes.items()}
    present = {s: v for s, v in sizes.items() if v >= 4.0}
    if len(present) >= 3:
        smallest = min(present, key=present.get)
        k = {"BR": 0, "BL": 1, "TL": 2, "TR": 3}[smallest]
        if k:
            diag["rotationDeg"] = k * 90
            diag["warnings"].append(f"rotated {k*90}° (marker-size cue) — corrected")
            warped = np.rot90(warped, k=k).copy()
            sizes2 = _marker_sizes_at_slots(warped, px_per_mm)
            diag["markerSizesAfterMm"] = {kk: round(v, 1) for kk, v in sizes2.items()}
        qr2 = try_qr(warped, prefer_crop=True)
        if qr2 and qr2.get("parsed"):
            diag["qrDecoded"] = True
            diag["qrPayload"] = qr2["payload"]
            diag["qrParsed"] = qr2["parsed"]
        return warped, diag

    diag["warnings"].append("QR unreadable and marker check inconclusive — assuming upright")
    return warped, diag


# ---------------- PDF input (pymupdf) ----------------

def pdf_pages(pdf_b64: str, dpi: int = 200, from_page: int = 0, max_pages: int = 30, quality: int = 85) -> Dict[str, Any]:
    """Rasterize PDF pages → JPEG base64 list. Used by /pdf_pages and /process.
    200dpi keeps a 2mm bubble at ~16px radius (ample for fill analysis) and
    bounds memory/CPU for 100-page batch uploads."""
    try:
        import fitz  # pymupdf
    except ImportError as e:
        raise ValueError(f"pymupdf not installed: {e}")
    if not pdf_b64 or not isinstance(pdf_b64, str):
        raise ValueError("pdfBase64 is required")
    if "," in pdf_b64 and pdf_b64.strip().startswith("data:"):
        pdf_b64 = pdf_b64.split(",", 1)[1]
    try:
        buf = base64.b64decode(pdf_b64, validate=False)
    except Exception as e:
        raise ValueError(f"invalid base64 pdf: {e}")
    if len(buf) < 8 or not buf.startswith(b"%PDF"):
        raise ValueError("not a PDF file (missing %PDF header)")
    try:
        doc = fitz.open(stream=buf, filetype="pdf")
    except Exception as e:
        raise ValueError(f"could not open pdf: {e}")
    # Encrypted/password-protected PDFs fail later with a confusing crypt
    # error — reject them here with an explicit, actionable message.
    if getattr(doc, "needs_pass", False) or getattr(doc, "is_encrypted", False):
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass
        raise ValueError("pdf is encrypted or password-protected — remove the password before uploading")
    total = int(doc.page_count)
    if total <= 0:
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass
        raise ValueError("pdf contains no pages")
    dpi = max(72, min(300, int(dpi)))
    zoom = dpi / 72.0
    pages: List[str] = []
    start = max(0, int(from_page))
    end = min(total, start + max(1, int(max_pages)))
    for i in range(start, end):
        pix = doc[i].get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
        elif pix.n == 3:
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        else:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        ok, jbuf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            raise ValueError(f"failed to rasterize page {i}")
        pages.append(base64.b64encode(jbuf.tobytes()).decode())
    doc.close()
    return {"total": total, "fromPage": start, "pages": pages, "truncated": end < total}


# ---------------- Stage 8: bubble fill analysis ----------------
# Normalized mean-darkness measurement (aligned with the strongest open
# implementations: OMRChecker mean-intensity + largest-gap thresholding,
# open-mcr inward-cropped circular masks, Loke 2018 background-context
# marks). For every template bubble:
#
#   bg      = median gray of an annulus r*1.15..r*1.45 (local paper level)
#   mean_in = mean gray inside disc r*0.82 (inward of the printed ring)
#   ratio   = (bg - mean_in) / max(bg - ink_ref, 60)   clipped to 0..1.15
#
# ink_ref is a per-sheet blackness estimate (15th percentile of Otsu-dark
# pixels, clamped 35..60). Because the metric is RELATIVE to the paper
# level around each bubble, it is insensitive to illumination gradients,
# shadows, low-light shots, gray photocopies and JPEG exposure shifts —
# the failure modes of binary dark-pixel counting. Physical calibration:
# empty ~0.02-0.10, light pencil ~0.25-0.35, HB pencil ~0.45-0.70,
# black pen ~0.80-1.00, erased ghost ~0.04-0.10.

CROP_PAD_MM = 2.2          # crop half-width beyond the annulus (mm)
MASK_FACTOR = 0.82         # measurement disc radius = r * MASK_FACTOR
ANN_IN, ANN_OUT = 1.15, 1.45  # local paper reference annulus (multiples of r)
INK_REF_MIN, INK_REF_MAX = 35.0, 160.0  # upper bound lets faint photocopies keep scale
EMPTY_FLOOR = 0.20         # metric-consistent minimum for the `empty` threshold


def estimate_ink_ref(warped: np.ndarray) -> float:
    """Per-sheet ink blackness estimate (gray level of true print)."""
    small = cv2.resize(warped, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    t, _ = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    dark = small[small < t]
    if dark.size > 500:
        return float(np.clip(np.percentile(dark, 15), INK_REF_MIN, INK_REF_MAX))
    return 45.0


def bubble_fill_ratios(
    warped: np.ndarray,
    bubbles_mm: List[Tuple[float, float, float]],  # (x, y, r) mm
    px_per_mm: float,
    ink_ref: Optional[float] = None,
) -> List[Tuple[float, float, float]]:
    """Normalized fill measurement. Returns [(fillRatio, meanIntensity, strokeCover)].

    strokeCover = fraction of the disc at least 35% as dark as ink vs local
    paper — near-zero for broad faint fills (eraser ghosts), meaningful for
    thin intentional strokes (cross-outs, ticks) that dilute in mean
    darkness. Used by decide_answer to rescue such marks into review.

    PERF: bubbles sharing a radius share the crop geometry, so crops are
    stacked per radius group and measured vectorized (one np.mgrid per
    group instead of per bubble)."""
    n = len(bubbles_mm)
    if n == 0:
        return []
    if ink_ref is None:
        ink_ref = estimate_ink_ref(warped)

    WH, WW = warped.shape[:2]
    by_r: Dict[float, List[int]] = {}
    for i, (xmm, ymm, rmm) in enumerate(bubbles_mm):
        by_r.setdefault(round(float(rmm), 3), []).append(i)

    r_max_mm = max(rmm for _, _, rmm in bubbles_mm)
    pad = max(3, int(math.ceil(CROP_PAD_MM + ANN_OUT * r_max_mm) * px_per_mm))
    work = cv2.copyMakeBorder(warped, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)

    out: List[Optional[Tuple[float, float]]] = [None] * n
    for r_mm, idxs in by_r.items():
        r_px = r_mm * px_per_mm
        half = int(math.ceil(ANN_OUT * r_px)) + 2
        size = 2 * half + 1
        stack = np.empty((len(idxs), size, size), dtype=np.float32)
        for row, i in enumerate(idxs):
            xmm, ymm, _ = bubbles_mm[i]
            cx = int(round(xmm * px_per_mm)) + pad
            cy = int(round(ymm * px_per_mm)) + pad
            crop = work[max(0, cy - half) : min(WH + 2 * pad, cy + half + 1),
                        max(0, cx - half) : min(WW + 2 * pad, cx + half + 1)]
            if crop.shape != (size, size):
                # bubble near/over the page edge (deformed warp) — pad the
                # missing border with paper white instead of crashing
                crop = cv2.copyMakeBorder(
                    crop,
                    max(0, half - (cy - max(0, cy - half))),
                    max(0, (cy + half + 1) - min(WH + 2 * pad, cy + half + 1)),
                    max(0, half - (cx - max(0, cx - half))),
                    max(0, (cx + half + 1) - min(WW + 2 * pad, cx + half + 1)),
                    cv2.BORDER_CONSTANT, value=255,
                )
                if crop.shape != (size, size):
                    # still clipped (bubble center beyond the padded edge):
                    # treat as clean paper so the vectorized pass stays sane
                    stack[row] = 255.0
                    continue
            stack[row] = crop

        yy, xx = np.mgrid[-half : half + 1, -half : half + 1]
        dist = np.sqrt((xx * xx + yy * yy).astype(np.float32))
        inner = (dist <= MASK_FACTOR * r_px).astype(np.float32)
        ann = (dist >= ANN_IN * r_px) & (dist <= ANN_OUT * r_px)
        inner_sum = float(inner.sum())

        if ann.any():
            masked = np.where(ann[None, :, :], stack, np.nan)
            with np.errstate(all="ignore"):
                bg = np.nanmedian(masked.reshape(len(idxs), -1), axis=1)
            bg = np.nan_to_num(bg, nan=255.0)
        else:
            bg = np.full(len(idxs), 255.0)
        bg = np.clip(bg, 40.0, 255.0)

        mean_in = (stack * inner[None, :, :]).sum(axis=(1, 2)) / max(inner_sum, 1.0)
        denom = np.maximum(bg - ink_ref, 60.0)
        ratio = np.clip((bg - mean_in) / denom, 0.0, 1.15)
        stroke_t = (bg - 0.35 * (bg - ink_ref))[:, None, None]
        cover = ((stack < stroke_t) * inner[None, :, :]).sum(axis=(1, 2)) / max(inner_sum, 1.0)

        for row, i in enumerate(idxs):
            out[i] = (float(ratio[row]), float(mean_in[row]), float(min(1.0, cover[row])))

    return [(o if o is not None else (0.0, 255.0, 0.0)) for o in out]


def calibrate_thresholds(
    all_ratios: List[float], th: Dict[str, float]
) -> Tuple[Dict[str, float], Optional[Dict[str, Any]]]:
    """Page-adaptive threshold calibration (OMRChecker largest-gap method).

    The template/request thresholds remain the fallback rails. When the
    page's bubble ratios are clearly bimodal (paper cluster vs ink cluster)
    we place empty/filled INSIDE the largest separating gap, preferring a
    gap whose low side looks like paper (p95 <= 0.20) and whose high side
    looks like ink (>= 0.30). This rescues faint photocopies, light pens
    and varying exposures that absolute
    thresholds misread — while degenerate sheets (blank, fully-marked,
    smeared) naturally fail the gap test and keep the base thresholds."""
    vals = np.sort(np.asarray(all_ratios, dtype=np.float64))
    n = int(vals.size)
    if n < 20:
        return th, None
    min_left = max(4, int(n * 0.15))
    min_right = max(1, int(n * 0.05))
    candidates = []
    for i in range(min_left, n - min_right):
        gap = float(vals[i + 1] - vals[i])
        if gap >= 0.09:
            # p95 of the LOW cluster (vals[0..i]). NOTE: the previous formula
            # vals[int(i*0.95)-1] evaluated the percentile at the wrong index
            # (~i itself, not (i+1)*0.95) — for a gap sitting between a small
            # faint-mark cluster and the pen cluster it returned the LAST PAPER
            # value, so an ink cluster passed the paper test and `filled` was
            # calibrated ABOVE faint-but-real marks (they all read "unclear").
            low_p95 = float(vals[max(0, int((i + 1) * 0.95) - 1)])
            candidates.append((i, gap, low_p95))
    if not candidates:
        return th, None
    # The low cluster must look like paper (p95 <= 0.20) and the high side
    # must look like real ink (>= 0.30 in the normalized metric — even light
    # photocopy marks measure >= 0.30). This rejects noise "gaps" inside
    # uniform populations (blank sheets, erased ghosts, smeared pages).
    paper_like = [c for c in candidates if c[2] <= 0.20 and float(vals[c[0] + 1]) >= 0.30]
    # Fallback: relax the paper test but NEVER accept a gap whose low side is
    # itself ink (>= 0.35) — a pencil cluster (~0.5-0.7) mistaken for paper
    # pushes `filled` ABOVE real pencil marks and turns them into "unclear".
    # The relaxed bound still covers heavy photocopies where paper measures
    # up to ~0.30 in the normalized metric.
    relaxed = [
        c for c in candidates
        if 0.20 < c[2] <= 0.32 and float(vals[c[0] + 1]) >= 0.38
    ]
    pool = paper_like if paper_like else relaxed
    if not pool:
        return th, None
    i, gap, _ = max(pool, key=lambda c: (c[1], c[0]))
    low_v, high_v = float(vals[i]), float(vals[i + 1])
    filled_t = float(np.clip(low_v + 0.72 * gap, 0.28, 0.70))
    empty_t = float(np.clip(low_v + 0.28 * gap, 0.06, 0.30))
    if filled_t - empty_t < 0.10:
        return th, None
    new_th = dict(th)
    new_th["filled"] = round(filled_t, 3)
    new_th["empty"] = round(empty_t, 3)
    info = {
        "applied": True,
        "gap": round(gap, 3),
        "paperLevel": round(low_v, 3),
        "inkLevel": round(high_v, 3),
        "filled": new_th["filled"],
        "empty": new_th["empty"],
    }
    return new_th, info


def decide_answer(
    ratios: Dict[str, float],
    th: Dict[str, float],
    covers: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """Answer determination with calibrated thresholds.
    States: selected / unanswered / multiple / unclear — never force ambiguity.

    Rules (in order):
    1. top1 < empty -> unanswered, UNLESS a thin intentional stroke is
       present (stroke-cover high while mean darkness is low — cross-outs,
       ticks): then unclear for human review instead of a silent blank.
    2. top1 & top2 both >= filled           -> multiple
    3. near-tie at the top (top2 within
       ambiguousMargin of filled and top1
       within ambiguousMargin of top2)      -> unclear (human review)
    4. top1 straddles the filled threshold
       (±borderZone)                        -> unclear (human review)
    5. top1 >= filled                      -> selected, confidence from
       the margin over the runner-up."""
    filled = th["filled"]
    empty = th["empty"]
    min_abs = th.get("minAbsoluteFill", 0.08)
    amb = float(th.get("ambiguousMargin", 0.10))
    border = float(th.get("borderZone", 0.02))
    items = sorted(ratios.items(), key=lambda kv: -kv[1])
    top1_letter, top1 = items[0]
    top2 = items[1][1] if len(items) > 1 else 0.0
    margin = top1 - top2

    if top1 < empty:
        cov = covers or {}
        cov1 = float(cov.get(top1_letter, 0.0))
        cov2 = float(cov.get(items[1][0], 0.0)) if len(items) > 1 else 0.0
        stroke1 = cov1 >= 0.12 and top1 >= 0.045
        stroke2 = cov2 >= 0.12 and top2 >= 0.045
        # A genuine thin mark stands out from the row BOTH in mean darkness
        # and in stroke coverage. Warp misalignment leaves ring fragments on
        # EVERY bubble (similar cover, near-tie ratios) — that noise must
        # stay unanswered, not flood the review queue.
        if stroke1 and (stroke2 or (margin >= 0.03 and cov1 - cov2 >= 0.06)):
            # thin intentional mark below the fill threshold — send to review
            return {"detected": None, "status": "unclear", "confidence": 0.3}
        return {"detected": None, "status": "unanswered", "confidence": round(max(0.0, min(1.0, 1.0 - top1 / max(empty, 1e-6))), 3)}
    if top1 >= filled and top2 >= filled:
        return {"detected": None, "status": "multiple", "confidence": round(max(0.5, min(1.0, 0.5 + margin / 0.4)), 3)}
    if top1 >= filled and margin < amb and top2 >= filled - amb:
        # near-tie single mark — genuinely ambiguous, never force a letter
        return {"detected": None, "status": "unclear", "confidence": round(float(np.clip(0.5 - margin / max(amb, 1e-6) * 0.25, 0.25, 0.5)), 3)}
    if abs(top1 - filled) <= border:
        return {"detected": None, "status": "unclear", "confidence": 0.35}
    if top1 >= filled:
        if top1 < min_abs:
            return {"detected": None, "status": "unclear", "confidence": 0.3}
        conf = 0.5 + 0.5 * min(1.0, margin / 0.30)
        return {"detected": top1_letter, "status": "selected", "confidence": round(max(0.5, min(1.0, conf)), 3)}
    # empty <= top1 < filled
    span = max(1e-6, filled - empty)
    conf = min(0.5, (top1 - empty) / span * 0.5)
    return {"detected": None, "status": "unclear", "confidence": round(conf, 3)}


# ---------------- Student ID ----------------

def analyze_student_id(
    warped: np.ndarray,
    sid: Optional[Dict[str, Any]],
    th: Dict[str, float],
    px_per_mm: float,
    ink_ref: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    if not sid:
        return None
    bubbles: List[Tuple[float, float, float]] = []
    for x in sid["digitColumnXs"]:
        for y in sid["valueYs"]:
            bubbles.append((x, y, sid["bubbleRMm"]))
    ratios = bubble_fill_ratios(warped, bubbles, px_per_mm, ink_ref)
    per_digit = []
    digits = ""
    confs = []
    for d, x in enumerate(sid["digitColumnXs"]):
        col = {}
        cov_col = {}
        for v, y in enumerate(sid["valueYs"]):
            col[str(v)] = ratios[d * len(sid["valueYs"]) + v][0]
            cov_col[str(v)] = ratios[d * len(sid["valueYs"]) + v][2]
        dec = decide_answer(col, th, cov_col)
        status = dec["status"]
        if status == "unanswered":
            value = ""  # nothing marked in this column
        elif status in ("multiple", "unclear"):
            value = "?"
        else:
            value = str(dec["detected"])
        per_digit.append({"position": d + 1, "value": value if value != "" else None, "status": status, "ratios": {k: round(v2, 4) for k, v2 in col.items()}, "confidence": dec["confidence"]})
        digits += value
        confs.append(dec["confidence"])
    return {"digits": digits, "perDigit": per_digit, "confidence": round(float(np.mean(confs)) if confs else 0.0, 3)}


# ---------------- Exam version question (سؤال النسخة) ----------------

def analyze_version(
    warped: np.ndarray,
    vm: Optional[Dict[str, Any]],
    th: Dict[str, float],
    px_per_mm: float,
    ink_ref: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """Decode the version bubble row (main sheet). Bubble index i (in the
    template's PRINTED xsMm order) maps to version i+1 — the builder keeps
    that mapping for both RTL and LTR sheets."""
    if not vm:
        return None
    xs = vm.get("xsMm") or []
    if not xs:
        return None
    r_mm = float(vm.get("bubbleRMm", 2.0))
    y_mm = float(vm.get("yMm"))
    bubbles = [(float(x), y_mm, r_mm) for x in xs]
    ratios = bubble_fill_ratios(warped, bubbles, px_per_mm, ink_ref)
    col = {str(i + 1): ratios[i][0] for i in range(len(xs))}
    cov_col = {str(i + 1): ratios[i][2] for i in range(len(xs))}
    dec = decide_answer(col, th, cov_col)
    status = dec["status"]
    if status == "selected" and dec["detected"] is not None:
        value: Optional[int] = int(dec["detected"])
    else:
        value = None
    return {
        "value": value,
        "status": status,
        "confidence": dec["confidence"],
        "ratios": {k: round(v, 4) for k, v in col.items()},
    }


# ---------------- Grading ----------------

def grade_answers(answers: List[Dict[str, Any]], answer_key: Dict[str, str], marks_map: Optional[Dict[str, float]], marks_default: float) -> Optional[Dict[str, Any]]:
    if not answer_key:
        return None
    correct, incorrect, ambiguous, unanswered = [], [], [], []
    score, total = 0.0, 0.0
    for a in answers:
        n = str(a["number"])
        if n not in answer_key:
            continue
        m = float((marks_map or {}).get(n, marks_default))
        total += m
        st = a["status"]
        if st in ("multiple", "unclear", "invalid"):
            ambiguous.append(a["number"])
        elif st == "unanswered":
            unanswered.append(a["number"])
        elif a["detected"] == answer_key[n]:
            correct.append(a["number"])
            score += m
        else:
            incorrect.append(a["number"])
    return {
        "score": round(score, 2),
        "total": round(total, 2),
        "correct": correct,
        "incorrect": incorrect,
        "ambiguous": ambiguous,
        "unanswered": unanswered,
        "percent": round(score / total * 100, 1) if total > 0 else 0.0,
    }


# ---------------- Debug image ----------------

def render_debug(warped: np.ndarray, template: Dict[str, Any], sheet_questions: List[Dict[str, Any]], results: List[Dict[str, Any]], th: Dict[str, float], max_w: int = 1100) -> str:
    vis = cv2.cvtColor(warped, cv2.COLOR_GRAY2BGR)
    px = warped.shape[1] / (template.get("page") or A4)["widthMm"]
    for q in sheet_questions:
        res = next((r for r in results if r["number"] == q["number"]), None)
        for letter, pos in q["options"].items():
            cx, cy = int(pos["x"] * px), int(pos["y"] * px)
            r = int(q["radiusMm"] * px)
            color = (160, 160, 160)
            label = None
            if res:
                ratio = res["ratios"].get(letter, 0.0)
                st = res["status"]
                if st == "selected":
                    color = (0, 170, 0) if letter == res["detected"] else (160, 160, 160)
                elif st == "multiple":
                    color = (0, 0, 220)
                elif st == "unclear":
                    color = (0, 140, 255)
                label = f"{int(round(ratio * 100))}"
            cv2.circle(vis, (cx, cy), r + 2, color, 2, cv2.LINE_AA)
            if label and int(label) >= 8:
                cv2.putText(vis, label, (cx - 10, cy - r - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)
    # markers
    for m in template.get("markers", []):
        cx, cy = int(m["x"] * px), int(m["y"] * px)
        cv2.rectangle(vis, (cx - int(m["sizeMm"] * px / 2) - 3, cy - int(m["sizeMm"] * px / 2) - 3), (cx + int(m["sizeMm"] * px / 2) + 3, cy + int(m["sizeMm"] * px / 2) + 3), (255, 120, 0), 2)
    h, w = vis.shape[:2]
    scale = min(1.0, max_w / w)
    if scale < 1.0:
        vis = cv2.resize(vis, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", vis, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


def render_corrected(warped: np.ndarray, max_w: int = 1200) -> str:
    vis = cv2.cvtColor(warped, cv2.COLOR_GRAY2BGR)
    h, w = vis.shape[:2]
    scale = min(1.0, max_w / w)
    if scale < 1.0:
        vis = cv2.resize(vis, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", vis, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


# ---------------- Orchestration ----------------

def _failure_preview(gray: np.ndarray, max_w: int = 900) -> str:
    """Small JPEG of what the engine actually looked at — attached to a
    detection failure so the user can see the framing/exposure problem."""
    h, w = gray.shape[:2]
    scale = min(1.0, max_w / max(1, w))
    if scale < 1.0:
        gray = cv2.resize(gray, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode('.jpg', gray, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        return ''
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.tobytes()).decode()


def process(payload: Dict[str, Any]) -> Dict[str, Any]:
    t0 = time.time()
    global _QR_SECRET
    _QR_SECRET = payload.get("qrSecret") if isinstance(payload.get("qrSecret"), str) else None
    stages = {
        "imageLoaded": False, "preprocessed": False, "sheetDetected": False,
        "perspectiveCorrected": False, "orientationFixed": False, "templateIdentified": False,
        "bubblesLoaded": False, "answersExtracted": False, "graded": False,
    }
    template = payload.get("template")
    th = dict((template or {}).get("thresholds") or {"filled": 0.45, "empty": 0.17, "ambiguousMargin": 0.10, "minAbsoluteFill": 0.08})
    req_th = payload.get("thresholds")
    if req_th:
        th.update({k: float(v) for k, v in req_th.items() if v is not None})
    # Metric-consistency floor: in the normalized mean-darkness metric paper
    # noise tops out ~0.18 while the lightest real marks start ~0.25 — keep
    # `empty` at least EMPTY_FLOOR so erased ghosts never read as answers.
    th["empty"] = max(float(th.get("empty", 0.17)), EMPTY_FLOOR)
    debug = bool(payload.get("debug", False))
    warnings: List[str] = []
    errors: List[str] = []

    # Manual 4-corner fallback (port of legacy calibration): user-clicked
    # printed marker centers TL,TR,BR,BL in ORIGINAL image pixel coordinates.
    manual_markers: Optional[List[List[float]]] = None
    mm_raw = payload.get("manualMarkers")
    if isinstance(mm_raw, list) and len(mm_raw) == 4:
        ok = True
        pts: List[List[float]] = []
        for p in mm_raw:
            if (isinstance(p, (list, tuple)) and len(p) == 2
                    and all(isinstance(v, (int, float)) and math.isfinite(float(v)) and 0 <= float(v) <= 20000 for v in p)):
                pts.append([float(p[0]), float(p[1])])
            else:
                ok = False
                break
        if ok:
            manual_markers = pts
        else:
            warnings.append("manualMarkers ignored — must be 4 [x,y] pixel points")

    diag: Dict[str, Any] = {"warnings": warnings, "errors": errors, "thresholdsUsed": th, "perspectiveApplied": False, "rotationDeg": 0, "markersFound": 0}

    def fail(stage: str, err: str) -> Dict[str, Any]:
        stages[stage] = False if stage in stages else False
        errors.append(err)
        diag["stages"] = stages
        diag["errors"] = errors
        return {"ok": False, "stage": stage, "error": err, "stages": stages, "diagnostics": diag, "debugImage": _debug_b64 if debug else None}

    _debug_b64 = None
    try:
        raw_b64 = payload.get("imageBase64", "")
        pdf_b64 = payload.get("pdfBase64", "")
        if (not raw_b64 or not isinstance(raw_b64, str)) and pdf_b64:
            # PDF input: rasterize ONE page (pageIndex, default 0) → process.
            page_index = int(payload.get("pageIndex") or 0)
            dpi = int(payload.get("pdfDpi") or 220)
            rendered = pdf_pages(pdf_b64, dpi=dpi, from_page=page_index, max_pages=1)
            if not rendered["pages"]:
                return {"ok": False, "stage": "imageLoaded",
                        "error": f"pageIndex {page_index} out of range (pdf has {rendered['total']} pages)",
                        "stages": stages, "diagnostics": diag}
            raw_b64 = rendered["pages"][0]
            diag["pdfPage"] = page_index
            diag["pdfTotalPages"] = rendered["total"]
        img = load_image_b64(raw_b64)
        stages["imageLoaded"] = True
    except ValueError as e:
        return {"ok": False, "stage": "imageLoaded", "error": str(e), "stages": stages, "diagnostics": diag}

    try:
        gray, raw_gray, pre_info = preprocess(img)
        stages["preprocessed"] = True
        diag["preprocess"] = pre_info
        # surface exposure/blur quality warnings (legacy assessor port)
        for w in pre_info.get("warnings") or []:
            warnings.append(w)
    except Exception as e:  # noqa: BLE001
        return fail("preprocessed", f"preprocessing failed: {e}")

    # ---- Pre-rotation (90° multiples, order-independent cue) ----
    # Primary cue: the QR CENTER QUADRANT relative to the printed-marker
    # centroid. The QR is ALWAYS printed top-left (24,24)mm on the sheet, so
    # its position tells the rotation WITHOUT relying on OpenCV's QR corner
    # ORDER (verified orientation-dependent: a 90°-rotated sheet decoded with
    # image-axes corner ordering, which made the old angle cue misread 90°
    # as 0° and polluted the homography).
    # Residual skew (any angle) is then corrected by the marker homography.
    # Fallbacks: QR-corner angle (only when markers are absent entirely) and
    # printed-marker geometry (BR is the smallest marker). Skipped in manual
    # mode: the user's 4 clicks define the upright frame.
    markers_pre: Optional[List[Tuple[float, float, float]]] = (
        None if manual_markers else find_corner_markers(gray)
    )
    qr_pre = None if manual_markers else try_qr(gray, raw_gray)
    pre_rot = 0.0
    qr_known: Optional[Dict[str, Any]] = None

    def carry_across_rot(k: int, h0: int, w0: int) -> None:
        """Carry the decoded QR pts AND detected marker centers across a
        lossless rot90 so build_homography needs no re-decode/re-detection."""
        nonlocal qr_known, markers_pre
        if qr_pre and qr_pre.get("parsed"):
            qr_known = {
                **qr_pre,
                "pts": _rot90_pts(qr_pre["pts"], k, w0, h0).astype(np.float32),
            }
        if markers_pre:
            carried: List[Tuple[float, float, float]] = []
            for mx, my, msz in markers_pre:
                p = _rot90_pts(np.array([[mx, my]], dtype=np.float32), k, w0, h0)
                carried.append((float(p[0, 0]), float(p[0, 1]), msz))
            markers_pre = carried

    if qr_pre and qr_pre.get("parsed") and markers_pre and len(markers_pre) >= 2:
        mcx = float(np.mean([m[0] for m in markers_pre]))
        mcy = float(np.mean([m[1] for m in markers_pre]))
        qcx = float(np.mean(qr_pre["pts"][:, 0]))
        qcy = float(np.mean(qr_pre["pts"][:, 1]))
        if qcx < mcx and qcy < mcy:
            k = 0
        elif qcx >= mcx and qcy < mcy:
            k = 1
        elif qcx >= mcx and qcy >= mcy:
            k = 2
        else:
            k = 3
        h0, w0 = gray.shape[:2]
        if k:
            gray = np.rot90(gray, k=k).copy()
            if raw_gray is not None:
                raw_gray = np.rot90(raw_gray, k=k).copy()
            diag["preRotationDeg"] = (k * 90) % 360
            carry_across_rot(k, h0, w0)
        elif qr_pre and qr_pre.get("parsed"):
            qr_known = {
                **qr_pre,
                "pts": qr_pre["pts"].astype(np.float32),
            }
    elif qr_pre and qr_pre.get("parsed") and not markers_pre:
        # no markers at all: fall back to the QR corner-angle cue (ordering
        # is unreliable but it is the only rotation evidence available)
        v = qr_pre["pts"][1] - qr_pre["pts"][0]
        ang = math.degrees(math.atan2(float(v[1]), float(v[0])))
        j = int(round(ang / 90.0)) % 4
        h0, w0 = gray.shape[:2]
        if abs(ang - j * 90) <= 2.0:
            pre_rot = float(j * 90)
            if j:
                gray = np.rot90(gray, k=j).copy()
                if raw_gray is not None:
                    raw_gray = np.rot90(raw_gray, k=j).copy()
                diag["preRotationDeg"] = (j * 90) % 360
            qr_known = {
                **qr_pre,
                "pts": _rot90_pts(qr_pre["pts"], j, w0, h0).astype(np.float32),
            }
        else:
            # exact-angle warp (45° and friends)
            gray, Mrot = _rotate_bound(gray, ang)
            if raw_gray is not None:
                raw_gray, _ = _rotate_bound(raw_gray, ang)
            pre_rot = ang
            diag["preRotationDeg"] = round(ang % 360, 1)
            diag["warnings"].append(f"تم تدوير الصورة مسبقًا بمقدار {round(ang, 1)}° (توجيه QR)")
            pts_t = cv2.perspectiveTransform(
                qr_pre["pts"].reshape(-1, 1, 2).astype(np.float32), Mrot
            ).reshape(-1, 2)
            qr_known = {**qr_pre, "pts": pts_t.astype(np.float32)}
    elif not manual_markers and not (qr_pre and qr_pre.get("parsed")):
        # QR unreadable: printed-marker geometry cue (BR is the smallest)
        mrot = _orientation_from_markers(gray, markers_pre)
        if mrot:
            gray, _ = _rotate_bound(gray, mrot)
            if raw_gray is not None:
                raw_gray, _ = _rotate_bound(raw_gray, mrot)
            pre_rot = mrot
            diag["preRotationDeg"] = round(mrot % 360, 1)
            diag["warnings"].append(f"تم تدوير الصورة مسبقًا بمقدار {round(mrot, 1)}° (توجيه العلامات)")
            # markers were detected pre-warp — force re-detection on the
            # rotated frame (positions no longer match)
            markers_pre = None

    # Sheet detection + perspective correction (manual > markers + QR-assisted).
    px_per_mm = 300 / 25.4
    M, size_px, wdiag = build_homography(
        gray, template, px_per_mm, raw_gray=raw_gray, manual_markers=manual_markers,
        qr_preknown=qr_known, markers_preknown=markers_pre,
    )
    diag.update(wdiag)
    if wdiag.get("strategy"):
        diag["strategy"] = wdiag["strategy"]
    diag["markersFound"] = 4 if manual_markers else int(wdiag.get("markersFound") or 0)

    # No alignment cues at all (no markers, no QR, no visible page boundary):
    # fullframe mapping is only trustworthy for PDF input (page == frame
    # exactly) — for photos it produces silently-garbled bubble reads. Fail
    # with an actionable message instead of returning a wrong result.
    if (
        not manual_markers
        and wdiag.get("strategy") == "fullframe"
        and diag.get("pdfPage") is None
    ):
        stages["sheetDetected"] = False
        if debug:
            _debug_b64 = _failure_preview(gray)
        return fail(
            "sheetDetected",
            "لم يتمكن المحرك من تحديد حدود الورقة — تأكد من ظهور الورقة كاملة داخل الكادر (العلامات المرجعية الأربع ورمز QR) وإعادة التصوير بإضاءة جيدة",
        )

    stages["sheetDetected"] = True
    warped = warp_with(gray, M, size_px) if M is not None else cv2.resize(gray, (int(size_px[0]), int(size_px[1])))
    stages["perspectiveCorrected"] = True

    # Aspect guard: a 90°-off quad/marker matching warps the page landscape
    # (or portrait where landscape was expected). If the warped aspect
    # contradicts the template page, rotate losslessly before measurement —
    # else every bubble coordinate would be out of page bounds.
    if template:
        pg = template.get("page") or A4
        pw_mm, ph_mm = float(pg.get("widthMm") or 210), float(pg.get("heightMm") or 297)
        w_h, w_w = warped.shape[:2]
        if (w_w > w_h) != (pw_mm > ph_mm):
            warped = np.rot90(warped).copy()
            diag["aspectRot90"] = True
            warnings.append("تم تدوير الورقة المصححة هندسيًا لتطابق اتجاه القالب")

    if manual_markers:
        # Trust the user's clicks: no self-heal (it would override their exact
        # points) and no orientation guessing — the frame is upright by design.
        diag["warnings"].append("ضبط يدوي للزوايا — تم تجاهل الاكتشاف التلقائي")
    else:
        # Alignment self-heal: re-estimate inside the warped page if it drifted.
        Mref, rdiag = refine_homography(warped, template, px_per_mm)
        if rdiag.get("refined"):
            warped = warp_with(warped, Mref, size_px)
            diag["refine"] = rdiag
            diag["warnings"].append("alignment refined in second pass")

    if manual_markers:
        warped, odiag = warped, {"qrParsed": None, "qrDecoded": False}
    else:
        warped, odiag = fix_orientation(warped, template, px_per_mm)
    diag.update(odiag)
    stages["orientationFixed"] = True

    qr_parsed = odiag.get("qrParsed")
    qr_decoded = bool(odiag.get("qrDecoded"))

    # Template identification
    if template is None:
        # identity from the warped-page QR, or fall back to the raw-image QR
        # (raw decode is sufficient for identification even if the warp drifts)
        parsed_id = qr_parsed
        if parsed_id is None and diag.get("qrRawDecoded"):
            parsed_id = diag.get("qrRawParsed")
        if not parsed_id:
            return fail("templateIdentified", "لم يُمكن قراءة رمز QR من الورقة — أعد التصوير بإضاءة أفضل أو مرّر النسخة يدويًا (QR unreadable; supply the template)")
        stages["templateIdentified"] = True
        diag["stages"] = stages
        corrected_b64 = render_corrected(warped)
        return {
            "ok": True,
            "needsTemplate": True,
            "stages": stages,
            "qr": {"decoded": True, "payload": odiag.get("qrPayload") or diag.get("qrRawPayload"), "parsed": parsed_id},
            "templateSource": "qr",
            "templateId": parsed_id["templateId"],
            "examVersionId": parsed_id["examVersionId"],
            "sheet": parsed_id["sheet"],
            "sheets": parsed_id["sheets"],
            "studentId": None,
            "answers": [],
            "grade": None,
            "diagnostics": diag,
            "correctedImage": corrected_b64,
            "debugImage": None,
        }

    # template provided
    tid = template.get("templateId")
    evid = template.get("examVersionId")
    raw_parsed = diag.get("qrRawParsed") if diag.get("qrRawDecoded") else None
    if qr_decoded and qr_parsed:
        if qr_parsed.get("templateId") != tid or qr_parsed.get("examVersionId") != evid:
            err = (
                f"template mismatch: الورقة تنتمي إلى نسخة أخرى (QR={qr_parsed.get('templateId')} / المتوقع={tid})"
            )
            return fail("templateIdentified", err)
        template_source = "qr"
    elif raw_parsed:
        # warped-page QR failed but the raw-image QR read fine — verify identity
        if raw_parsed.get("templateId") != tid or raw_parsed.get("examVersionId") != evid:
            err = (
                f"template mismatch: الورقة تنتمي إلى نسخة أخرى (QR={raw_parsed.get('templateId')} / المتوقع={tid})"
            )
            return fail("templateIdentified", err)
        template_source = "qr"
        qr_decoded = True
        qr_parsed = raw_parsed
        diag["qrDecoded"] = True
        diag["qrParsed"] = raw_parsed
    else:
        template_source = "manual"
        if not manual_markers:
            warnings.append("QR unreadable — template matched manually")
    diag["templateSource"] = template_source
    diag["templateId"] = tid
    diag["examVersionId"] = evid
    stages["templateIdentified"] = True

    sheet = qr_parsed["sheet"] if qr_parsed else 0
    sheets = qr_parsed["sheets"] if qr_parsed else (template.get("sheets") or 1)
    if manual_markers and sheets > 1:
        warnings.append("الضبط اليدوي يقرأ الورقة الأولى فقط (الورقة 1) — استخدم QR للأوراق الأخرى")
    page_w_mm = (template.get("page") or A4)["widthMm"]
    px_per_mm = warped.shape[1] / page_w_mm

    # Bubbles
    all_q = template.get("questions", [])
    sheet_questions = [q for q in all_q if q.get("sheet", 0) == sheet]
    if not sheet_questions:
        return fail("bubblesLoaded", f"no questions found for sheet {sheet}")
    stages["bubblesLoaded"] = True

    # Question bubbles
    bubbles: List[Tuple[float, float, float]] = []
    idx_map = []  # (question, letter) aligned with bubbles
    for q in sheet_questions:
        for letter, pos in q["options"].items():
            bubbles.append((pos["x"], pos["y"], q["radiusMm"]))
            idx_map.append((q["number"], letter))
    ink_ref = estimate_ink_ref(warped)
    diag["inkRef"] = round(float(ink_ref), 1)
    ratios = bubble_fill_ratios(warped, bubbles, px_per_mm, ink_ref)

    per_q: Dict[int, Dict[str, float]] = {}
    per_cov: Dict[int, Dict[str, float]] = {}
    for (num, letter), (r, _mean, cov_v) in zip(idx_map, ratios):
        per_q.setdefault(num, {})[letter] = r
        per_cov.setdefault(num, {})[letter] = cov_v

    # Page-adaptive threshold calibration (largest bimodal gap) — falls back
    # to the template/request rails on degenerate sheets.
    if payload.get("pageCalibration") is not False:
        th, cal = calibrate_thresholds([r for r, _m, _c in ratios], th)
        if cal:
            diag["pageCalibration"] = cal
            warnings.append(
                f"تمت معايرة العتبات تلقائيًا لهذه الورقة (filled={cal['filled']}, empty={cal['empty']})"
            )
    diag["thresholdsUsed"] = th

    answers = []
    confs = []
    for num in sorted(per_q.keys()):
        dec = decide_answer(per_q[num], th, per_cov.get(num))
        answers.append({
            "number": num,
            "ratios": {k: round(v, 4) for k, v in per_q[num].items()},
            "detected": dec["detected"],
            "status": dec["status"],
            "confidence": dec["confidence"],
        })
        if dec["status"] in ("selected", "multiple", "unclear"):
            confs.append(dec["confidence"])

    # Global sanity
    all_ratios = [r for r, _m, _c in ratios]
    median_fill = float(np.median(all_ratios)) if all_ratios else 0.0
    p95 = float(np.percentile(all_ratios, 95)) if all_ratios else 0.0
    diag["fillStats"] = {"medianEmpty": round(median_fill, 4), "p95Empty": round(p95, 4)}
    if median_fill > 0.45:
        warnings.append("الورقة تبدو موسخة أو معكوسة (median fill high)")
    if median_fill > 0.7:
        for a in answers:
            a["status"] = "invalid"
            a["detected"] = None
    stages["answersExtracted"] = True

    # Student ID (sheet 0 only)
    student_id = None
    version = None
    if sheet == 0:
        student_id = analyze_student_id(warped, template.get("studentId"), th, px_per_mm, ink_ref)
        version = analyze_version(warped, template.get("versionMarks"), th, px_per_mm, ink_ref)

    # Grade
    answer_key = payload.get("answerKey")
    grade = None
    if answer_key:
        sheet_nums = {q["number"] for q in sheet_questions}
        key_sheet = {str(n): v for n, v in answer_key.items() if int(n) in sheet_nums}
        marks_map = payload.get("marksMap")
        grade = grade_answers(answers, key_sheet, marks_map, float(template.get("marksPerQuestion", 1)))
        stages["graded"] = True

    overall_conf = round(float(np.mean(confs)) if confs else 1.0, 3)

    result = {
        "ok": True,
        "needsTemplate": False,
        "stages": stages,
        "qr": {"decoded": qr_decoded, "payload": odiag.get("qrPayload"), "parsed": qr_parsed},
        "templateSource": template_source,
        "templateId": tid,
        "examVersionId": evid,
        "sheet": sheet,
        "sheets": sheets,
        "studentId": student_id,
        "version": version,
        "answers": answers,
        "grade": grade,
        "diagnostics": diag,
        "correctedImage": None,
        "debugImage": None,
        "processingMs": int((time.time() - t0) * 1000),
    }
    if debug:
        result["debugImage"] = render_debug(warped, template, sheet_questions, answers, th)
        result["correctedImage"] = render_corrected(warped)
    diag["stages"] = stages
    return result


def ocr(image_b64: str, lang: str) -> Dict[str, Any]:
    """Delegate to the dedicated engine.ocr module.

    The full implementation (bundled tessdata with Arabic `ara`, mixed
    `ara+eng` passes, TSV word-confidence self-assessment) lives in
    engine/ocr.py — see that file. Kept as a thin re-export so the
    server import path `from engine.pipeline import ocr` stays stable.
    """
    from engine.ocr import ocr as _tesseract_ocr

    return _tesseract_ocr(image_b64, lang)
