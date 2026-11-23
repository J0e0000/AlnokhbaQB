
## OMR / OCR facts worth remembering (verified 2025-11)

- The engine is a **separate Python service** (`omr-service/`, FastAPI + OpenCV
  4.10) declared in `vercel.json` under `services.omr-engine` and reached at
  `https://alnokhba-qb.vercel.app/api/omr/*`. `OMR_ENGINE_URL` points there.
- Sheet detection needs markers, a QR or the paper edge. `find_corner_markers`
  now runs three binarization passes; oblique phone photos that reported 0
  markers are detected.
- QR payloads in the wild: `ANQB|1|…` (current), `ANQB2|evid|tid|0|1|MAC` (v2,
  HMAC but the app never sends `qrSecret`, so it is accepted unverified) and
  the older unsigned `ANQB2|evid|tid|`. All three parse — do not "tighten"
  this without reprinting every sheet in circulation.
- The classic `cv2.QRCodeDetector` silently fails on the denser ANQB2 codes;
  `cv2.QRCodeDetectorAruco` is the fallback that saves them.
- Vercel functions have a **read-only filesystem**: preview JPEGs must be
  returned as data URLs (`decodeImage` fallback in `/api/scan`).
- **Sheet images**: `/api/scan` stores `debugImage`/`correctedImage` in
  `diagnosticsJson` — an `/api/scans/<id>/images/<kind>` URL when `db/scans/` is
  writable, a base64 data URL on Vercel. `GET /api/scans/:id` resolves them via
  `sheetImageUrl()` (`src/app/api/_lib/scan-images.ts`) and the review dialog
  renders them with `ScanSheetViewer`. Do not add `diagnosticsJson` to the
  `/api/scans` list query — it can hold a whole sheet per row.
- Failed scans keep their images too: the teacher must see what the engine
  rejected before re-photographing.
- `/api/scan` returns engine output under `diagnostics` (including `stages`),
  not at the top level — clients must read `diagnostics.stages`.
- Alignment order: 4 markers → markers+QR → QR only → full frame. With three
  markers the slot mapping is a guess, so a zero-mark result retries the
  QR-only homography (`alignRetry.how = "qr"`).
- A sheet that is detected but reads zero marks comes back `needsReview`
  (stored as scan status `REVIEW`) instead of a 409 — do not "fix" that back
  into an error.
- **Tables on a sheet** (`omr-service/engine/tables.py`): ruled grids of at
  least 2×2 cells are found on the warped page (a 1×1 "grid" is the page frame
  or a marker box — filtered). Cell text is read with tesseract when the host
  has it (one read per cell up to 20 cells; bigger grids are read one row at a
  time and the lost cells patched, because ~1s of process startup per cell
  would blow the 60s function budget); otherwise the engine returns a base64 `crop` and
  `resolveScanTables()` (`src/app/api/_lib/scan-tables.ts`) OCRs that crop once
  through the AI provider. The result lands in `diagnostics.tables` and the
  `tables` field of `POST /api/scan`, and `ScanSheetViewer` renders it under the
  sheet. Table extraction is best-effort: a failure must never fail the scan.
- Table cell OCR inherits the image: 1200 px-wide photos misread small cells,
  300 dpi scans read them correctly. A table baked into a pre-warped
  `correctedImage` fixture comes back rotated when the engine re-warps it — draw
  test tables on the raw photo or the sheet render, not on a stored corrected
  image.
- **OCR providers** (`src/lib/qb/ocr/engine.ts`), in order: Cloudflare Workers
  AI (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`), tesseract via the OMR
  service, z-ai VLM (sandbox only), OpenAI-compatible vision
  (`AI_API_KEY` + `AI_BASE_URL` + `AI_VISION_MODEL`). Vercel has **no
  tesseract binary**, so production OCR needs one of the two AI providers; the
  failure message now lists the ones that are unconfigured.
- `bun test` needs no env: `tests/version-hint.test.ts` defaults
  `DATABASE_URL` to `file:./db/dev-local.db`.
- Test fixtures: `tests/omr-fixtures/` (blank sheet 2481×3509 = A4@300dpi,
  template.json has bubble centres in mm). Prod sheets can be downloaded from
  `/api/versions/<id>/omr-png` and filled at `x_mm * width_px/210`.

## Fixed reusable answer sheets (exam-level, QR `ANQB3`)

- One printed sheet per exam, not per version: the template lives in
  `FixedSheet.dataJson` (`src/lib/qb/fixed-sheet.ts` → `FIXED_GEOMETRY`), the QR
  is `ANQB3|<examId>|F-<templateId>-r<N>|sheet|sheets|hash` and carries **no
  version** — the student shades the version row on the paper.
- Student identity has two channels: the shaded **ID grid** (10 rows × 6
  columns, authoritative, confidence 1.0) and the handwritten strip (OCR
  assist, fills only columns the grid left blank). `mergeIdentity()` in
  `src/app/api/_lib/fixed-scan.ts` does the merge; a grid+OCR disagreement is
  reported per column, never guessed.
- Engine side: `omr-service/engine/fixed.py` (`read_id_grid`, `read_id_boxes`)
  is wired in `pipeline.py` and returns `idGrid` / `handwrittenId` alongside
  `answers` / `version`.
- **Corner markers must own their corner.** They are 8 mm squares (BR 6 mm) with
  a 4 mm white halo. Anything printed within ~4 mm of a marker merges with it,
  the detector then slots a version bubble as a corner and the whole page warps
  into garbage (all answers read 0). Keep the title/QR/ID strip clear of them.
- **Engine imports inside `pipeline.py` must survive flat imports.** The harness
  imports the engine as top-level modules (`import pipeline`), so
  `from .qrpayload import …` raises ImportError there and — because
  `parse_qr_payload` swallows exceptions — silently turns every QR into
  "unreadable". Use `from engine.x import …` with a `from x import …` fallback.
- `build_homography()` can return a **2×3 affine**; `cv2.perspectiveTransform`
  then returns one coordinate per point. Promote to 3×3 before projecting.
- End-to-end acceptance test (renders the current revision, shades bubbles,
  writes digits, adds phone degradation, posts to `/api/scan`):
  `python3 tests/e2e-fixed-sheet.py --exam <examId>` — 12 scenarios, needs the
  app + engine running. It clears `Scan` rows first (duplicate detection would
  otherwise return a cached result for an identical image).
- Version-sheet regression suite: `python3 tests/omr-engine-harness.py`
  (24 cases, must stay 24/24).


<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
