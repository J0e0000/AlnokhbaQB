# ============================================================
# ALNOKHBA QB — E2E OMR user flow (acts as a real teacher)
# 1. Downloads the printable OMR sheet from the site API
# 2. Simulates THREE students marking their sheets (pencil,
#    realistic degradation: rotation/perspective/lighting/jpeg)
# 3. Uploads them to /api/scan (the exact call the UI makes)
# 4. Verifies grades, review queue, overrides and accuracy
# ============================================================
import base64
import io
import json
import random
import urllib.request
import urllib.error
from http.cookiejar import CookieJar

import cv2
import numpy as np

BASE = "http://localhost:3000"
VERSION_ID = "cmug687vk0002kxvn7rhby9f7"
KEY = {1: "B", 2: "C", 3: "A", 4: "D", 5: "B", 6: "A", 7: "B", 8: "B", 9: "C", 10: "B"}
FIX = "/home/z/my-project/tests/omr-fixtures"
TEMPLATE = json.load(open(f"{FIX}/template.json", encoding="utf-8"))

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
        else:
            body = data
            headers["Content-Type"] = "application/octet-stream"
    req = urllib.request.Request(url, data=body, headers=headers, method=method or ("POST" if body else "GET"))
    try:
        resp = opener.open(req, timeout=120)
        payload = resp.read()
        if raw:
            return payload, resp.status
        return json.loads(payload), resp.status
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return json.loads(payload), e.code
        except Exception:
            return {"raw": payload[:200]}, e.code


def login():
    r, code = api("/api/auth/login", {"email": "teacher@alnokhba.qb", "password": "Teacher@2025"})
    assert code == 200, f"login failed: {r}"
    print("[1] login OK:", r["user"]["name"])


def download_sheet():
    payload, code = api(f"/api/versions/{VERSION_ID}/omr-png?sheet=0&dpi=300", raw=True)
    assert code == 200 and payload[:4] == b"\x89PNG", f"sheet download failed ({code})"
    img = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
    print(f"[2] sheet downloaded: {img.shape[1]}x{img.shape[0]}")
    return img


# ---------------- marking simulation (as a student would)
RS = np.random.RandomState(2025)
PYR = random.Random(2025)


def fill_bubble(img, x_mm, y_mm, r_mm, darkness=0.55, wobble=0.18):
    """Realistic pencil fill: slightly off-center, soft edge, uneven pressure."""
    px = img.shape[1] / TEMPLATE["page"]["widthMm"]
    cx = int(round((x_mm + PYR.gauss(0, wobble * 0.4)) * px))
    cy = int(round((y_mm + PYR.gauss(0, wobble * 0.4)) * px))
    r = int(r_mm * px * PYR.uniform(0.88, 1.0))
    val = int(255 * (1 - darkness * PYR.uniform(0.82, 1.05)))
    overlay = img.copy()
    cv2.circle(overlay, (cx, cy), r, (val, val, val), -1, cv2.LINE_AA)
    # uneven pressure: multiply a soft noise mask inside the fill
    noise = RS.normal(1.0, 0.08, (img.shape[0], img.shape[1], 1)).astype(np.float32)
    mask = np.zeros(img.shape[:2], np.uint8)
    cv2.circle(mask, (cx, cy), r, 255, -1)
    maskf = cv2.GaussianBlur(mask, (9, 9), 3).astype(np.float32) / 255.0
    img[:] = (overlay * (1 - maskf[..., None]) + np.clip(overlay * noise, 0, 255) * maskf[..., None]).astype(np.uint8)


