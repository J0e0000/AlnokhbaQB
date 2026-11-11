# ALNOKHBA QB — OMR benchmark harness
# Phase 2: generate synthetic filled sheets (ground truth), augment with
# realistic photo conditions, run through the engine, measure accuracy.
import base64
import json
import math
import random
import sys
import urllib.request
from io import BytesIO

import cv2
import numpy as np

ENGINE = "http://127.0.0.1:3032"
DPI = 300
PXMM = DPI / 25.4


def http_post_json(url: str, payload: dict, timeout: float = 60.0):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def fill_sheet(blank_path: str, template: dict, answers: dict, sid: str,
               fill_color=40, seed=0):
    """Fill bubbles on the blank 300dpi PNG. Returns BGR image."""
    rng = random.Random(seed)
    img = cv2.imread(blank_path)
    assert img is not None, "blank sheet missing"
    px = PXMM

    def bubble(cx_mm, cy_mm, r_mm, strength=fill_color):
        cx, cy, r = int(cx_mm * px), int(cy_mm * px), r_mm * px
        noise = rng.uniform(0.92, 1.08)
        cv2.circle(img, (cx, cy), max(2, int(r * 0.82 * noise)), (strength,) * 3, -1, cv2.LINE_AA)

    # answer bubbles
    for q in template["questions"]:
        if q["sheet"] != 0:
            continue
        letter = answers[str(q["number"])]
        pos = q["options"][letter]
        bubble(pos["x"], pos["y"], q["radiusMm"])

    # student id bubbles
    sidg = template.get("studentId")
    if sidg and sid:
        for d, x in enumerate(sidg["digitColumnXs"]):
            v = int(sid[d])
            y = sidg["valueYs"][v]
            bubble(x, y, sidg["bubbleRMm"], strength=fill_color)
    return img


def augment(img: np.ndarray, mode: str, seed: int) -> np.ndarray:
    """Simulate real photo conditions."""
    rng = np.random.RandomState(seed)
    h, w = img.shape[:2]

    if mode == "clean":
        return img

    if mode == "rotate5":
        M = cv2.getRotationMatrix2D((w / 2, h / 2), 5, 1.0)
        return cv2.warpAffine(img, M, (w, h), borderValue=(255,) * 3)

    if mode == "rotate45":
        M = cv2.getRotationMatrix2D((w / 2, h / 2), 45, 1.0)
        return cv2.warpAffine(img, M, (w, h), borderValue=(255,) * 3)

    if mode == "rotate45_full":
        # 45° with canvas expansion — the realistic "whole page visible" case
        M = cv2.getRotationMatrix2D((w / 2, h / 2), 45, 1.0)
        cos_v, sin_v = abs(M[0, 0]), abs(M[0, 1])
        nw, nh = int(h * sin_v + w * cos_v) + 1, int(h * cos_v + w * sin_v) + 1
        M[0, 2] += nw / 2 - w / 2
        M[1, 2] += nh / 2 - h / 2
        return cv2.warpAffine(img, M, (nw, nh), borderValue=(255,) * 3)

    if mode == "crop45":
        # pathological: 45° WITH corner cropping (markers + QR cut off).
        # Expected behavior: CLEAN FAILURE, never garbage grades.
        M = cv2.getRotationMatrix2D((w / 2, h / 2), 45, 1.0)
        return cv2.warpAffine(img, M, (w, h), borderValue=(255,) * 3)

    if mode == "rotate180":
        return cv2.rotate(img, cv2.ROTATE_180)

    if mode == "perspective":
        # moderate phone-tilt: corners displaced up to 6%
        amt = 0.06
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dx = w * amt
        dy = h * amt
        dst = np.float32([
            [rng.uniform(0, dx), rng.uniform(0, dy)],
            [w - rng.uniform(0, dx), rng.uniform(0, dy)],
            [w - rng.uniform(0, dx), h - rng.uniform(0, dy)],
            [rng.uniform(0, dx), h - rng.uniform(0, dy)],
        ])
        M = cv2.getPerspectiveTransform(src, dst)
        return cv2.warpPerspective(img, M, (w, h), borderValue=(255,) * 3)

    if mode == "shadows":
        # flat-field shadow gradient (simulates hand/phone shadow)
        yy, xx = np.mgrid[0:h, 0:w]
        grad = 1.0 - 0.45 * ((xx / w - 0.25) ** 2 + (yy / h - 0.8) ** 2)
        out = img.astype(np.float32) * grad[..., None]
        return np.clip(out, 0, 255).astype(np.uint8)

    if mode == "camera":
        # 2200px-wide phone capture + mild blur + jpeg 60
        scale = 2200 / w
        small = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (3, 3), 0.8)
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 60])
        assert ok
        return cv2.imdecode(buf, cv2.IMREAD_COLOR)

    if mode == "dark_glare":
        # darker + local glare hotspot
        out = (img.astype(np.float32) * 0.72).astype(np.uint8)
        yy, xx = np.mgrid[0:h, 0:w]
        glare = np.exp(-(((xx - w * 0.7) / (w * 0.12)) ** 2 + ((yy - h * 0.25) / (h * 0.1)) ** 2))
        out = np.clip(out.astype(np.float32) + 130 * glare[..., None], 0, 255).astype(np.uint8)
        return out

    raise ValueError(mode)


