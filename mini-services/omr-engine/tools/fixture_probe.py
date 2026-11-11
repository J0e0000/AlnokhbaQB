"""Diagnostic probe: verifies fixture geometry assumptions for the OMR engine.

Checks (against tests/omr-fixtures/blank_sheet_0.png + template.json):
  - image dimensions and px/mm scale
  - QR decode (full page and cropped/upscaled) + payload checksum
  - marker blobs (solid black squares) detectability
  - printed bubble rings at canonical mm coordinates
Run: /home/z/.venv/bin/python3 tools/fixture_probe.py
"""
import cv2
import hashlib
import json
import os
import sys

import numpy as np

FIXTURES = "/home/z/my-project/tests/omr-fixtures"


def main() -> None:
    img = cv2.imread(os.path.join(FIXTURES, "blank_sheet_0.png"))
    assert img is not None, "fixture not found"
    print("shape", img.shape)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sx = img.shape[1] / 210.0
    sy = img.shape[0] / 297.0
    print("px_per_mm", round(sx, 4), round(sy, 4))

    tpl = json.load(open(os.path.join(FIXTURES, "template.json")))

    qd = cv2.QRCodeDetector()
    data, pts, _ = qd.detectAndDecode(gray)
    print("QR full:", repr(data))

    # QR crop region 20..46mm
    x0, y0, x1, y1 = int(20 * sx), int(20 * sy), int(46 * sx), int(46 * sy)
    crop = gray[y0:y1, x0:x1]
    for up in (1, 2, 3):
        c = cv2.resize(crop, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC) if up > 1 else crop
        d2, _, _ = qd.detectAndDecode(c)
        if d2:
            print("QR crop up", up, repr(d2))
            break

    evid = tpl["examVersionId"]
    tid = tpl["templateId"]
    chk = hashlib.sha256(f"{evid}|{tid}|0".encode()).hexdigest()[:8].upper()
    print("chk computed", chk, "expected", tpl["qr"]["payloadBySheet"][0].split("|")[-1])

    t, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    print("otsu t =", t)
    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    print("n contours", len(cnts))
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:10]:
        x, y, w, h = cv2.boundingRect(c)
        a = cv2.contourArea(c)
        hull = cv2.convexHull(c)
        print(
            "blob x,y,w,h,area,rect,solid",
            x, y, w, h, int(a),
            round(a / (w * h), 3), round(a / max(1, cv2.contourArea(hull)), 3),
        )

    # ring presence at Q1 options (y=112mm), from template
    q1 = tpl["questions"][0]
    for letter, pos in q1["options"].items():
        cx, cy = int(pos["x"] * sx), int(pos["y"] * sy)
        sub = gray[cy - 30:cy + 30, cx - 30:cx + 30]
        print("Q1", letter, "center px", (cx, cy), "darkpx<128", int((sub < 128).sum()), "centerval", int(gray[cy, cx]))

    # student id bubble ring at first digit/value
    sid = tpl["studentId"]
    cx, cy = int(sid["digitColumnXs"][0] * sx), int(sid["valueYs"][0] * sy)
    sub = gray[cy - 20:cy + 20, cx - 20:cx + 20]
    print("SID first bubble darkpx<128", int((sub < 128).sum()))

    # marker centers expected in px
    for m in tpl["markers"]:
        print("marker", m["id"], "mm", (m["x"], m["y"]), "-> px", round(m["x"] * sx, 1), round(m["y"] * sy, 1))

    print(
        "gray mean/p1/p50/p99",
        round(float(gray.mean()), 1),
        float(np.percentile(gray, 1)),
        float(np.percentile(gray, 50)),
        float(np.percentile(gray, 99)),
    )


if __name__ == "__main__":
    sys.exit(main())
