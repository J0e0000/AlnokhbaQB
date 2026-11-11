"""Auto-grading: compare detected answers against the answer key.

Grading contract (mirrors src/lib/qb/grading.ts semantics):
- only `selected` answers can be correct or incorrect;
- multiple / unclear / unanswered never score;
- marks per question: marksMap[questionNumber] else template.marksPerQuestion;
- the grade covers the questions printed on the scanned sheet.
"""
from typing import Any, Dict, List, Optional


def grade_sheet(
    answers: List[Dict[str, Any]],
    answer_key: Optional[Dict[str, str]],
    marks_map: Optional[Dict[str, float]],
    template: Any,
) -> Optional[Dict[str, Any]]:
    """Build the grade object for one scanned sheet (or None)."""
    if not answer_key:
        return None
    key_by_number = {str(k): str(v).upper() for k, v in answer_key.items()}
    marks_map = marks_map or {}

    sheet_numbers = {int(a["number"]) for a in answers}
    correct: List[int] = []
    incorrect: List[int] = []
    ambiguous: List[int] = []
    unanswered: List[int] = []
    score = 0.0
    total = 0.0
    for a in answers:
        number = int(a["number"])
        letter = str(key_by_number.get(str(number), "")).strip().upper()
        if not letter:
            continue  # not in key — excluded from this exam's grading
        marks = float(marks_map.get(str(number), template.marks_per_question))
        total += marks
        status = a["status"]
        if status == "selected":
            if a["detected"] and a["detected"].upper() == letter:
                correct.append(number)
                score += marks
            else:
                incorrect.append(number)
        elif status == "multiple":
            ambiguous.append(number)
        elif status == "unanswered":
            unanswered.append(number)
        # 'unclear' / 'invalid' never score and are omitted from the lists;
        # they remain visible (and reviewable) in the answers array.

    percent = round(score / total * 100.0, 1) if total > 0 else 0.0
    return {
        "score": score if float(score).is_integer() else round(score, 2),
        "total": total if float(total).is_integer() else round(total, 2),
        "correct": sorted(correct),
        "incorrect": sorted(incorrect),
        "ambiguous": sorted(ambiguous),
        "unanswered": sorted(unanswered),
        "percent": percent,
    }
