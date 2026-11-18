#!/usr/bin/env python3
"""OMR accuracy harness: simulate filled + degraded sheets, measure engine accuracy.

Simulates the real user flow: print (omr-png) → fill with pen/pencil →
phone photo (rotation/perspective/shadows/noise/JPEG) → engine /process.
Reports per-scenario accuracy vs ground truth.
"""
import base64
import io
import json
import math
import random
import sys
import urllib.request

import cv2
import numpy as np

API = "http://127.0.0.1:3032"
QR_SECRET = "anqb-dev-qr-secret-do-not-use-in-prod"

random.seed(42)


def http_post_json(url: str, payload: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def http_get(url: str, timeout: int = 60):
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return res.read()


def b64_of_png(img) -> str:
    ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf.tobytes()).decode()


def b64_of_jpeg(img, quality: int) -> str:
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    return base64.b64encode(buf.tobytes()).decode()


def fill_bubble(img, x_mm, y_mm, r_mm, ppx, style, rng):
    """Draw a realistic filled bubble. style: pen | pencil | faint | partial."""
    cx = x_mm * ppx
    cy = y_mm * ppx
    r = r_mm * ppx * 0.92
    overlay = img  # direct draw
    if style == "pen":
        color, alpha, blur = (30, 30, 35), 0.95, 0
    elif style == "pencil":
        color, alpha, blur = (85, 85, 90), 0.88, 1
    elif style == "faint":
        color, alpha, blur = (150, 150, 155), 0.75, 1
    else:  # partial — a stroke that covers ~60% of the bubble
        color, alpha, blur = (70, 70, 75), 0.85, 0
    if style == "partial":
        # draw a chord/patch covering part of the disc
        pts = np.array([[cx - r * 0.8, cy - r * 0.3], [cx + r * 0.8, cy - r * 0.5],
                        [cx + r * 0.6, cy + r * 0.7], [cx - r * 0.9, cy + r * 0.8]], np.int32)
        cv2.fillPoly(overlay, [pts], color)
        return
    if blur:
        # draw on a temp layer then blur (pencil texture)
        layer = np.full(img.shape, 255, np.uint8)
        cv2.circle(layer, (int(cx), int(cy)), int(r), color, -1)
        layer = cv2.GaussianBlur(layer, (3, 3), blur)
        # grainy pencil: add speckle holes
        mask = layer < 200
        noise = rng.random(layer.shape[:2])
        holes = mask & (noise > 0.72)
        layer[holes] = 235
        img[layer < 245] = np.minimum(img[layer < 245], layer[layer < 245])
        return
    # pen: solid with slight jitter ellipse
    jitter = rng.normal(0, 0.4, 2)
    cv2.ellipse(img, (int(cx + jitter[0]), int(cy + jitter[1])),
                (int(r), int(r * rng.uniform(0.94, 1.03))),
                rng.uniform(-8, 8), 0, 360, color, -1)


def degrade(img, rng, rot_deg, perspective, shadow, jpeg_q):
    h, w = img.shape[:2]
    out = img.copy()
    # shadow gradient (uneven lighting)
    if shadow:
        gx = rng.uniform(-1, 1)
        gy = rng.uniform(-1, 1)
        xx, yy = np.meshgrid(np.arange(w), np.arange(h))
        grad = (xx / w - 0.5) * gx * 0.35 + (yy / h - 0.5) * gy * 0.35
        shade = 1.0 + grad * 0.28
        out = np.clip(out.astype(np.float32) * shade, 0, 255).astype(np.uint8)
    if perspective:
        # mild perspective: pull TR corner inward
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dx = w * rng.uniform(0.02, 0.05)
        dy = h * rng.uniform(0.015, 0.04)
        dst = np.float32([[-dx * 0.3, -dy * 0.3], [w - dx, dy * 0.5],
                          [w - dx * 0.2, h - dy], [-dx * 0.4, h - dy * 0.2]])
        M = cv2.getPerspectiveTransform(src, dst)
        out = cv2.warpPerspective(out, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=255)
    if abs(rot_deg) > 0.05:
        center = (w / 2, h / 2)
        M = cv2.getRotationMatrix2D(center, rot_deg, 1.0)
        cos_v, sin_v = abs(M[0, 0]), abs(M[0, 1])
        nw = int(h * sin_v + w * cos_v) + 1
        nh = int(h * cos_v + w * sin_v) + 1
        M[0, 2] += nw / 2 - center[0]
        M[1, 2] += nh / 2 - center[1]
        out = cv2.warpAffine(out, M, (nw, nh), flags=cv2.INTER_LINEAR, borderValue=255)
    # speckle noise
    n = int(w * h * 0.0006)
    for _ in range(n):
        x, y = rng.integers(0, w), rng.integers(0, h)
        out[y, x] = rng.choice([90, 120, 200, 230])
    return out


