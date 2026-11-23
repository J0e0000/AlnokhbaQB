
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
- Test fixtures: `tests/omr-fixtures/` (blank sheet 2481×3509 = A4@300dpi,
  template.json has bubble centres in mm). Prod sheets can be downloaded from
  `/api/versions/<id>/omr-png` and filled at `x_mm * width_px/210`.
