# E2E acceptance: fixed reusable answer sheet (printed sheet → student marks →
# POST /api/scan → identity + version + grade).
#
# The test is a simulated student: it renders the CURRENT fixed-sheet revision
# from the app, shades bubbles and writes digits the way a student would, adds
# phone-camera degradation, then posts the image to /api/scan and asserts the
# answer the app gives back.
#
# Usage:
#   python3 tests/e2e-fixed-sheet.py --exam <examId> [--base http://localhost:12000]
#   QB_EXAM_ID=<examId> python3 tests/e2e-fixed-sheet.py
#
# Requires a running app (and its OMR engine) plus an exam that has a published
# version with an answer key. The script reads the key from the API, so the
# expected scores are computed, not hard-coded.

import argparse
import base64
import hashlib
import hmac
import json
import pathlib
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
DB_FILE = ROOT / 'prisma/db/dev-local.db'
COOKIE = {'value': ''}


# ---------------------------------------------------------------- transport
def _env(key: str) -> str:
    if not ENV_FILE.exists():
        return ''
    m = re.search(rf'^{key}=(.*)$', ENV_FILE.read_text(), re.M)
    return m.group(1).strip().strip('"').strip("'") if m else ''


def session(base: str) -> None:
    """Mint the session cookie from SESSION_SECRET; the login endpoint is rate
    limited, so a test suite must never spend its attempts."""
    secret = _env('SESSION_SECRET')
    if secret:
        now = int(time.time())
        payload = json.dumps({'iat': now, 'exp': now + 3600}, separators=(',', ':')).encode()
        body = base64.urlsafe_b64encode(payload).decode().rstrip('=')
        sig = base64.urlsafe_b64encode(
            hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
        ).decode().rstrip('=')
        COOKIE['value'] = f'qb_session={body}.{sig}'
        return
    password = _env('APP_PASSWORD')
    req = urllib.request.Request(
        base + '/api/auth/login',
        data=json.dumps({'password': password}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    res = urllib.request.urlopen(req, timeout=60)
    COOKIE['value'] = '; '.join(
        c.split(';')[0] for c in (res.headers.get_all('Set-Cookie') or [])
    )


def _request(base: str, path: str, body=None, timeout=300):
    headers = {'Content-Type': 'application/json'}
    if COOKIE['value']:
        headers['Cookie'] = COOKIE['value']
    return urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
    )


def get(base, path):
    try:
        return json.loads(urllib.request.urlopen(_request(base, path), timeout=300).read())
    except urllib.error.HTTPError as exc:
        return {'_status': exc.code, '_body': exc.read().decode(errors='replace')[:400]}


def post(base, path, body):
    try:
        return json.loads(
            urllib.request.urlopen(_request(base, path, body), timeout=600).read()
        )
    except urllib.error.HTTPError as exc:
        return {'_status': exc.code, '_body': exc.read().decode(errors='replace')[:400]}


def raw(base, path):
    return urllib.request.urlopen(_request(base, path), timeout=300).read()


# ---------------------------------------------------------------- drawing
def _px(dpi: int) -> float:
    return dpi / 25.4


def _fill_bubble(img, x_mm, y_mm, r_mm, dpi, value=25):
    k = _px(dpi)
    cv2.circle(
        img,
        (int(round(x_mm * k)), int(round(y_mm * k))),
        int(round(r_mm * k * 0.82)),
        value,
        -1,
        cv2.LINE_AA,
    )


def _write_digit(img, digit, box, dpi, seed):
    rng = np.random.default_rng(seed)
    k = _px(dpi)
    pad = int(round(0.2 * k))
    x0, y0 = int(round(box['x'] * k)) + pad, int(round(box['y'] * k)) + pad
    w = int(round(box['w'] * k)) - 2 * pad
    h = int(round(box['h'] * k)) - 2 * pad
    layer = np.zeros((h, max(w, 1)), np.uint8)
    font, scale = cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 0.5
    while True:
        (tw, th), _ = cv2.getTextSize(digit, font, scale + 0.05, 2)
        if tw > w * 0.9 or th > h * 0.9:
            break
        scale += 0.05
    (tw, th), _ = cv2.getTextSize(digit, font, scale, 2)
    cv2.putText(
        layer, digit, ((layer.shape[1] - tw) // 2, (layer.shape[0] + th) // 2),
        font, scale, 255, 2, cv2.LINE_AA,
    )
    m = cv2.getRotationMatrix2D((layer.shape[1] / 2, layer.shape[0] / 2), float(rng.uniform(-6, 6)), 1)
    layer = cv2.warpAffine(layer, m, (layer.shape[1], layer.shape[0]))
    view = img[y0 : y0 + layer.shape[0], x0 : x0 + layer.shape[1]]
    view[layer > 60] = 20


def build_sheet(blank_path, template, digits, version, answers, dpi=300, grid=True, handwriting=True):
    img = cv2.imread(str(blank_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise SystemExit(f'blank render missing: {blank_path}')

    if handwriting:
        for i, box in enumerate(template['idBoxes']['boxes']):
            _write_digit(img, digits[i], box, dpi, seed=i + 11)

    if grid:
        for col in template['idGrid'].columns if hasattr(template['idGrid'], 'columns') else template['idGrid']['columns']:
            order = col['digitOrder']
            digit = digits[col['index']]
            if digit == '?':
                continue
            _fill_bubble(
                img,
                col['xMm'],
                col['yTopMm'] + order.index(int(digit)) * template['idGrid']['pitchYMm'],
                template['idGrid']['radiusMm'],
                dpi,
            )

    if version:
        vm = template['versionMarks']
        for letter in version:
            _fill_bubble(img, vm['xsMm'][vm['letters'].index(letter)], vm['yMm'], vm['bubbleRMm'], dpi)

    for question in template['questions']:
        choice = answers.get(str(question['number']))
        if choice:
            opt = question['options'][choice]
            _fill_bubble(img, opt['x'], opt['y'], question['radiusMm'], dpi)
    return img


def degrade(img, margin_mm=8, rotate=0.0, blur=0, jpeg=0, shade=False, seed=3):
    h, w = img.shape
    pad = int(round(margin_mm * _px(300)))
    canvas = np.full((h + 2 * pad, w + 2 * pad), 235, np.uint8)
    canvas[pad : pad + h, pad : pad + w] = img
    if rotate:
        m = cv2.getRotationMatrix2D((canvas.shape[1] / 2, canvas.shape[0] / 2), rotate, 1.0)
        canvas = cv2.warpAffine(canvas, m, (canvas.shape[1], canvas.shape[0]), borderValue=235)
    if shade:
        rng = np.random.default_rng(seed)
        yy, xx = np.mgrid[0 : canvas.shape[0], 0 : canvas.shape[1]]
        glow = 1.0 - 0.35 * (((xx / canvas.shape[1] - 0.15) ** 2 + (yy / canvas.shape[0] - 0.1) ** 2))
        canvas = np.clip(canvas.astype(np.float32) * glow, 0, 255)
        canvas = np.clip(canvas + rng.normal(0, 2.5, canvas.shape), 0, 255).astype(np.uint8)
    if blur:
        canvas = cv2.GaussianBlur(canvas, (blur | 1, blur | 1), 0)
    if jpeg:
        ok, buf = cv2.imencode('.jpg', canvas, [cv2.IMWRITE_JPEG_QUALITY, jpeg])
        canvas = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
    return canvas


def scan(base, img, mime='png', quality=95):
    if mime == 'jpeg':
        ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    else:
        ok, buf = cv2.imencode('.png', img)
    payload = 'data:image/%s;base64,%s' % (mime, base64.b64encode(buf.tobytes()).decode())
    return post(base, '/api/scan', {'imageBase64': payload})


# ---------------------------------------------------------------- harness
class Case:
    def __init__(self, name, expect):
        self.name = name
        self.expect = expect
        self.failures = []

    def check(self, label, actual, expected):
        if actual != expected:
            self.failures.append(f'{label}: expected {expected!r}, got {actual!r}')


def answer_key(exam_id):
    """Ground truth for the assertions. The published key has no GET route
    (only PATCH), and grading uses the same row, so read it from the DB."""
    if not DB_FILE.exists():
        return {}
    con = sqlite3.connect(DB_FILE)
    out = {}
    for version, payload in con.execute(
        'select version, answerKeyJson from ExamVersion where examId = ?', (exam_id,)
    ):
        try:
            key = json.loads(payload or '{}')
        except json.JSONDecodeError:
            continue
        if isinstance(key, dict) and key:
            out[int(version)] = {str(k): v for k, v in key.items()}
    con.close()
    return out


def clear_scans():
    if not DB_FILE.exists():
        return False
    try:
        con = sqlite3.connect(DB_FILE)
        con.execute('delete from Scan')
        con.commit()
        con.close()
        return True
    except sqlite3.Error:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='http://localhost:12000')
    parser.add_argument('--exam', default='')
    parser.add_argument('--keep', action='store_true', help='keep previous scans')
    args = parser.parse_args()
    exam = args.exam or __import__('os').environ.get('QB_EXAM_ID', '')
    if not exam:
        raise SystemExit('pass --exam <examId> (or QB_EXAM_ID)')

    session(args.base)
    if not args.keep and not clear_scans():
        print('! could not clear Scan rows — duplicate detection may fire')

    created = post(args.base, f'/api/exams/{exam}/fixed-sheet', {})
    if 'id' not in created:
        raise SystemExit(f'cannot create fixed sheet: {created}')
    sheet_id = created['id']
    print(f'fixed sheet revision {created["revision"]} ({created["templateId"]})')

    blank = pathlib.Path('/tmp/qb-e2e-blank-300.png')
    blank.write_bytes(raw(args.base, f'/api/fixed-sheets/{sheet_id}/png?sheet=0&dpi=300'))
    template = get(args.base, f'/api/exams/{exam}/fixed-sheet')['current']['template']

    keys = answer_key(exam)
    version_number = 2 if 2 in keys else sorted(keys)[0]
    key = {int(''.join(ch for ch in q if ch.isdigit())): a for q, a in keys[version_number].items()}
    letter = template['versionMarks']['letters'][version_number - 1]
    print(f'grading against version {version_number} ({letter}), {len(key)} keyed questions')

    digits = '314159'
    right = {str(q): a for q, a in key.items()}
    wrong = {str(k): ('A' if v != 'A' else 'B') for k, v in key.items()}
    expected_score = sum(1 for q, a in right.items() if a == key[int(q)])

    cases = []

    # 1 — full correct sheet, grid + handwriting (the normal path)
    img = build_sheet(blank, template, digits, letter, right)
    res = scan(args.base, degrade(img))
    c = Case('grid+handwriting', res)
    c.check('status', res.get('status'), 'PROCESSED')
    c.check('needsReview', res.get('needsReview'), False)
    c.check('identity.source', (res.get('identity') or {}).get('source'), 'grid')
    c.check('identity.confirmed', (res.get('identity') or {}).get('confirmed'), True)
    c.check('studentCode', res.get('studentCode'), digits)
    c.check('version', (res.get('versionRead') or {}).get('value'), version_number)
    c.check('score', (res.get('grade') or {}).get('score'), expected_score)
    cases.append(c)

    # 2 — grid only, nothing handwritten
    img = build_sheet(blank, template, digits, letter, right, handwriting=False)
    res = scan(args.base, degrade(img, seed=4))
    c = Case('grid only', res)
    c.check('status', res.get('status'), 'PROCESSED')
    c.check('identity.source', (res.get('identity') or {}).get('source'), 'grid')
    c.check('studentCode', res.get('studentCode'), digits)
    cases.append(c)

    # 3 — handwriting only (grid left blank): OCR assist must carry it
    img = build_sheet(blank, template, digits, letter, right, grid=False)
    res = scan(args.base, degrade(img, seed=5))
    c = Case('handwriting only', res)
    c.check('identity.source', (res.get('identity') or {}).get('source'), 'ocr')
    c.check('identity.digits', (res.get('identity') or {}).get('digits'), digits)
    cases.append(c)

    # 4 — one grid column left blank, handwriting present → mixed merge
    img = build_sheet(blank, template, digits, letter, right, grid=True)
    col3 = template['idGrid']['columns'][3]
    k = _px(300)
    cv2.rectangle(
        img,
        (int((col3['xMm'] - 2.6) * k), int((col3['yTopMm'] - 2.6) * k)),
        (int((col3['xMm'] + 2.6) * k), int((col3['yTopMm'] + 9 * template['idGrid']['pitchYMm'] + 2.6) * k)),
        250,
        -1,
    )
    res = scan(args.base, degrade(img, seed=6))
    c = Case('partial grid + handwriting', res)
    c.check('identity.source', (res.get('identity') or {}).get('source'), 'mixed')
    c.check('identity.digits', (res.get('identity') or {}).get('digits'), digits)
    cases.append(c)

    # 5 — all-wrong answers: score must be 0
    img = build_sheet(blank, template, digits, letter, wrong)
    res = scan(args.base, degrade(img, seed=7))
    c = Case('wrong answers', res)
    c.check('score', (res.get('grade') or {}).get('score'), 0)
    cases.append(c)

    # 6 — no version shaded → review, never guessed
    img = build_sheet(blank, template, digits, '', right)
    res = scan(args.base, degrade(img, seed=8))
    c = Case('version blank', res)
    c.check('status', res.get('status'), 'REVIEW')
    c.check('has versionBlank', 'versionBlank' in (res.get('flags') or []), True)
    cases.append(c)

    # 7 — two versions shaded → review
    img = build_sheet(blank, template, digits, letter + 'A' if letter != 'A' else 'AB', right)
    res = scan(args.base, degrade(img, seed=9))
    c = Case('version ambiguous', res)
    c.check('status', res.get('status'), 'REVIEW')
    c.check('has versionMultiple', 'versionMultiple' in (res.get('flags') or []), True)
    cases.append(c)

    # 8 — ID that is not on the roster
    img = build_sheet(blank, template, '999999', letter, right, handwriting=False)
    res = scan(args.base, degrade(img, seed=10))
    c = Case('unknown student', res)
    c.check('status', res.get('status'), 'REVIEW')
    c.check('has idNotInRoster', 'idNotInRoster' in (res.get('flags') or []), True)
    cases.append(c)

    # 9 — sheet photographed upside down
    img = build_sheet(blank, template, digits, letter, right)
    res = scan(args.base, degrade(cv2.rotate(img, cv2.ROTATE_180), seed=11))
    c = Case('rotated 180', res)
    c.check('status', res.get('status'), 'PROCESSED')
    c.check('score', (res.get('grade') or {}).get('score'), expected_score)
    c.check('identity.digits', (res.get('identity') or {}).get('digits'), digits)
    cases.append(c)

    # 10 — phone photo: tilt, blur, shadow, JPEG
    res = scan(
        args.base,
        degrade(img, rotate=2.5, blur=3, shade=True, seed=12),
        mime='jpeg',
        quality=62,
    )
    c = Case('phone (tilt+blur+shadow+JPEG)', res)
    c.check('status', res.get('status'), 'PROCESSED')
    c.check('score', (res.get('grade') or {}).get('score'), expected_score)
    cases.append(c)

    # 11 — same file uploaded twice → idempotent
    first = scan(args.base, degrade(build_sheet(blank, template, digits, letter, right), seed=13))
    again = scan(args.base, degrade(build_sheet(blank, template, digits, letter, right), seed=13))
    c = Case('duplicate upload', again)
    c.check('duplicate', again.get('duplicate'), True)
    c.check('same scanId', again.get('scanId'), first.get('scanId'))
    cases.append(c)

    # 12 — blank sheet: nothing shaded
    img = build_sheet(blank, template, digits, '', {}, grid=False, handwriting=False)
    res = scan(args.base, degrade(img, seed=14))
    c = Case('blank sheet', res)
    c.check('status', res.get('status'), 'REVIEW')
    c.check('all unanswered', all(a['status'] == 'unanswered' for a in res.get('answers') or []), True)
    cases.append(c)

    failed = 0
    print()
    for case in cases:
        ok = not case.failures
        failed += 0 if ok else 1
        print(f'[{"PASS" if ok else "FAIL"}] {case.name}')
        for line in case.failures:
            print(f'        {line}')
    print(f'\n{len(cases) - failed}/{len(cases)} scenarios passed')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
