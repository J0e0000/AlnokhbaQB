"""Canonical OMRTemplate loader/validator (mirror of src/lib/qb/types.ts).

The engine consumes the exact template JSON produced by the TS builder
(buildOmrTemplate). All geometry is millimeters; pixel mapping is
px = mm * px_per_mm with px_per_mm = corrected_width_px / page.widthMm.
"""
from typing import Any, Dict, List, Optional, Tuple

from .errors import StageError

VALID_MARKER_IDS = ("TL", "TR", "BL", "BR")

# Canonical sheet constants (fixed by src/lib/qb/omr-template.ts OMR_GEOMETRY).
# Used when no template is provided yet (QR-only first pass).
CANONICAL_PAGE_MM = (210.0, 297.0)
CANONICAL_MARKERS_MM = (
    ("TL", 14.0, 14.0, 7.0),
    ("TR", 196.0, 14.0, 7.0),
    ("BL", 14.0, 283.0, 7.0),
    ("BR", 196.0, 283.0, 5.0),
)
DEFAULT_REFERENCE_DPI = 300


class OmrTemplate:
    """Validated view over the canonical template JSON dict."""

    def __init__(self, raw: Dict[str, Any]) -> None:
        self.raw = raw
        try:
            page = raw["page"]
            self.page_w_mm = float(page["widthMm"])
            self.page_h_mm = float(page["heightMm"])
            self.template_id = str(raw["templateId"])
            self.exam_version_id = str(raw["examVersionId"])
            self.sheets = int(raw.get("sheets", 1))
            self.marks_per_question = float(raw.get("marksPerQuestion", 1))
            self.reference_dpi = int(raw.get("referenceDpi", DEFAULT_REFERENCE_DPI))
            self.markers: List[Dict[str, Any]] = list(raw["markers"])
            self.questions: List[Dict[str, Any]] = list(raw["questions"])
        except (KeyError, TypeError, ValueError) as exc:
            raise StageError("templateIdentified", f"invalid template JSON: {exc}") from exc
        self._validate()

        thr = raw.get("thresholds") or {}
        self.thresholds: Dict[str, float] = {
            "filled": float(thr.get("filled", 0.45)),
            "empty": float(thr.get("empty", 0.17)),
            "ambiguousMargin": float(thr.get("ambiguousMargin", 0.10)),
            "minAbsoluteFill": float(thr.get("minAbsoluteFill", 0.08)),
        }
        self.student_id: Optional[Dict[str, Any]] = raw.get("studentId") or None

    def _validate(self) -> None:
        if self.page_w_mm <= 10 or self.page_h_mm <= 10:
            raise StageError("templateIdentified", "template page size invalid")
        ids = [str(m.get("id")) for m in self.markers]
        if not all(mid in VALID_MARKER_IDS for mid in ids) or len(ids) < 4:
            # Marker geometry is canonical; fewer than 4 named markers breaks
            # the perspective contract.
            raise StageError("templateIdentified", "template must define TL/TR/BL/BR markers")
        if not self.questions:
            raise StageError("templateIdentified", "template has no questions")
        for q in self.questions:
            opts = q.get("options")
            if not isinstance(opts, dict) or not opts:
                raise StageError(
                    "templateIdentified",
                    f"question {q.get('number')} has no options geometry",
                )

    def corrected_size_px(self) -> Tuple[int, int]:
        """Warp target: page at referenceDpi (300dpi -> 2480x3508 for A4)."""
        ppx = round(self.reference_dpi / 25.4)
        return max(1, round(self.page_w_mm * ppx)), max(1, round(self.page_h_mm * ppx))

    def marker_centers_mm(self) -> List[Tuple[str, float, float, float]]:
        """[(id, x_mm, y_mm, size_mm), ...] in canonical TL,TR,BL,BR order."""
        by_id = {str(m["id"]): m for m in self.markers}
        out = []
        for mid, dx, dy, ds in CANONICAL_MARKERS_MM:
            m = by_id.get(mid)
            if m is not None:
                out.append((mid, float(m["x"]), float(m["y"]), float(m["sizeMm"])))
            else:  # pragma: no cover - validation guarantees presence
                out.append((mid, dx, dy, ds))
        return out

    def questions_for_sheet(self, sheet: int) -> List[Dict[str, Any]]:
        return [q for q in self.questions if int(q.get("sheet", 0)) == sheet]

    def option_letters(self) -> List[str]:
        first = self.questions[0].get("options") or {}
        return list(first.keys())


def coerce_template(raw: Optional[Dict[str, Any]]) -> Optional[OmrTemplate]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise StageError("templateIdentified", "template must be a JSON object")
    return OmrTemplate(raw)
