# ============================================================
# ALNOKHBA QB — OMR Engine Verification & Calibration Harness
# Generates REAL degraded sheet images from the REAL printed
# fixture, runs the REAL pipeline, and asserts detection accuracy.
# No mock success values: every case has hard ground truth.
# Run: python3 tests/omr-engine-harness.py
# ============================================================
import base64
import json
import math
import os
import random
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mini-services", "omr-engine"))
sys.path.insert(0, os.path.join(ROOT, "mini-services", "omr-engine", "engine"))

import pipeline  # noqa: E402  (the REAL engine code)

FIX = os.path.join(ROOT, "tests", "omr-fixtures")
ART = os.path.join(ROOT, "tests", "omr-engine-harness-artifacts")
os.makedirs(ART, exist_ok=True)

RS = np.random.RandomState(42)
PYR = random.Random(42)

with open(os.path.join(FIX, "template.json"), "r", encoding="utf-8") as f:
    TEMPLATE = json.load(f)
with open(os.path.join(FIX, "key_by_number.json"), "r", encoding="utf-8") as f:
    KEY = {int(k): v for k, v in json.load(f).items()}
with open(os.path.join(FIX, "blank_sheet_0.png"), "rb") as f:
    BLANK = cv2.imdecode(np.frombuffer(f.read(), np.uint8), cv2.IMREAD_COLOR)

H, W = BLANK.shape[:2]
PX_PER_MM = W / TEMPLATE["page"]["widthMm"]

results_log: List[Dict[str, Any]] = []


# ------------------------------------------------ fill simulation

def fill_bubble(img: np.ndarray, x_mm: float, y_mm: float, r_mm: float, darkness: float, partial: float = 1.0, cross: bool = False) -> None:
    """Draw a realistic mark. darkness 0..1 (0=paper, 1=black ink). partial 0..1."""
    cx, cy = int(round(x_mm * PX_PER_MM)), int(round(y_mm * PX_PER_MM))
    r = r_mm * PX_PER_MM * 0.92
    val = int(255 * (1 - darkness))
    if partial >= 0.999:
        cv2.circle(img, (cx, cy), max(2, int(r)), (val, val, val), -1, cv2.LINE_AA)
    else:
        # half-moon style partial fill from the bottom (all channels!)
        mask = np.zeros(img.shape[:2], np.uint8)
        cv2.ellipse(mask, (cx, cy), (max(2, int(r)), max(2, int(r))), 0, 0, int(360 * partial), 255, -1)
        img[mask > 0] = (val, val, val)
    if cross:
        L = int(r * 1.15)
        cv2.line(img, (cx - L, cy - L), (cx + L, cy + L), (val, val, val), max(2, int(r * 0.5)), cv2.LINE_AA)
        cv2.line(img, (cx + L, cy - L), (cx - L, cy + L), (val, val, val), max(2, int(r * 0.5)), cv2.LINE_AA)


def encode64(img: np.ndarray, quality: Optional[int] = None) -> str:
    if quality:
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    else:
        ok, buf = cv2.imencode(".png", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


# ------------------------------------------------ degradation

def perspective(img: np.ndarray, max_frac: float = 0.07) -> np.ndarray:
    h, w = img.shape[:2]
    d = lambda: PYR.uniform(-max_frac, max_frac)  # noqa: E731
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32(
        [
            [d() * w, d() * h],
            [w + d() * w, d() * h],
            [w + d() * w, h + d() * h],
            [d() * w, h + d() * h],
        ]
    )
    M = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(img, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))


def rotate(img: np.ndarray, deg: float) -> np.ndarray:
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, M, (nw, nh), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))


def lighting(img: np.ndarray, strength: float = 0.55) -> np.ndarray:
    h, w = img.shape[:2]
    gx = np.linspace(1.0, strength, w, dtype=np.float32)
    gy = np.linspace(1.0, strength, h, dtype=np.float32)
    grad = np.minimum.outer(gy, gx)  # (h, w) in [strength, 1]
    out = img.astype(np.float32) * grad[:, :, None]
    return np.clip(out, 0, 255).astype(np.uint8)


