# ============================================================
# ALNOKHBA QB — PRODUCTION E2E OMR flow (acts as a real teacher)
# 1. Log into the PRODUCTION site
# 2. Create an exam, set the answer key, publish (freezes the OMR template)
# 3. Download the printable OMR sheet (300dpi PNG)
# 4. Simulate two students marking with pencil + phone-photo degradation
# 5. Upload via /api/scan → verify grades, ID decode, review routing
# 6. Clean up the test exam
# Run: BASE_URL=https://alnokhba-qb.vercel.app python3 tests/e2e-omr-prod.py
# ============================================================
import base64
import json
import os
import random
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

import cv2
import numpy as np

BASE = os.environ.get("BASE_URL", "https://alnokhba-qb.vercel.app").rstrip("/")
FIX = "/home/z/my-project/tests/omr-fixtures"
TEMPLATE_FIX = json.load(open(f"{FIX}/template.json", encoding="utf-8"))
DOC_FIX = json.load(open(f"{FIX}/document.json", encoding="utf-8"))
KEY = {1: "B", 2: "C", 3: "A", 4: "D", 5: "B", 6: "A", 7: "B", 8: "B", 9: "C", 10: "B"}

cj = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def api(path, data=None, method=None, raw=False):
    url = BASE + path
    body = None
    headers = {}
    if data is not None:
        if isinstance(data, dict):
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method or ("POST" if body else "GET"))
    try:
        resp = opener.open(req, timeout=180)
        payload = resp.read()
        if raw:
            return payload, resp.status
        return json.loads(payload), resp.status
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return json.loads(payload), e.code
        except Exception:
            return {"raw": payload[:300]}, e.code


RS = np.random.RandomState(7)
PYR = random.Random(7)


def fill_bubble(img, x_mm, y_mm, r_mm, darkness=0.55):
    """Realistic pencil fill: off-center, uneven pressure."""
    px = img.shape[1] / TEMPLATE_FIX["page"]["widthMm"]
    cx = int(round((x_mm + PYR.gauss(0, 0.07)) * px))
    cy = int(round((y_mm + PYR.gauss(0, 0.07)) * px))
    r = int(r_mm * px * PYR.uniform(0.9, 1.02))
    val = int(255 * (1 - darkness * PYR.uniform(0.85, 1.0)))
    cv2.circle(img, (cx, cy), r, (val, val, val), -1, cv2.LINE_AA)


