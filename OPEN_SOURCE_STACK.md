# ALNOKHBA QB — Open-Source Stack

> **Deliverable**: research → selection → real installation → integration → verification for every
> open-source component the platform relies on. Last verified: 2026-10-31 (see §7 for the raw
> verification transcript).

Alnokhba QB deliberately **does not reinvent** existing technology: PDF viewing, PDF manipulation,
OCR, OMR computer vision, QR codes, PDF printing and Arabic typography are all delegated to
battle-tested open-source projects behind thin, typed adapters. This document lists **what is
actually installed and running** (not aspirations), what was **evaluated and rejected/deferred with
reasons**, and **how to install/update each piece**.

License policy: permissive licenses only (Apache-2.0 / MIT / BSD) for runtime code. AGPL/GPL
projects are either avoided or confined to dev/test tooling, never shipped or linked into the
product runtime.

---

## 1. Master table

| Component | Selected project | GitHub / source | License | Integration status |
|---|---|---|---|---|
| **OCR (English)** | Tesseract OCR 5 + `eng.traineddata` | https://github.com/tesseract-ocr/tesseract | Apache-2.0 | ✅ **Integrated** (runtime, system binary `tesseract 5.5.0`, engine `mini-services/omr-engine/engine/ocr.py`) |
| **OCR (Arabic)** | Tesseract + `ara.traineddata` (tessdata_fast) | https://github.com/tesseract-ocr/tessdata_fast | Apache-2.0 | ✅ **Integrated** (bundled in `mini-services/omr-engine/tessdata/ara.traineddata`, mixed `ara+eng` pass, word-confidence via TSV) |
| **OCR (Arabic, high-accuracy escalation)** | z-ai VLM (vision-language model) | bundled SDK `z-ai-web-dev-sdk` (service-side only) | proprietary service, no weights shipped | ✅ **Integrated** — automatic escalation when Tesseract self-confidence < 0.6 |
| **OMR (bubble-sheet reading)** | OpenCV (`opencv-python-headless`) 4.13 | https://github.com/opencv/opencv-python | Apache-2.0 | ✅ **Integrated** — custom engine `mini-services/omr-engine/` (marker homography, flat-field normalisation, adaptive-threshold fill analysis, ambiguity flags) |
| **OMR technique reference** | OMRChecker | https://github.com/Udayraj123/OMRChecker | MIT | ◐ **Evaluated — technique-level adoption** (not vendored; reason in §3) |
| **PDF viewing / rendering (client)** | PDF.js (`pdfjs-dist`) 6.4 | https://github.com/mozilla/pdf.js | Apache-2.0 | ✅ **Integrated** — `src/components/qb/PdfWorkspace.tsx` (thumbnails, zoom, page canvas rendering, worker `public/pdf.worker.min.mjs`) |
| **PDF editing / page ops** | pdf-lib 1.17 | https://github.com/Hopding/pdf-lib | MIT | ✅ **Integrated** — vector-preserving rotate/delete/reorder/export from original bytes (`PdfWorkspace.tsx`), whiteboard PNG→PDF (`Whiteboard.tsx`) |
| **PDF generation (print engine)** | Chromium via `puppeteer-core` (chrome-headless-shell; Docker uses distro `chromium`) | https://github.com/puppeteer/puppeteer | Apache-2.0 | ✅ **Integrated** — `src/lib/pdf/pool.ts` (browser pool, real vector text PDF, embedded Tajawal/Amiri subsets, WYSIWYG with preview HTML) |
| **Whiteboard** | custom canvas engine (own code, zero third-party runtime) | — | — | ✅ **Integrated** — `src/components/qb/Whiteboard.tsx` (pen/highlighter/shapes/text/images/undo/redo, PNG + PDF export via pdf-lib). Excalidraw/tldraw evaluated — rejected, §3 |
| **Math recognition / formulas** | z-ai VLM (formula→text/LaTeX during extraction) | bundled SDK (server-side only) | proprietary service | ✅ **Integrated** in the extraction pipeline; pix2tex evaluated — deferred, §3 |
| **Math typesetting (render-ready)** | KaTeX-ready pipeline — formulas captured as plain text/LaTeX in the canonical document model | https://github.com/KaTeX/KaTeX | MIT | ◐ **Documented, not yet wired into the canvas** (deferral noted in §5 / remaining work) |
| **Document intelligence (extraction)** | z-ai VLM + own segmentation (`src/lib/qb/extract.ts`) — questions, options, types, tables as text, per-question confidence | bundled SDK | proprietary service | ✅ **Integrated** (mandatory human review; `pending_review` status enforced) |
| **Question extraction (Arabic-aware duplicate detection)** | own normalisation + similarity engine | — | — | ✅ **Integrated** (`src/lib/qb/bank.ts`, extraction import) |
| **Image processing (scans)** | OpenCV + NumPy | https://github.com/opencv/opencv-python | Apache-2.0 / BSD-3 | ✅ **Integrated** (deskew/perspective/illumination/adaptive threshold inside the OMR engine) |
| **QR generation** | `qrcode` npm 1.5 | https://github.com/soldair/node-qrcode | MIT | ✅ **Integrated** — OMR sheet identity QR (`src/lib/qb/render-omr.ts`) |
| **QR detection** | OpenCV `QRCodeDetector` | https://github.com/opencv/opencv-python | Apache-2.0 | ✅ **Integrated** — sheet identity + orientation cue (`engine/pipeline.py`, `engine/imaging.py`) |
| **Barcode (1-D)** | none (zbar/pyzbar available in venv, not in runtime path) | https://github.com/NaturalHistoryMuseum/pyzbar | LGPL-3 (wrapper) | ○ **Not integrated** — no 1-D barcode requirement yet; QR covers student/exam identity |
| **Rich text editing** | structured question editor (typed fields + dnd-kit sortable options) + Markdown rendering (`react-markdown`) | https://github.com/uuidjs/... see package.json | MIT | ✅ **Integrated** (`BankPane.tsx`); TipTap/Lexical/MDXEditor evaluated — §3 |
| **Drag & drop** | dnd-kit (`@dnd-kit/core/sortable/modifiers`) 6/10/9 | https://github.com/clauderic/dnd-kit | MIT | ✅ **Integrated** — answer-option reordering in the bank editor |
| **Arabic typography (web + PDF)** | Amiri & Tajawal via `@fontsource` | https://github.com/fontsource/fontsource | SIL OFL 1.1 | ✅ **Integrated** — bundled `public/fonts/*`, embedded as CID subsets in every PDF |
| **App framework** | Next.js 16 (App Router) + React 19 + TypeScript | https://github.com/vercel/next.js | MIT | ✅ runtime |
| **DB / ORM** | Prisma 6 (SQLite dev; PostgreSQL config documented for VPS) | https://github.com/prisma/prisma | Apache-2.0 | ✅ runtime |
| **Auth & crypto** | own JWT auth (`jose`) + `bcryptjs` | https://github.com/panva/jose , https://github.com/dcodeIO/bcrypt.js | MIT / BSD-3 | ✅ runtime |
| **State / validation / UI kit** | zustand, TanStack Query, zod, shadcn/ui (Radix), Tailwind CSS 4, lucide-react, sonner, framer-motion | see `package.json` | MIT | ✅ runtime |

