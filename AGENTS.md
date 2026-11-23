
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
- `/api/scan` returns engine output under `diagnostics` (including `stages`),
  not at the top level — clients must read `diagnostics.stages`.
- Alignment order: 4 markers → markers+QR → QR only → full frame. With three
  markers the slot mapping is a guess, so a zero-mark result retries the
  QR-only homography (`alignRetry.how = "qr"`).
- A sheet that is detected but reads zero marks comes back `needsReview`
  (stored as scan status `REVIEW`) instead of a 409 — do not "fix" that back
  into an error.
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

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