def run_scenario(name, base_img, template, truth, key, rng, rot=0.0, perspective=False,
                 shadow=False, jpeg_q=None, style_mix=None):
    img = base_img.copy()
    ppx = 300 / 25.4
    styles = style_mix or {}
    for (x, y, r, style) in fill_specs:
        st = styles.get(style, style)
        fill_bubble(img, x, y, r, ppx, st, rng)
    img = degrade(img, rng, rot, perspective, shadow, jpeg_q)
    if jpeg_q:
        b64 = b64_of_jpeg(img, jpeg_q)
    else:
        b64 = b64_of_png(img)
    payload = {
        "imageBase64": b64,
        "template": template,
        "answerKey": key,
        "qrSecret": QR_SECRET,
        "debug": False,
    }
    res = http_post_json(f"{API}/process", payload)
    if not res.get("ok"):
        return {"scenario": name, "ok": False, "error": res.get("error"), "stage": res.get("stage")}
    answers = {a["number"]: a for a in res["answers"]}
    correct = wrong = unclear = multiple = blank = 0
    details_wrong = []
    for qn, expected in truth.items():
        a = answers.get(qn)
        if not a:
            blank += 1
            continue
        st = a["status"]
        if st == "selected":
            if a["detected"] == expected:
                correct += 1
            else:
                wrong += 1
                details_wrong.append((qn, expected, a["detected"], round(a["confidence"], 2)))
        elif st == "unclear":
            unclear += 1
        elif st == "multiple":
            multiple += 1
        else:
            blank += 1
    grade = res.get("grade") or {}
    th = res.get("diagnostics", {}).get("thresholdsUsed", {})
    unclear_qs = [qn for qn, expected in truth.items()
                  if qn in answers and answers[qn]["status"] == "unclear"]
    return {
        "scenario": name, "ok": True,
        "correct": correct, "wrong": wrong, "unclear": unclear,
        "multiple": multiple, "blank": blank,
        "accuracy": round(correct / len(truth) * 100, 1),
        "resolved": round((correct + wrong) / len(truth) * 100, 1),
        "gradePercent": grade.get("percent"),
        "wrongDetail": details_wrong[:6],
        "unclearQs": unclear_qs,
        "thresholds": {k: round(v, 3) for k, v in th.items() if isinstance(v, (int, float))},
        "warnings": len(res.get("diagnostics", {}).get("warnings", [])),
        "ms": res.get("processingMs"),
    }