def degrade(img):
    """Phone photo: perspective + rotation + lighting + noise + blur + jpeg."""
    h, w = img.shape[:2]
    dx, dy = w * 0.05, h * 0.05
    d = lambda: abs(PYR.uniform(-1, 1))  # noqa: E731
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[d() * dx, d() * dy], [w - d() * dx, d() * dy], [w - d() * dx, h - d() * dy], [d() * dx, h - d() * dy]])
    img = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=(255, 255, 255))
    M = cv2.getRotationMatrix2D((w / 2, h / 2), PYR.uniform(-5, 5), 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    img = cv2.warpAffine(img, M, (nw, nh), borderValue=(255, 255, 255))
    strength = PYR.uniform(0.7, 0.9)
    gx = np.linspace(1.0, strength, img.shape[1], dtype=np.float32)
    grad = np.minimum(gx, gx.min() + 0.3)
    img = np.clip(img.astype(np.float32) * grad[None, :, None], 0, 255).astype(np.uint8)
    img = np.clip(img.astype(np.float32) + RS.normal(0, 6, img.shape).astype(np.float32), 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (3, 3), 0)
    scale = 1500 / img.shape[1]
    img = cv2.resize(img, (1500, int(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def main():
    # 1. login
    r, code = api("/api/auth/login", {"password": os.environ.get("APP_PASSWORD", "")})
    assert code == 200, f"login failed: {r}"
    print("[1] production login OK:", r)

    # 2. create exam + set document/key + enable OMR
    title = f"اختبار OMR آلي — {random.randint(1000, 9999)}"
    r, code = api("/api/exams", {"title": title, "direction": "rtl"})
    assert code == 201, f"exam create failed: {r}"
    exam_id = r["exam"]["id"]
    print("[2a] exam created:", exam_id)

    doc = dict(DOC_FIX)
    doc["branding"] = {**doc["branding"], "examTitle": title}
    r, code = api(f"/api/exams/{exam_id}", {
        "document": doc,
        "answerKey": {f"q{n}": KEY[n] for n in KEY},
        "omrEnabled": True,
    }, method="PATCH")
    assert code == 200, f"exam patch failed: {r}"
    print("[2b] document + answer key + OMR enabled")

    r, code = api(f"/api/exams/{exam_id}/publish", {})
    assert code in (200, 201), f"publish failed: {r}"
    version_id = r.get("versionId") or (r.get("version") if isinstance(r.get("version"), str) else None)
    print("[2c] published:", version_id)

    # 3. download the sheet
    payload, code = api(f"/api/versions/{version_id}/omr-png?sheet=0&dpi=300", raw=True)
    assert code == 200 and payload[:4] == b"\x89PNG", f"sheet failed ({code}): {payload[:120]}"
    sheet = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
    print(f"[3] sheet downloaded: {sheet.shape[1]}x{sheet.shape[0]}")

    # 4. mark sheets: student A (8/10), student B (wrong + double mark)
    sid = TEMPLATE_FIX["studentId"]
    plans = {
        "A": ({**KEY, 6: None, 9: None}, "204021"),
        "B": ({**KEY, 1: "D", 4: "A", 7: ("MULTI", "B", "C")}, "204022"),
    }
    scan_ids = []
    for name, (plan, code_str) in plans.items():
        img = sheet.copy()
        for q in TEMPLATE_FIX["questions"]:
            plan_q = plan.get(q["number"])
            if not plan_q:
                continue
            if plan_q[0] == "MULTI":
                for letter in plan_q[1:]:
                    p = q["options"][letter]
                    fill_bubble(img, p["x"], p["y"], q["radiusMm"])
            else:
                p = q["options"][plan_q]
                fill_bubble(img, p["x"], p["y"], q["radiusMm"])
        for d, ch in enumerate(code_str):
            fill_bubble(img, sid["digitColumnXs"][d], sid["valueYs"][int(ch)], sid["bubbleRMm"], darkness=0.62)
        img = degrade(img)
        cv2.imwrite(f"/tmp/omr_prod_{name}.jpg", img)
        ok, buf = cv2.imencode(".jpg", img)
        b64 = base64.b64encode(buf.tobytes()).decode()
        res, sc = api("/api/scan", {"imageBase64": b64, "debug": True})
        assert sc == 200, f"scan {name} failed ({sc}): {json.dumps(res)[:300]}"
        detected = {a["number"]: a["detected"] for a in res["answers"] if a["status"] == "selected"}
        statuses = {a["number"]: a["status"] for a in res["answers"]}
        correct = [n for n in detected if detected[n] == KEY[n]]
        amb = [n for n, s in statuses.items() if s in ("multiple", "unclear")]
        blank = [n for n, s in statuses.items() if s == "unanswered"]
        grade = res.get("grade") or {}
        print(f"[4.{name}] code={res.get('studentCode')} correct={len(correct)} wrong={sorted(n for n in detected if detected[n] != KEY[n])} ambiguous={amb} blank={blank} grade={grade.get('score')}/{grade.get('maxScore')} scanId={res.get('scanId')}")
        scan_ids.append(res.get("scanId"))

        if name == "A":
            assert res.get("studentCode") == "204021"
            assert len(correct) == 8 and sorted(blank) == [6, 9]
        if name == "B":
            assert detected.get(1) == "D" and detected.get(4) == "A"
            assert statuses.get(7) == "multiple"
            assert res.get("studentCode") == "204022"

    print("[PASS] production scans graded correctly (IDs decoded, wrong answers caught, double-mark flagged)")

    # 5. override student B's Q7 → B, approve review
    res_b_full, _ = api(f"/api/scans/{scan_ids[1]}")
    patch, sc = api(f"/api/scans/{scan_ids[1]}", {"overrides": {"7": "B"}, "reviewStatus": "APPROVED"}, method="PATCH")
    assert sc == 200, f"override failed: {json.dumps(patch)[:200]}"
    g = patch.get("grade") or {}
    print(f"[5] override applied: grade={g.get('score')}/{g.get('maxScore')} ({g.get('percent')}%)")
    assert g.get("score") == 8

    # 6. cleanup: delete the test exam (cascades versions/scans via FK or manual)
    api(f"/api/exams/{exam_id}", {"omrEnabled": False}, method="PATCH")
    dele, sc = api(f"/api/exams/{exam_id}", method="DELETE")
    print(f"[6] cleanup: HTTP {sc}")

    print("\n===== PRODUCTION E2E OMR FLOW: ALL CHECKS PASSED =====")


if __name__ == "__main__":
    sys.exit(main())