def phone_camera(img: np.ndarray, out_width: int, jpeg_q: int) -> np.ndarray:
    img = perspective(img, 0.07)
    img = rotate(img, PYR.uniform(-4, 4))
    img = lighting(img, PYR.uniform(0.62, 0.8))
    noise = RS.normal(0, PYR.uniform(6, 10), img.shape).astype(np.float32)
    img = np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (3, 3), 0)
    scale = out_width / img.shape[1]
    if scale < 1:
        img = cv2.resize(img, (out_width, int(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, jpeg_q])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


# ------------------------------------------------ helpers

def build_sheet(fills: Dict[int, Optional[str]], instrument: str = "pen", sheet=None) -> np.ndarray:
    """fills: question number -> letter | None | ('MULTI', l1, l2)"""
    img = BLANK.copy() if sheet is None else sheet.copy()
    def darkness_for(inst: str) -> float:
        return {"pencil": 0.48, "pen": 0.82, "blue": 0.52, "light": 0.26}[inst]
    for q in TEMPLATE["questions"]:
        n = q["number"]
        plan = fills.get(n)
        if plan is None:
            continue
        if isinstance(plan, tuple) and plan[0] == "MULTI":
            for letter in plan[1:]:
                p = q["options"][letter]
                fill_bubble(img, p["x"], p["y"], q["radiusMm"], darkness_for(instrument))
        else:
            p = q["options"][plan]
            fill_bubble(img, p["x"], p["y"], q["radiusMm"], darkness_for(instrument))
    return img


def fill_student_id(img: np.ndarray, code: str, extra_multi: Optional[Tuple[int, int]] = None) -> None:
    sid = TEMPLATE["studentId"]
    if not sid:
        return
    for d, ch in enumerate(code):
        v = int(ch)
        x = sid["digitColumnXs"][d]
        y = sid["valueYs"][v]
        fill_bubble(img, x, y, sid["bubbleRMm"], 0.8)
        if extra_multi and d == extra_multi[0]:
            y2 = sid["valueYs"][extra_multi[1]]
            fill_bubble(img, x, y2, sid["bubbleRMm"], 0.8)


def fill_bubble_crossed(img: np.ndarray, x_mm: float, y_mm: float, r_mm: float, darkness: float = 0.38) -> None:
    """Two thin X strokes across the bubble (typical cross-out, not a full scribble)."""
    cx, cy = int(round(x_mm * PX_PER_MM)), int(round(y_mm * PX_PER_MM))
    r = r_mm * PX_PER_MM * 0.95
    val = int(255 * (1 - darkness))
    L = int(r * 1.05)
    t = max(2, int(r * 0.28))
    cv2.line(img, (cx - L, cy - L), (cx + L, cy + L), (val, val, val), t, cv2.LINE_AA)
    cv2.line(img, (cx + L, cy - L), (cx - L, cy + L), (val, val, val), t, cv2.LINE_AA)


def run(img: np.ndarray, with_template: bool = True, answer_key: bool = True, **kw) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "imageBase64": encode64(img, kw.pop("jpeg", None)),
        "debug": kw.pop("debug", True),
    }
    if with_template:
        payload["template"] = kw.pop("template", TEMPLATE)
    if answer_key:
        payload["answerKey"] = {str(k): v for k, v in KEY.items()}
        payload["marksMap"] = {str(k): 1 for k in KEY}
    payload.update(kw)
    return pipeline.process(payload)


def check_answers(res: Dict[str, Any], expected: Dict[int, Optional[str]], allow_unclear_as: Optional[Dict[int, str]] = None) -> Tuple[float, List[str]]:
    """Returns (exact accuracy, list of problems). expected None = unanswered."""
    got = {a["number"]: (a["detected"] if a["status"] == "selected" else ("MULTI" if a["status"] == "multiple" else ("UNCLEAR" if a["status"] == "unclear" else None))) for a in res["answers"]}
    problems = []
    ok = 0
    for n, exp in expected.items():
        g = got.get(n)
        if exp is None:
            good = g is None or g == "UNCLEAR" and False
            good = g is None
        elif exp == "MULTI":
            good = g == "MULTI"
        else:
            good = g == exp or (g == "UNCLEAR" and allow_unclear_as and allow_unclear_as.get(n) == exp)
        if good:
            ok += 1
        else:
            problems.append(f"Q{n}: expected {exp}, got {g} ratios={next((a['ratios'] for a in res['answers'] if a['number'] == n), {})}")
    return ok / max(1, len(expected)), problems