def b64(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


def evaluate(result: dict, answers: dict, sid: str):
    per_q = {}
    for a in result.get("answers", []):
        per_q[str(a["number"])] = a
    correct = wrong = missed = ambiguous = 0
    wrong_detail = []
    for num, truth in answers.items():
        a = per_q.get(num)
        if not a:
            missed += 1
            continue
        if a.get("status") == "selected" and a.get("detected") == truth:
            correct += 1
        elif a.get("status") in ("multiple", "unclear", "invalid"):
            ambiguous += 1
        else:
            wrong += 1
            wrong_detail.append((num, truth, a.get("detected"), a.get("status"), a.get("ratios")))
    got_sid = (result.get("studentId") or {}).get("digits") or ""
    sid_ok = got_sid == sid
    return {
        "correct": correct, "wrong": wrong, "ambiguous": ambiguous, "missed": missed,
        "wrongDetail": wrong_detail, "sidOk": sid_ok, "gotSid": got_sid,
        "stage": result.get("stage"), "ok": result.get("ok"),
        "error": result.get("error"),
    }


def main():
    template = json.load(open("/tmp/omr-bench/template.json"))
    tpl = template.get("template", template)
    n = tpl["totalQuestions"]
    letters = list(tpl["questions"][0]["options"].keys())
    rng = random.Random(42)
    answers = {str(i + 1): rng.choice(letters) for i in range(n)}
    sid = "135790"

    key = {str(q["number"]): answers[str(q["number"])] for q in tpl["questions"]}

    print(f"questions={n} letters={letters} sid={sid}")
    print(f"{'mode':<12} {'ok':<5} {'acc':>6} {'sid':>5}  note")
    total_correct = total_q = 0
    failures = []
    modes = ["clean", "rotate5", "rotate45_full", "rotate180", "perspective", "shadows", "camera", "dark_glare", "crop45"]
    for i, mode in enumerate(modes):
        img = fill_sheet("/tmp/omr-bench/blank_sheet.png", tpl, answers, sid, seed=100 + i)
        img = augment(img, mode, seed=200 + i)
        payload = {
            "imageBase64": b64(img),
            "template": tpl,
            "answerKey": key,
            "marksMap": {str(q["number"]): 1 for q in tpl["questions"]},
            "debug": False,
        }
        try:
            res = http_post_json(f"{ENGINE}/process", payload)
        except Exception as e:  # noqa: BLE001
            print(f"{mode:<12} EXC  {e}")
            failures.append(mode)
            continue
        ev = evaluate(res, answers, sid)
        if mode == "crop45":
            # pathological input: success = clean failure (ok=False) or a
            # fully-unanswered read; FAILURE = confident wrong grades
            clean_fail = (not ev["ok"]) or (ev["correct"] + ev["wrong"] == 0)
            print(f"{mode:<12} {'CLEAN-FAIL' if clean_fail else 'GARBAGE!':<10} {'—':>6}   {'—':>5}  {'' if clean_fail else 'WRONG GRADES PRODUCED'}")
            continue
        total_q += n
        total_correct += ev["correct"]
        note = ""
        if not ev["ok"]:
            note = f"stage={ev['stage']} err={str(ev['error'])[:60]}"
        elif ev["wrongDetail"]:
            note = f"wrong: {ev['wrongDetail'][:2]}"
        print(f"{mode:<12} {str(ev['ok']):<5} {ev['correct']}/{n}   {'Y' if ev['sidOk'] else 'N:'+ev['gotSid']}  {note}")
        if ev["correct"] < n or not ev["sidOk"]:
            failures.append(mode)

    print(f"\nTOTAL per-question accuracy (auto-accepted subset vs all): {total_correct}/{total_q}")
    print("failing modes:", failures or "none")
    json.dump({"answers": answers, "sid": sid, "key": key}, open("/tmp/omr-bench/ground_truth.json", "w"))


if __name__ == "__main__":
    sys.exit(main())