def degrade(img):
    """Realistic phone photo of a marked sheet."""
    h, w = img.shape[:2]
    dx, dy = w * 0.06, h * 0.06
    d = lambda: abs(PYR.uniform(-1, 1))  # noqa: E731
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[d() * dx, d() * dy], [w - d() * dx, d() * dy], [w - d() * dx, h - d() * dy], [d() * dx, h - d() * dy]])
    img = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=(255, 255, 255))
    M = cv2.getRotationMatrix2D((w / 2, h / 2), PYR.uniform(-6, 6), 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    img = cv2.warpAffine(img, M, (nw, nh), borderValue=(255, 255, 255))
    h, w = img.shape[:2]
    strength = PYR.uniform(0.65, 0.85)
    gx = np.linspace(1.0, strength, w, dtype=np.float32)
    grad = np.minimum(gx, gx.min() + 0.25)
    img = np.clip(img.astype(np.float32) * grad[None, :, None], 0, 255).astype(np.uint8)
    img = np.clip(img.astype(np.float32) + RS.normal(0, 7, img.shape).astype(np.float32), 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (3, 3), 0)
    scale = 1500 / img.shape[1]
    img = cv2.resize(img, (1500, int(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 72])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def mark_sheet(student_answers, student_code):
    img = download_sheet()
    for q in TEMPLATE["questions"]:
        n = q["number"]
        plan = student_answers.get(n)
        if not plan:
            continue
        if plan[0] == "MULTI":
            for letter in plan[1:]:
                p = q["options"][letter]
                fill_bubble(img, p["x"], p["y"], q["radiusMm"])
        else:
            p = q["options"][plan]
            fill_bubble(img, p["x"], p["y"], q["radiusMm"])
    sid = TEMPLATE["studentId"]
    for d, ch in enumerate(student_code):
        x = sid["digitColumnXs"][d]
        y = sid["valueYs"][int(ch)]
        fill_bubble(img, x, y, sid["bubbleRMm"], darkness=0.65)
    return img


def scan(img_b64, hint=True):
    payload = {"imageBase64": img_b64, "debug": True}
    if hint:
        payload["examVersionIdHint"] = VERSION_ID
    return api("/api/scan", payload)


def main():
    login()
    sheet = download_sheet()
    # run-nonce: a faint dot in the left margin (outside the frame, far from
    # markers/QR) so each run's images are unique — the scan API is
    # idempotent by image hash and would otherwise replay previous results.
    nonce_x, nonce_y = int(2.5 * sheet.shape[1] / 210), int(random.randint(120, 200) * sheet.shape[0] / 297)
    cv2.circle(sheet, (nonce_x, nonce_y), 4, (215, 215, 215), -1)

    # Student A: 8/10 correct, missed Q6 & Q9 (blank), code 204015
    a_plan = dict(KEY)
    a_plan[6] = None
    a_plan[9] = None
    # Student B: 5/10 — Q1 wrong (D), Q4 wrong (A), Q7 double-marked, code 204016
    b_plan = dict(KEY)
    b_plan[1] = "D"
    b_plan[4] = "A"
    b_plan[7] = ("MULTI", "B", "C")
    # Student C: deliberately half-hearted: light marks everywhere, code 204017
    c_plan = dict(KEY)
    c_plan[3] = None
    c_plan[8] = None

    students = [
        ("A", a_plan, "204015", 0.62),
        ("B", b_plan, "204016", 0.72),
        ("C", c_plan, "204017", 0.30),  # light pencil
    ]

    results = []
    for idx, (name, plan, code, darkness_scale) in enumerate(students):
        img = sheet.copy()  # nonce already applied
        for q in TEMPLATE["questions"]:
            n = q["number"]
            plan_q = plan.get(n)
            if not plan_q:
                continue
            if plan_q[0] == "MULTI":
                for letter in plan_q[1:]:
                    p = q["options"][letter]
                    fill_bubble(img, p["x"], p["y"], q["radiusMm"], darkness=darkness_scale)
            else:
                p = q["options"][plan_q]
                fill_bubble(img, p["x"], p["y"], q["radiusMm"], darkness=darkness_scale)
        sid = TEMPLATE["studentId"]
        for d, ch in enumerate(code):
            x = sid["digitColumnXs"][d]
            y = sid["valueYs"][int(ch)]
            fill_bubble(img, x, y, sid["bubbleRMm"], darkness=darkness_scale + 0.08)
        img = degrade(img)
        cv2.imwrite(f"/tmp/omr_e2e_student_{name}.jpg", img)
        ok, buf = cv2.imencode(".jpg", img)
        b64 = base64.b64encode(buf.tobytes()).decode()
        res, code_status = scan(b64)
        print(f"[3.{idx + 1}] scan student {name}: HTTP {code_status}")
        results.append((name, plan, code, res))

    print("\n===== RESULTS =====")
    expected_scores = {}
    for name, plan, code, res in results:
        if res.get("status_code", 200) and not res.get("ok", True) and res.get("error"):
            print(f"student {name}: ERROR {res}")
            continue
        detected = {a["number"]: a["detected"] for a in res.get("answers", []) if a["status"] == "selected"}
        status_map = {a["number"]: a["status"] for a in res.get("answers", [])}
        # expected correct count among confidently-graded
        correct = [n for n in detected if detected[n] == KEY[n]]
        wrong = [n for n in detected if detected[n] != KEY[n]]
        amb = [n for n, s in status_map.items() if s in ("multiple", "unclear")]
        blank = [n for n, s in status_map.items() if s == "unanswered"]
        grade = res.get("grade") or {}
        print(f"student {name} (code {res.get('studentCode')}):")
        print(f"  detected={detected}")
        print(f"  correct={sorted(correct)} wrong={sorted(wrong)} ambiguous={sorted(amb)} blank={sorted(blank)}")
        print(f"  grade={grade.get('score')}/{grade.get('maxScore')} ({grade.get('percent')}%) review={res.get('needsReview')} scanId={res.get('scanId')}")

    # Student A assertions: exactly 8 selected-correct, 2 blank
    _, _, _, res_a = results[0]
    det_a = {a["number"]: a["detected"] for a in res_a.get("answers", []) if a["status"] == "selected"}
    st_a = {a["number"]: a["status"] for a in res_a.get("answers", [])}
    blank_a = [n for n, s in st_a.items() if s == "unanswered"]
    assert res_a.get("studentCode") == "204015", f"student A code: {res_a.get('studentCode')}"
    assert len([n for n in det_a if det_a[n] == KEY[n]]) == 8, f"student A correct: {det_a}"
    assert sorted(blank_a) == [6, 9], f"student A blank: {blank_a}"
    print("\n[PASS] student A: 8/10 detected correctly, Q6/Q9 blank, ID decoded")

    # Student B: Q1=D wrong, Q4=A wrong, Q7 double → multiple
    _, _, _, res_b = results[1]
    st_b = {a["number"]: a["status"] for a in res_b.get("answers", [])}
    det_b = {a["number"]: a["detected"] for a in res_b.get("answers", []) if a["status"] == "selected"}
    assert det_b.get(1) == "D" and det_b.get(4) == "A", f"student B wrong answers: {det_b}"
    assert st_b.get(7) == "multiple", f"student B Q7: {st_b.get(7)}"
    assert res_b.get("studentCode") == "204016", f"student B code: {res_b.get('studentCode')}"
    print("[PASS] student B: wrong answers detected, double-mark flagged")

    # Review queue should contain student B (has multiple mark)
    lst, _ = api("/api/scans?review=PENDING")
    pend = lst if isinstance(lst, list) else lst.get("scans", [])
    print(f"[4] review queue: {len(pend)} pending")
    assert any(s.get("id") == res_b.get("scanId") for s in pend), "student B not in review queue"

    # Override flow: approve student B's double-mark Q7 as B (the correct one)
    res_b_full, _ = api(f"/api/scans/{res_b.get('scanId')}")
    patch, code_patch = api(f"/api/scans/{res_b.get('scanId')}", {
        "overrides": {"7": "B"},
        "reviewStatus": "APPROVED",
    }, method="PATCH")
    assert code_patch == 200, f"override failed: {patch}"
    g = patch.get("grade") or patch.get("scan", {}).get("grade") or {}
    print(f"[5] override applied to Q7: grade now {g}")

    # Student C: light pencil — never confidently wrong
    _, _, _, res_c = results[2]
    st_c = {a["number"]: a["status"] for a in res_c.get("answers", [])}
    wrong_conf = [a for a in res_c.get("answers", []) if a["status"] == "selected" and a["detected"] != KEY[a["number"]] and a["confidence"] > 0.85]
    assert len(wrong_conf) == 0, f"student C confidently wrong: {wrong_conf}"
    print(f"[PASS] student C (light pencil): statuses={st_c}")

    print("\n===== E2E OMR USER FLOW: ALL CHECKS PASSED =====")


if __name__ == "__main__":
    main()