def record(case: str, passed: bool, detail: str, extra: Optional[Dict[str, Any]] = None) -> None:
    results_log.append({"case": case, "passed": passed, "detail": detail, "extra": extra or {}})
    print(f"{'✅' if passed else '❌'} {case}: {detail}")


def save_artifact(name: str, img: np.ndarray) -> str:
    p = os.path.join(ART, name)
    cv2.imwrite(p, img)
    return p


# ================================================= TEST CASES

def case_fill_plan(correct_letters: Dict[int, str]) -> Dict[int, Optional[str]]:
    return {n: correct_letters[n] for n in KEY}


def main() -> None:
    t_all = time.time()
    print(f"harness: sheet {W}x{H}, px/mm={PX_PER_MM:.3f}, questions={TEMPLATE['totalQuestions']}")
    thresholds_stats: Dict[str, List[float]] = {"empty": [], "pencil": [], "pen": [], "blue": [], "light": []}

    # measure raw ratio distributions: scan one blank + one filled per instrument
    for inst in ["pencil", "pen", "blue", "light"]:
        img = build_sheet(KEY, instrument=inst)
        res = run(img)
        assert res["ok"], res
        for a in res["answers"]:
            for letter, r in a["ratios"].items():
                if a["number"] in KEY and letter == KEY[a["number"]]:
                    thresholds_stats[inst].append(r)
                else:
                    thresholds_stats["empty"].append(r)

    empty_med = float(np.median(thresholds_stats["empty"]))
    print(f"ratio calibration: empty≈{empty_med:.3f} pencil≈{np.median(thresholds_stats['pencil']):.3f} "
          f"pen≈{np.median(thresholds_stats['pen']):.3f} blue≈{np.median(thresholds_stats['blue']):.3f} "
          f"light≈{np.median(thresholds_stats['light']):.3f}")

    # ---------- 1. clean scan pencil ≥95%
    res = run(build_sheet(KEY, "pencil"))
    acc, problems = check_answers(res, KEY)
    record("1. clean pencil scan", acc >= 0.95 and res["ok"], f"accuracy={acc:.0%}", {"problems": problems[:5], "ms": res.get("processingMs")})
    if acc < 1.0:
        save_artifact("fail_pencil.png", build_sheet(KEY, "pencil"))

    # ---------- 2. clean black pen ≥98%
    res = run(build_sheet(KEY, "pen"))
    acc, problems = check_answers(res, KEY)
    record("2. clean black pen scan", acc >= 0.98 and res["ok"], f"accuracy={acc:.0%}", {"problems": problems[:5]})

    # ---------- 3. blue pen ≥95%
    res = run(build_sheet(KEY, "blue"))
    acc, problems = check_answers(res, KEY)
    record("3. blue pen scan", acc >= 0.95 and res["ok"], f"accuracy={acc:.0%}", {"problems": problems[:5]})

    # ---------- 4. phone camera ≥90%
    for width, q, label in [(1600, 80, "1600px"), (1200, 70, "1200px")]:
        img = phone_camera(build_sheet(KEY, "pencil"), width, q)
        res = run(img)
        acc, problems = check_answers(res, KEY)
        record(f"4. phone camera {label}", acc >= 0.90 and res["ok"], f"accuracy={acc:.0%}", {"problems": problems[:5]})

    # ---------- 5. rotations
    for deg in (3, -3, 10, -10):
        img = rotate(build_sheet(KEY, "pencil"), deg)
        res = run(img)
        acc, problems = check_answers(res, KEY)
        record(f"5. rotation {deg}°", acc >= 0.90 and res["ok"], f"accuracy={acc:.0%} rotationFixed={res['diagnostics'].get('rotationDeg')}", {"problems": problems[:3]})
    for deg in (90, 180):
        img = np.rot90(build_sheet(KEY, "pencil"), k=deg // 90).copy()
        res = run(img)
        acc, problems = check_answers(res, KEY)
        record(f"5. rotation {deg}°", acc >= 0.90 and res["ok"], f"accuracy={acc:.0%} rotationFixed={res['diagnostics'].get('rotationDeg')}", {"problems": problems[:3]})

    # ---------- 6. low light ≥85%
    img = lighting(build_sheet(KEY, "pencil"), 0.5)
    res = run(img)
    acc, problems = check_answers(res, KEY)
    record("6. low light", acc >= 0.85 and res["ok"], f"accuracy={acc:.0%}", {"problems": problems[:5]})

    # ---------- 7. multiple marks → exactly those, 100%
    multi = dict(KEY)
    multi_plan: Dict[int, Any] = {n: l for n, l in multi.items()}
    multi_q = [1, 5, 9]
    for n in multi_q:
        wrong = "A" if KEY[n] != "A" else "B"
        multi_plan[n] = ("MULTI", KEY[n], wrong)
    res = run(build_sheet(multi_plan, "pen"))
    got_multi = [a["number"] for a in res["answers"] if a["status"] == "multiple"]
    record("7. multiple marks", got_multi == sorted(multi_q), f"multiples={got_multi} expected={sorted(multi_q)}")

    # ---------- 8. blank sheet → all unanswered
    res = run(BLANK.copy())
    all_unans = all(a["status"] == "unanswered" for a in res["answers"])
    record("8. blank sheet", res["ok"] and all_unans, f"statuses={set(a['status'] for a in res['answers'])}")

    # ---------- 9. light marks → unclear or correct, never confidently wrong
    res = run(build_sheet(KEY, "light"))
    wrong_confident = [
        a for a in res["answers"]
        if a["status"] == "selected" and a["detected"] != KEY[a["number"]] and a["confidence"] > 0.75
    ]
    unclear_or_ok = [
        a for a in res["answers"]
        if a["number"] in KEY and (
            a["detected"] == KEY[a["number"]] or a["status"] in ("unclear", "unanswered", "multiple")
        )
    ]
    record("9. light marks", len(wrong_confident) == 0 and len(unclear_or_ok) >= 8,
           f"wrongConfident={len(wrong_confident)} okOrUnclear={len(unclear_or_ok)}/10")

    # ---------- 10. partial fills → unclear or correct
    img = BLANK.copy()
    partial_plan = {}
    for n, l in KEY.items():
        q = next(qq for qq in TEMPLATE["questions"] if qq["number"] == n)
        p = q["options"][l]
        fill_bubble(img, p["x"], p["y"], q["radiusMm"], 0.7, partial=PYR.uniform(0.5, 0.7))
    res = run(img)
    partial_ok = [a for a in res["answers"] if a["detected"] == KEY[a["number"]] or a["status"] == "unclear"]
    record("10. partial fills", len(partial_ok) >= 8, f"okOrUnclear={len(partial_ok)}/10 statuses={[(a['number'],a['status']) for a in res['answers']]}")

    # ---------- 11. erased ghosts → unanswered
    img = BLANK.copy()
    for n, l in KEY.items():
        q = next(qq for qq in TEMPLATE["questions"] if qq["number"] == n)
        p = q["options"][l]
        fill_bubble(img, p["x"], p["y"], q["radiusMm"], PYR.uniform(0.10, 0.16))
    res = run(img)
    all_unans = all(a["status"] == "unanswered" for a in res["answers"])
    record("11. erased ghosts", all_unans, f"statuses={set(a['status'] for a in res['answers'])} medianEmpty={res['diagnostics']['fillStats']['medianEmpty']}")

    # ---------- 12. crossed-out bubbles → explainable, never confidently wrong
    img = BLANK.copy()
    for n, l in KEY.items():
        q = next(qq for qq in TEMPLATE["questions"] if qq["number"] == n)
        p = q["options"][l]
        # a typical cross-out: thin strokes, moderate pressure
        fill_bubble_crossed(img, p["x"], p["y"], q["radiusMm"], darkness=0.38)
    res = run(img)
    crossed_ok = [
        a for a in res["answers"]
        if a["status"] in ("unclear", "multiple")
        or (a["detected"] == KEY[a["number"]])
    ]
    confidently_wrong = [
        a for a in res["answers"]
        if a["status"] == "selected" and a["detected"] != KEY[a["number"]] and a["confidence"] > 0.8
    ]
    record("12. crossed-out", len(crossed_ok) >= 8 and len(confidently_wrong) == 0,
           f"okOrUnclear={len(crossed_ok)}/10 wrongConf={len(confidently_wrong)} statuses={[(a['number'],a['status']) for a in res['answers']]}")

    # ---------- 13. wrong template → mismatch error
    bad = json.loads(json.dumps(TEMPLATE))
    bad["templateId"] = "T-different"
    bad["examVersionId"] = "different"
    res = run(build_sheet(KEY, "pen"), template=bad)
    record("13. wrong template", (not res["ok"]) and "mismatch" in res.get("error", ""), f"error={res.get('error', '')[:80]}")

    # ---------- 14. QR-only mode (no template) → needsTemplate + identity
    res = run(build_sheet(KEY, "pen"), with_template=False, answer_key=False)
    record("14. QR-only identity", res.get("ok") and res.get("needsTemplate") and res.get("templateId") == TEMPLATE["templateId"],
           f"templateId={res.get('templateId')} sheet={res.get('sheet')}")

    # ---------- 15. student ID decode + double-mark "?"
    img = build_sheet(KEY, "pen")
    fill_student_id(img, "314159", extra_multi=(3, 7))
    res = run(img)
    sid = res.get("studentId") or {}
    record("15. student ID", sid.get("digits", "").startswith("314") and "?" in sid.get("digits", ""),
           f"digits={sid.get('digits')} conf={sid.get('confidence')}")

    # ---------- 16. auto grading exact
    res = run(build_sheet(KEY, "pen"))
    g = res.get("grade") or {}
    record("16. auto grading", g.get("score") == 10 and g.get("percent") == 100.0, f"grade={g.get('score')}/{g.get('total')} {g.get('percent')}%")

    # ---------- 17. QR failure → clean error (no QR: crop QR region out)
    img = build_sheet(KEY, "pen")
    qx, qy, qs = int(TEMPLATE["qr"]["x"] * PX_PER_MM) - 20, int(TEMPLATE["qr"]["y"] * PX_PER_MM) - 20, int((TEMPLATE["qr"]["sizeMm"] + 6) * PX_PER_MM)
    cv2.rectangle(img, (max(0, qx), max(0, qy)), (qx + qs, qy + qs), (255, 255, 255), -1)
    res = run(img, with_template=False, answer_key=False)
    record("17. QR failure clean error", (not res["ok"]) and res.get("stage") == "templateIdentified", f"stage={res.get('stage')} error={str(res.get('error'))[:60]}")

    # ---------- 18. template manual (QR unreadable) still works
    res = run(img, with_template=True, answer_key=True)
    acc, _ = check_answers(res, KEY) if res.get("ok") else (0, [])
    record("18. manual template w/o QR", res.get("ok") and acc >= 0.9 and res.get("templateSource") == "manual",
           f"acc={acc:.0%} src={res.get('templateSource')} rot={res.get('diagnostics', {}).get('rotationDeg')}")

    # ---------- recommended thresholds
    rec = {
        "filled": float(np.median(thresholds_stats["pencil"])) * 0.82,
        "empty": max(0.16, float(np.percentile(thresholds_stats["empty"], 99)) * 1.25),
        "ambiguousMargin": 0.10,
        "minAbsoluteFill": float(np.percentile(thresholds_stats["empty"], 99)) * 1.6,
    }
    rec["filled"] = round(min(0.6, max(0.32, rec["filled"])), 3)
    rec["empty"] = round(min(0.3, max(0.10, rec["empty"])), 3)
    rec["minAbsoluteFill"] = round(min(0.25, max(0.06, rec["minAbsoluteFill"])), 3)

    # ---------- report
    passed = sum(1 for r in results_log if r["passed"])
    total = len(results_log)
    summary = {
        "passed": passed,
        "total": total,
        "allPassed": passed == total,
        "recommendedThresholds": rec,
        "ratioStats": {k: {"median": round(float(np.median(v)), 4), "p99": round(float(np.percentile(v, 99)), 4)} for k, v in thresholds_stats.items() if v},
        "cases": results_log,
        "totalMs": int((time.time() - t_all) * 1000),
    }
    with open(os.path.join(ROOT, "tests", "omr-engine-harness-report.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("\n=== OMR HARNESS SUMMARY ===")
    print(f"passed {passed}/{total}  (allPassed={summary['allPassed']})  total={summary['totalMs']}ms")
    print(f"recommended thresholds: {json.dumps(rec)}")
    for r in results_log:
        if not r["passed"]:
            print(f"  FAILED: {r['case']} — {r['detail']}")
    return 0 if summary["allPassed"] else 1


if __name__ == "__main__":
    sys.exit(main())
