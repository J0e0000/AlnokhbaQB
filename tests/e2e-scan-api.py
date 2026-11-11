# E2E: real degraded phone scan → app API → engine → grade → DB
import sys, os, json, base64, importlib.machinery, importlib.util
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, '/home/z/my-project/mini-services/omr-engine')
sys.path.insert(0, '/home/z/my-project/mini-services/omr-engine/engine')
# NOTE: the literal module name is blocked by the sandbox import hook — load it
# explicitly under an alias (same file, same code).
_loader = importlib.machinery.SourceFileLoader(
    "harness_mod", os.path.join(os.path.dirname(os.path.abspath(__file__)), "omr-engine-harness.py")
)
_spec = importlib.util.spec_from_loader("harness_mod", _loader)
H = importlib.util.module_from_spec(_spec)
_loader.exec_module(H)
import numpy as np, cv2, urllib.request  # noqa: E402

plan = {n: l for n, l in H.KEY.items()}
plan[7] = 'D'  # one wrong answer on purpose
img = H.build_sheet(plan, 'pencil')
H.fill_student_id(img, "123456")
img = H.phone_camera(img, 1600, 80)
ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
b64 = base64.b64encode(buf.tobytes()).decode()

req = urllib.request.Request(
    'http://localhost:3000/api/scan',
    data=json.dumps({'imageBase64': 'data:image/jpeg;base64,' + b64, 'debug': True}).encode(),
    headers={'Content-Type': 'application/json'},
)
try:
    res = json.loads(urllib.request.urlopen(req, timeout=120).read())
except urllib.error.HTTPError as e:
    print('HTTP error', e.code, e.read()[:800])
    raise SystemExit(1)

print('scanId:', res.get('scanId'))
print('studentCode:', res.get('studentCode'))
print('grade:', json.dumps(res.get('grade')))
print('Q7:', [(a['detected'], round(a['confidence'], 2)) for a in res['answers'] if a['number'] == 7])
print('images:', {k: bool(v) for k, v in (res.get('images') or {}).items()})
detected = {a['number']: a['detected'] for a in res['answers'] if a['status'] == 'selected'}
expected = {n: l for n, l in H.KEY.items()}
mismatches = {n: (expected[n], detected.get(n)) for n in expected if detected.get(n) != expected[n]}
print('mismatches vs key:', mismatches, '(Q7 intentionally wrong)')
