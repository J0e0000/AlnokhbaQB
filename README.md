# Pagewise — an original online PDF toolkit

Pagewise is a privacy-first web app that offers the same *categories* of PDF functions as
popular online toolkits (merge, split, compress, convert, sign, redact, OCR, AI…), built
from scratch with original branding, copy, layout and code. No third-party assets are used.

## Run

```bash
bun install        # once
bun run dev        # http://localhost:3000  (dev server, port 3000)
bun run lint       # eslint
bunx tsc --noEmit  # typecheck
```

Optional engine smoke-check: `curl localhost:3000/api/pw/health`

## Architecture

One shared flow for every tool: **pick tool → drop/choose files → set options → Run →
progress → download result(s)**. The UI is generated from a single registry:

```
src/lib/pw/
  registry.ts          # ALL tools (metadata, options schema, engine binding)
  types.ts             # ToolDef / ToolOption / EditorProps contracts
  range.ts             # shared page-range grammar: 1-3,5,8-  ("8-" to end, "-3" from start)
  pdfjs.ts             # pdf.js loader (worker served from /pdf.worker.min.mjs), render/text/thumbs
  blob.ts              # download, zip, byte formatting helpers
  client/              # Tier-1 tools — 100% client-side (pdf-lib + pdf.js), no server
  server/engines.ts    # Tier-2 engines: qpdf, Ghostscript, LibreOffice, Tesseract, Chromium
  server/queue.ts      # job store, temp dirs, TTL sweeper, rate limits, magic-byte checks
src/components/pw/
  HomeGrid / Workspace / AiRunner / editors/*   # UI generated from the registry
src/app/api/pw/
  jobs/route.ts        # POST job (multipart) → {id}
  jobs/[id]/route.ts   # GET status/progress
  jobs/[id]/result/    # GET download; deletes job when every file was fetched
  ai/route.ts          # POST {mode,text} → SSE stream (server-side LLM key, never exposed)
```

Adding a tool = adding **one entry** to `registry.ts` (plus one run function or engine).

### Engines used per tool

| Layer | Tools | Engine |
|---|---|---|
| In-browser (Tier 1) | Merge, Split/Extract, Remove, Organize grid, Rotate, Page numbers, Watermark, Images→PDF, Scan→PDF, PDF→JPG/PNG, Compress, Crop, Sign, Edit, Redact, Compare | `pdf-lib` + `pdf.js` (WASM, offline after first load) |
| Server (Tier 2) | Repair (qpdf rebuild / Ghostscript fallback), Protect & Unlock (qpdf AES-256), PDF/A (Ghostscript), Office→PDF (LibreOffice headless), HTML→PDF (Chromium via puppeteer-core, SSRF-guarded), PDF→Word/Excel/PowerPoint (pdftotext + docx/xlsx/pptxgenjs), OCR (pdftoppm + Tesseract, English/Arabic) | system binaries |
| AI (Tier 3) | Summarize, Translate, PDF→Markdown | LLM via server SDK; **files stay in the browser — only extracted text is sent**; results streamed over SSE |

### Privacy model

- Tier-1 tools never upload anything — they keep working with the network disabled after first load.
- Server tools upload only what the engine needs; jobs live in `/tmp/pagewise-jobs/<id>` and are
  **deleted immediately once every result file is downloaded**, and at most **1 hour** after completion.
- AI tools upload text only; the model key stays server-side.
- Inputs are validated by magic bytes (not extensions); URLs for HTML→PDF are resolved and all
  private/loopback/link-local addresses are blocked (SSRF), including during redirects/subresource loads.

### Limits

- Server jobs: 15 per hour per IP, 3 concurrent, per-tool size caps (5–100 MB), OCR capped at 60 pages,
  AI input capped at 80k characters.
- Page-range errors are explicit, e.g. `Bad page range "9-12" (document has 8 pages)`.

## Page-range grammar (shared by Split, Remove, Rotate, Crop scope)

`1-3,5,8-` — open-ended `8-` means "page 8 to the end", `-3` means pages 1–3.
The Organize grid accepts duplicates and any order (e.g. `3,1,2,2`).

## Notes

- Compress rasterizes pages (text becomes part of the image) — the UI says so and reports before/after size.
- Redact flattens affected pages so the content under the boxes is genuinely removed.
- RTL layout, light/dark themes and keyboard accessibility are built in.
