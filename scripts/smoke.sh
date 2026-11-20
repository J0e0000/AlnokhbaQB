#!/usr/bin/env bash
# ============================================================
# ALNOKHBA QB — post-deploy smoke test
#   BASE_URL=https://... APP_PASSWORD=... ./scripts/smoke.sh
# Covers: login → health → create exam → PATCH with a shape →
# publish → GET pdf → POST an OMR fixture to /api/scan.
# ============================================================
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
APP_PASSWORD="${APP_PASSWORD:?set APP_PASSWORD}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CJ="$(mktemp)"
FAILS=0

step() { printf '\n== %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; FAILS=$((FAILS+1)); }

jsonget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d$1'))" 2>/dev/null; }

step "1. login"
LOGIN_CODE=$(curl -s -o "$CJ.body" -w "%{http_code}" -c "$CJ" -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" -d "{\"password\":$(python3 -c 'import json,os;print(json.dumps(os.environ["APP_PASSWORD"]))')}")
[ "$LOGIN_CODE" = "200" ] && ok "login 200" || bad "login → $LOGIN_CODE"

step "2. /api/health"
HEALTH=$(curl -s -b "$CJ" "$BASE_URL/api/health")
echo "$HEALTH" | grep -q '"ok":true' && ok "health ok" || bad "health: $HEALTH"

step "3. create exam"
EXAM=$(curl -s -b "$CJ" -X POST "$BASE_URL/api/exams" -H "Content-Type: application/json" \
  -d '{"title":"SMOKE — يمكن حذفه","direction":"rtl"}')
EXAM_ID=$(echo "$EXAM" | jsonget "['id']" 2>/dev/null || true)
[ -n "$EXAM_ID" ] && ok "exam $EXAM_ID" || bad "create exam: $EXAM"

step "4. PATCH with a shape-bearing document"
DOC=$(python3 - "$EXAM_ID" <<'PY'
import json, sys
fixture = json.load(open("tests/omr-fixtures/document.json"))
fixture.setdefault("elements", []).append({
    "id": "smoke_shape_1", "page": 0, "type": "shape",
    "x": 10, "y": 10, "widthMm": 20, "heightMm": 10, "style": {},
    "content": {"shape": "rect", "fill": "transparent"},
})
print(json.dumps({"title": "SMOKE — يمكن حذفه", "document": fixture, "answerKey": {}}))
PY
)
PATCH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$CJ" -X PATCH "$BASE_URL/api/exams/$EXAM_ID" \
  -H "Content-Type: application/json" -d "$DOC")
[ "$PATCH_CODE" = "200" ] && ok "PATCH 200 (transparent shape accepted)" || bad "PATCH → $PATCH_CODE"

step "5. publish + GET pdf"
PUB=$(curl -s -b "$CJ" -X POST "$BASE_URL/api/exams/$EXAM_ID/publish" -H "Content-Type: application/json" -d '{}')
VERSION_ID=$(echo "$PUB" | jsonget "['version']['id']" 2>/dev/null || true)
[ -n "$VERSION_ID" ] && ok "published $VERSION_ID" || bad "publish: $PUB"
PDF_CODE=$(curl -s -b "$CJ" -o "$CJ.pdf" -w "%{http_code}" "$BASE_URL/api/exams/$EXAM_ID/pdf")
head -c 4 "$CJ.pdf" | grep -q "%PDF" && ok "pdf bytes (%PDF)" || bad "pdf → $PDF_CODE"

step "6. POST fixture sheet to /api/scan"
python3 - "$VERSION_ID" > "$CJ.scan" <<'PY'
import base64, json, sys
img = base64.b64encode(open("tests/omr-fixtures/blank_sheet_0.png", "rb").read()).decode()
print(json.dumps({"imageBase64": f"data:image/png;base64,{img}", "examVersionIdHint": sys.argv[1] or None}))
PY
SCAN_CODE=$(curl -s -o "$CJ.scanres" -w "%{http_code}" -b "$CJ" -X POST "$BASE_URL/api/scan" \
  -H "Content-Type: application/json" --data-binary "@$CJ.scan")
head -c 1 "$CJ.scanres" | grep -q "{" && ok "scan answered JSON (HTTP $SCAN_CODE)" || bad "scan → non-JSON (HTTP $SCAN_CODE)"
echo "$CJ.scanres" | head -c 160; echo

step "7. cleanup"
curl -s -b "$CJ" -X DELETE "$BASE_URL/api/exams/$EXAM_ID" > /dev/null && ok "smoke exam deleted" || bad "cleanup failed"

printf '\n=== SMOKE %s (%s failures) ===\n' "$([ "$FAILS" = 0 ] && echo PASS || echo FAIL)" "$FAILS"
exit "$FAILS"