Legend: ✅ running in the product today · ◐ evaluated with documented outcome · ○ explicitly not integrated.

---

## 2. How each integration is wired (adapters, not coupling)

The core application never imports an external processing library directly — every external tool
sits behind a defined interface:

```
src/lib/qb/ocr/engine.ts        ← DocumentProcessor registry (tesseract → vlm escalation)
src/lib/omr/client.ts           ← typed HTTP client for the Python OMR/OCR service (:3032)
src/lib/pdf/pool.ts             ← Chromium PDF render pool (puppeteer-core)
src/lib/qb/render-omr.ts        ← OMR sheet renderer (qrcode npm + exact mm SVG contract)
src/components/qb/PdfWorkspace  ← pdf.js (view) + pdf-lib (edit) — 100% client-side
src/components/qb/Whiteboard    ← own canvas engine + pdf-lib export
mini-services/omr-engine/       ← Python OpenCV service: /process (OMR) · /ocr (tesseract) · /health
```

* **OCR contract**: every processor implements `DocumentProcessor { langs, process }` and returns
  `{ text, confidence|null }`. `confidence === null` **forces** `needsReview` — OCR output is never
  trusted blindly; the teacher review step is mandatory by design (Arabic-OCR acceptance threshold
  and VLM escalation live in one constant, `ESCALATE_BELOW = 0.6`).
* **OMR contract**: the canonical mm-coordinate template (`src/lib/qb/omr-template.ts`) is the
  single source of truth shared by the TS generator and the Python reader — the reader never
  re-derives geometry; template identity travels in the sheet QR.
* **PDF contract**: the exact HTML used for the on-screen preview is what Chromium prints →
  WYSIWYG is structural, not best-effort.

## 3. Evaluated and NOT adopted (with reasons) — required by the brief