if __name__ == "__main__":
    # 1. fetch sheet + template
    ver = "cmwme7tme0006qpxzanbbxs06"
    cookie = open("/tmp/cookie_val.txt").read().strip() if len(sys.argv) > 1 else None
    import subprocess
    tmpl_json = subprocess.run(
        ["curl", "-s", "-b", "/tmp/cookies_local.txt",
         f"http://localhost:3000/api/versions/{ver}/omr-template"],
        capture_output=True, text=True).stdout
    template = json.loads(tmpl_json)
    png_bytes = subprocess.run(
        ["curl", "-s", "-b", "/tmp/cookies_local.txt",
         f"http://localhost:3000/api/versions/{ver}/omr-png?sheet=0&dpi=300"],
        capture_output=True).stdout
    base = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_GRAYSCALE)
    print(f"sheet: {base.shape[1]}x{base.shape[0]}")

    # 2. ground truth + fill specs
    key = {"1": "A", "2": "B", "3": "C", "4": "D", "5": "A",
           "6": "B", "7": "C", "8": "D", "9": "A", "10": "B"}
    truth = {int(k): v for k, v in key.items()}
    qmap = {}
    for q in template["questions"]:
        qmap[q["number"]] = q
    fill_specs = []
    for qn, letter in truth.items():
        pos = qmap[qn]["options"][letter]
        r = qmap[qn]["radiusMm"]
        style = random.choice(["pen", "pen", "pen", "pencil", "pencil", "faint", "partial"])
        fill_specs.append((pos["x"], pos["y"], r, style))
    print("truth:", truth)

    rng = np.random.default_rng(7)
    scenarios = [
        ("clean-scan", dict(rot=0, perspective=False, shadow=False)),
        ("rot-1deg", dict(rot=1.0)),
        ("rot-3deg", dict(rot=3.0)),
        ("perspective", dict(perspective=True)),
        ("shadow", dict(shadow=True)),
        ("jpeg-70", dict(jpeg_q=70)),
        ("rot2+jpeg75", dict(rot=2.0, jpeg_q=75)),
        ("all-mild", dict(rot=2.0, perspective=True, shadow=True, jpeg_q=80)),
        ("all-strong", dict(rot=3.5, perspective=True, shadow=True, jpeg_q=60)),
    ]
    results = []
    for name, kw in scenarios:
        r = run_scenario(name, base, template, truth, key, rng, **kw)
        results.append(r)
        if r.get("ok"):
            print(f"{name:14s} acc={r['accuracy']:5.1f}% resolved={r['resolved']:5.1f}% "
                  f"correct={r['correct']} wrong={r['wrong']} unclear={r['unclear']} "
                  f"multi={r['multiple']} blank={r['blank']} ms={r['ms']} "
                  f"th(filled={r['thresholds'].get('filled')}, empty={r['thresholds'].get('empty')}) "
                  f"unclearQ={r['unclearQs']}")
            if r["wrongDetail"]:
                print("   wrong:", r["wrongDetail"])
        else:
            print(f"{name:14s} FAILED stage={r.get('stage')}: {r.get('error')}")

    # deep dive: per-question ratios on the clean scan
    print("\n--- clean-scan per-question ratios ---")
    img = base.copy()
    ppx = 300 / 25.4
    for (x, y, r, style) in fill_specs:
        fill_bubble(img, x, y, r, ppx, style, rng)
    b64 = b64_of_png(img)
    res = http_post_json(f"{API}/process", {"imageBase64": b64, "template": template,
                                            "answerKey": key, "qrSecret": QR_SECRET})
    for qn in sorted(truth):
        a = next(a for a in res["answers"] if a["number"] == qn)
        fs = next((f for f in fill_specs if qmap[qn]["options"][truth[qn]]["x"] == f[0]
                   and qmap[qn]["options"][truth[qn]]["y"] == f[1]), None)
        style = fs[3] if fs else "?"
        print(f"Q{qn:2d} truth={truth[qn]} style={style:8s} status={a['status']:10s} "
              f"det={a['detected']} conf={a['confidence']:.2f} ratios={a['ratios']}")

    # 3. repeatability: run clean + worst 3x each
    print("\n--- stability (3 runs of all-mild with different seeds) ---")
    for s in range(3):
        r = run_scenario(f"all-mild-{s}", base, template, truth, key,
                         np.random.default_rng(100 + s),
                         rot=2.0, perspective=True, shadow=True, jpeg_q=80)
        print(f"run{s}: acc={r['accuracy']}% wrong={r['wrong']} unclear={r['unclear']} multi={r['multiple']}")
