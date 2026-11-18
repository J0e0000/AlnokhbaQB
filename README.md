# Alnokhba QB — exam platform + PDF toolkit + form scanner

One workspace, three feature sets, original code and UI throughout:

1. **QB platform** — question bank, exam designer, PDF engine (Chromium), OMR sheet
   generator + Python/OpenCV reader, online exams, assignments, review queue.
2. **PDF Tools (Pagewise)** — 32-tool online PDF toolkit (merge, split, compress,
   convert, sign, redact, OCR, AI…) embedded as a pane. Tier-1 tools run fully
   in-browser (pdf-lib + pdf.js); Tier-2 uses system binaries; AI streams via the
   server-side SDK key.
3. **Forms Scanner (قارئ النماذج)** — a general-purpose Markly-style answer-sheet /
   form scanner: draw OMR/OCR/barcode areas on a reference sheet, read batches of
   scans **entirely in the browser**, review flagged cells over the sheet image,
   grade against an answer key, and export CSV / Excel / PDF / clipboard / JSON.

## Run

```bash
bun install        # once
bun run db:push    # Prisma schema → SQLite
bun run db:seed    # demo users (admin@alnokhba.qb / Admin@2025)
bun scripts/seed-demo.ts   # optional demo exams
bun run dev        # http://localhost:3000
```

The Python OMR engine (used by the exam-bound Scanning pane) runs separately:

```bash
cd mini-services/omr-engine && bun run dev   # port 3032
```

## Forms Scanner — how it works

Step flow: **Load → Template → Read → Review & export** (bilingual AR/EN, RTL-ready).

- **Templates** are normalized-coordinate (0–1) documents: OMR grids (questions ×
  option labels, down-rows or across-columns, continuous numbering across areas),
  OCR regions (printed via in-browser Tesseract.js, or handwritten via a
  server-side vision model — only the region crop leaves the device), and
  BCR regions (QR first, then Code128/Code39/EAN/ITF/UPC via ZXing, with rotation
  and binarization retries). Save/load as JSON (file) or via
  `/api/form-templates` (Prisma + auth).
- **Alignment**: fiducial corner markers (solid squares) are matched inside local
  search windows; ≥3 markers → affine (exact solve), 4 → DLT homography, warped
  with bilinear sampling so one template works at any scan resolution and
  rotation (±3°+). No markers → projection-profile deskew fallback. Failures are
  flagged loudly, with an optional "read unaligned" override.
- **OMR reading**: 25% cell inset, per-grid median darkness baseline, adjustable
  sensitivity threshold (default 0.12), blank/multiple flags, lenient mode
  (clearly-darkest cell wins at ≥0.08 margin), per-answer confidence, low-confidence
  flags for review.
- **Review**: virtualizable table (40 rows/page), inline cell correction via
  keyboard-navigable selects, per-sheet image preview with detected marks
  highlighted (green marked / red multiple / amber low-confidence), flag summary.
- **Grading**: per-question answer key, weights, negative marking; per-sheet
  score/percentage; item analysis with percent-correct bars and answer
  distributions. Manual edits re-grade instantly.
- **Sheet generator**: printable PDFs (pdf-lib) with three corner fiducials, a QR
  sheet serial, name/date fields and bubble grids — emitting the **exact matching
  template JSON**, so printed sheets read back perfectly. A demo simulator
  fills random bubbles and applies rotation/noise/shadow degradations for
  end-to-end testing without a printer.
- **Field naming**: `file_name`, `BCR-<n>`, `OCR-<n>`, `OMR-<area>-<question>`.

## Forms scanner API

```
GET    /api/form-templates        # list (session required)
POST   /api/form-templates        # create (teacher+)
GET    /api/form-templates/:id    # full template JSON
PUT    /api/form-templates/:id    # update
DELETE /api/form-templates/:id    # delete
POST   /api/ai/transcribe         # { image: dataURL } → handwritten text (server-side vision model, never stored)
```

## Architecture map

```
src/lib/forms/         # FormScan engine (types, image, align, omr, bcr, ocr,
                       # pipeline, grading, exporters, sheet-generator, demo-sheets)
src/components/forms/  # FormsStudio + Load/Template/Read/Review steps + generator dialog
src/lib/pw/            # Pagewise toolkit (registry-driven: 32 tools)
src/components/pw/     # Pagewise UI (grid, workspace, custom editors)
src/lib/qb/            # QB canonical model, OMR template/render, grading
src/components/qb/     # QB panes (bank, designer, scanning, review, online…)
mini-services/omr-engine/  # Python OpenCV exam-OMR reader (port 3032)
```

## Privacy model

- Forms Scanner + Tier-1 PDF tools: **everything stays in the browser** — no
  upload, offline-capable after first load.
- Server-backed features (exam PDF engine, exam OMR scanning, AI) state clearly
  what leaves the device; job artifacts are deleted after download and at most
  one hour later; the AI keys never reach the client.
- No analytics on file contents.

## Originality

All branding, copy, layout and code in this repository are original. No
third-party UI, logos or assets are copied.