| Project | License | Why not adopted / what we took instead |
|---|---|---|
| **PaddleOCR** (https://github.com/PaddlePaddle/PaddleOCR) | Apache-2.0 | Best-in-class Arabic printed-text OCR, but needs the PaddlePaddle runtime (~500 MB) + first-run model downloads; our 4 GB VPS target and offline-first scans made it a poor default. **Integration point kept**: register a `PaddleProcessor` in `src/lib/qb/ocr/engine.ts` — no route changes needed. |
| **EasyOCR** (https://github.com/JaidedAI/EasyOCR) | Apache-2.0 | PyTorch-weight class dependency (~800 MB) for marginal gain over Tesseract on clean printed exams; Arabic support moderate. Deferred. |
| **Surya / marker** (https://github.com/VikParuchuri/surya) | GPL-3.0 | Strong layout detection, but **GPL contamination risk** for a commercial product → rejected on licence grounds. |
| **docTR** (https://github.com/mindee/doctr) | Apache-2.0 | PyTorch runtime cost; text-line quality comparable to Tesseract for our clean-print domain. Deferred behind the processor interface. |
| **OMRChecker** (https://github.com/Udayraj123/OMRChecker) | MIT | Excellent reference. Its config-driven template model cannot express our canonical contract (QR sheet identity + fiducial marker homography + mm grid shared with the generator). **Technique-level adoption**: flat-field illumination normalisation, window>4 mm adaptive threshold, marker-based perspective correction — all validated by our 24-case harness (24/24 PASS) and a 100-student E2E (92.9 % raw detection incl. deliberate stress cases; 100 % on normal scans; **zero wrong-letter reads** — misses become safe review flags). |
| **pix2tex / LaTeX-OCR** (https://github.com/lukas-blecher/LaTeX-OCR) | MIT | Torch + weights footprint for formula-image→LaTeX; the VLM path already returns formulas as text/LaTeX during extraction. Deferred behind the processor interface. |
| **Excalidraw** (https://github.com/excalidraw/excalidraw) | MIT | Would force its data model + React 18 peer constraints into our React 19 app for features we already ship (shapes/text/undo/export). Our own 800-line canvas engine is licence-clean and RTL-aware. |
| **tldraw** (https://github.com/tldraw/tldraw) | custom (watermark/branding required) | Licence incompatible with a white-label product → rejected. |
| **Fabric.js** (https://github.com/fabricjs/fabric.js) | MIT | **Actually piloted** as the exam-designer canvas layer (Task 2-c) — bidi text misalignment and retina viewport scaling broke WYSIWYG mm precision (verified empirically); replaced with a deterministic DOM canvas. Kept out of the render path. |
| **TipTap / Lexical / MDXEditor** | MIT | Full rich-text editors are heavyweight for a bank editor whose content model is structured (type/options/key/marks/tags). The structured editor + dnd-kit + Markdown rendering covers the workflow; equation editing listed as remaining work (KaTeX wiring). |
| **ZXing** (https://github.com/zxing-js/zxing) | Apache-2.0 | Only QR is needed today; OpenCV covers detection, `qrcode` npm covers generation. Re-evaluate if 1-D barcodes (Code-128 student cards) become a requirement. |
| **ReportLab / PyMuPDF / pdf2image** | BSD / AGPL / GPL | Python PDF engines are redundant — Chromium already prints the exact preview HTML as vector PDF (font subsets verified with `pdffonts`). PyMuPDF (AGPL) is ** confined to dev/test tooling, never shipped**. |

## 4. Installation & update commands

### 4.1 Node side (bun)

```bash
# everything is pinned in package.json — install/update with:
bun install                       # postinstall auto-fetches chrome-headless-shell into ./chrome (best-effort)
bun add pdfjs-dist@^6 pdf-lib@^1 qrcode@^1 @dnd-kit/core @dnd-kit/sortable @fontsource/amiri @fontsource/tajawal
bun run chrome:install            # force re-download of the bundled Chromium (PDF engine)
```

The pdf.js worker is a static asset: `public/pdf.worker.min.mjs` (copied from `pdfjs-dist/build`).

### 4.2 Python side (OMR/OCR engine — `mini-services/omr-engine`)

The engine itself is **stdlib-only Python** (ThreadingHTTPServer) so it deploys anywhere with zero
pip dependencies; it imports `cv2` + `numpy` at runtime:

```bash
pip install opencv-python-headless numpy      # the only runtime imports
bun run dev                                    # (in mini-services/omr-engine) — watch mode, :3032
# or plain: python3 server.py                  # from mini-services/omr-engine
```

**Arabic OCR language pack** (bundled, no system install needed):

```bash
cd mini-services/omr-engine/tessdata
curl -LO https://github.com/tesseract-ocr/tessdata_fast/raw/main/ara.traineddata
cp /usr/share/tesseract-ocr/5/tessdata/eng.traineddata .   # or download the same way
cp -r /usr/share/tesseract-ocr/5/tessdata/configs .
cp -r /usr/share/tesseract-ocr/5/tessdata/tessconfigs .    # required: tesseract resolves its
                                                           # `tsv` config inside --tessdata-dir
```

To upgrade quality, swap in `tessdata_best`:
`curl -LO https://github.com/tesseract-ocr/tessdata_best/raw/main/ara.traineddata`
(no code change — the engine passes `--tessdata-dir` to the bundled folder).

**System Tesseract binary** (the only system dependency):

```bash
# Ubuntu/Debian (Hostinger VPS)
apt-get install -y tesseract-ocr tesseract-ocr-eng   # language packs come from our bundled tessdata/
```

Update policy: `apt-get upgrade tesseract-ocr` is safe (we pass our own `--tessdata-dir`, so system
pack changes cannot break Arabic); `opencv-python-headless` is pinned — the engine documents and
works around the OpenCV 4.13 contour-retrieval regression (`RETR_LIST` + hierarchy filter instead
of `RETR_EXTERNAL`), so bump only with a harness re-run: `python3 tests/omr-engine-harness.py`.

### 4.3 Verification probe

```bash
bun scripts/oss-verify.ts       # prints versions + health + an Arabic OCR smoke result
```

## 5. Known limitations of the selected stack

* **Tesseract Arabic** quality is good on clean printed pages (measured 0.86 mean word confidence
  on a real exam page) but degrades on photos/low light — this is exactly why the confidence-gated
  VLM escalation and the mandatory review step exist.
* **Handwriting** (Arabic) is out of scope for Tesseract; the VLM path handles neat handwriting,
  otherwise extraction falls back to manual entry. Documented, not hidden.
* **1-D barcodes** are not read (QR only) — the OMR sheet identity + student-ID grids use QR/marks.
* **Formula typesetting**: formulas are extracted/stored as text; on-canvas KaTeX rendering is the
  next planned step (MIT, zero-risk addition).
* The engine is single-node and in-memory (config in DB, images on disk); horizontal scaling would
  require the OMR service to be stateless-scaled behind a queue — documented in DEPLOYMENT.md.

## 6. Licence compliance notes

* Runtime code: Apache-2.0 / MIT / BSD / SIL OFL only. **No GPL/AGPL in the shipped runtime.**
* PyMuPDF (AGPL-3) and poppler (`pdftoppm`, GPL) are dev/test tooling on the developer machine only
  (PDF quality gates), never imported by the product.
* `pyzbar` (LGPL wrapper, GPL libzbar), `fastapi`, `uvicorn`, `pytesseract`, `reportlab` exist in
  the sandbox venv from earlier experiments but are **not imported by any runtime path** — kept out
  of `OPEN_SOURCE_STACK.md` runtime claims and out of the Docker images on purpose.
* Model/weight licensing: no third-party model weights are shipped; the z-ai VLM/LLM is consumed
  as a hosted service via the official SDK (keys never stored in the repo, server-side only).

## 7. Verification transcript (real runs, 2026-10-31)

```
$ tesseract --list-langs (TESSDATA_PREFIX=bundled)  → ara, eng
$ engine /ocr  (ar_page-1.png, lang=ara+eng)        → ok=true, confidence=0.86
  text: "امتحان نصف السنة - علوم … الخلية … البناء الضوئي …"
$ APP POST /api/ocr lang=ara (same page, auth'd)    → ok=true, engine=tesseract,
                                                      confidence=0.86, needsReview=false
$ APP POST /api/ocr lang=eng (Midterm English page) → ok=true, engine=tesseract,
                                                      confidence=0.8845, needsReview=false
  text: "Midterm English Exam — Alnokhba …"
$ APP POST /api/ocr lang=ara (degraded: 33% scale,
  JPEG q35, +2.5° rotation)                         → tesseract fell below 0.6 →
                                                      ok=true, engine=vlm, needsReview=true
$ GET /api/health                                   → {ok:true, db:true, pdf:{running:true},
                                                      omrEngine:{ok:true}}
$ OMR harness (prior runs, unchanged engine core)   → 24/24 PASS; 100-student E2E:
                                                      mean confidence 0.954, zero wrong-letter reads
```
