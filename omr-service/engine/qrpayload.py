"""QR payload codec for Alnokhba QB OMR sheets.

Payload format (must mirror src/lib/qb/omr-template.ts):
    ANQB|1|<examVersionId>|<templateId>|<sheet>|<sheets>|<checksum8>
checksum8 = sha256(f"{examVersionId}|{templateId}|{sheet}").hexdigest()[:8].upper()
"""
import hashlib
from typing import Dict, Optional, Tuple


def checksum(exam_version_id: str, template_id: str, sheet: int) -> str:
    """8-hex checksum binding identity + sheet index."""
    raw = f"{exam_version_id}|{template_id}|{sheet}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:8].upper()


def parse_payload(payload: str) -> Tuple[Optional[Dict[str, object]], Optional[str]]:
    """Parse + verify a QR payload.

    Returns (parsed_dict, None) on success or (None, error_message) on failure.
    parsed = {"examVersionId": str, "templateId": str, "sheet": int, "sheets": int}
    """
    if not payload:
        return None, "empty payload"
    parts = payload.strip().split("|")
    if len(parts) != 7 or parts[0] != "ANQB":
        return None, "payload does not match ANQB format"
    _, ver, exam_version_id, template_id, sheet_s, sheets_s, check = parts
    if ver != "1":
        return None, f"unsupported payload version {ver!r}"
    if not exam_version_id or not template_id:
        return None, "payload missing identity fields"
    try:
        sheet = int(sheet_s)
        sheets = int(sheets_s)
    except ValueError:
        return None, "non-integer sheet index"
    if sheet < 0 or sheets < 1 or sheet >= sheets:
        return None, f"invalid sheet index {sheet}/{sheets}"
    expected = checksum(exam_version_id, template_id, sheet)
    if check.upper() != expected:
        return None, f"checksum mismatch (got {check.upper()}, expected {expected})"
    parsed: Dict[str, object] = {
        "examVersionId": exam_version_id,
        "templateId": template_id,
        "sheet": sheet,
        "sheets": sheets,
    }
    return parsed, None
