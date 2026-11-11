# النخبة QB — Alnokhba QB

**منصة تعليمية متكاملة لبنك الأسئلة وتصميم الامتحانات والتصحيح الآلي — عربية أولاً (RTL) مع دعم إنجليزي (LTR).**

A production-grade educational workspace for teachers and educational organisations: digitise, organise, search, create, edit and process exam questions and papers — smart scanning, a structured question bank, exam design, print-perfect PDF, OMR bubble-sheet generation, scanning and auto-grading, online exams, assignments, a PDF workspace and a whiteboard.

---

## المزايا / Features

| Module | What it does |
|---|---|
| **الاستخراج الذكي (Smart Extraction)** | Upload PDF/images → pages rendered in-browser → **VLM vision model** extracts questions (MCQ / true-false / written, Arabic + English, equations & tables as text) with per-question **confidence scores** → mandatory **human review** (edit, accept, reject) → import to the bank with automatic **Arabic-aware duplicate detection**. Source tracking (document + page). |
| **بنك الأسئلة (Question Bank)** | Subjects / grades / units / lessons / topics taxonomy per organisation, search + advanced filters, rich editor (options, key, explanation, difficulty, marks, tags), duplicate warning while editing, archive/delete, **bulk import/export (JSON + CSV with UTF-8 BOM for Excel)**, source labels (يدوي / استخراج / استيراد / AI). |
| **مصمم الامتحانات (Exam Designer)** | Canvas exam editor (mm-precise), question bank import, header/logo/name-fields/page-numbers/shapes, RTL & LTR, undo/redo, save drafts, **immutable published versions**. |
| **PDF وطباعة (Print engine)** | Server-side Chromium renders the exact preview HTML to **vector PDF** (selectable text, embedded Tajawal/Amiri fonts, A4 exact), separate answer-key and OMR-sheet PDFs, multi-copy sheets. |
| **OMR (تصحيح آلي)** | Deterministic bubble-sheet template (QR identity + student-ID grid + fiducial markers), Python/OpenCV reader micro-service: perspective correction, rotation handling, fill analysis, **blank / multiple / unclear detection that never guesses**, confidence + per-question ratios, teacher overrides + regrade, full pipeline diagnostics, 300-dpi sheets. |
| **الامتحانات الأونلاين (Online exams)** | Server-authoritative attempts with frozen question sets/keys, timer, security events. |
| **الواجبات (Assignments)** | Graded (auto-scored via online exam) and file-upload modes, late policy, grading ledger. |
| **مساحة PDF (PDF workspace)** | Open local PDFs, thumbnails, zoom, rotate/delete/reorder pages, annotate (pen/highlight/rect/text), export **original-quality (page ops only, vector preserved)** or **flattened with annotations**, extract selected pages as PNGs. |
| **السبورة (Whiteboard)** | Pen, highlighter, eraser, shapes (rect/ellipse/line/arrow), text, images, colours, sizes, undo/redo, clear-with-confirm, export PNG and PDF. |
| **الحسابات والصلاحيات (Auth & RBAC)** | JWT (httpOnly cookie) + bcrypt, roles: **super_admin / org_admin / teacher / viewer**, isolated organisation workspaces (all queries org-scoped, leak-safe 404s), audit log, rate limiting, file-type/size validation. |
| **لوحة الإدارة (Admin)** | User management (create, roles, activate/deactivate, password reset), organisations overview (super admin), **audit log viewer** with action filters. |

---

## البنية التقنية / Architecture

```
Browser (React 19 + Next.js 16 App Router, single-page shell, AR/EN, RTL/LTR)
  │  fetch (same-origin cookies)
  ▼
Next.js API routes (Node runtime) ── zod validation, RBAC guards, org scoping, audit
  ├── Prisma ORM → SQLite (db/custom.db)      ← switchable to PostgreSQL (see DEPLOYMENT.md)
  ├── Chromium pool (puppeteer-core)          → vector PDF / 300-dpi OMR sheets
  └── z-ai SDK (server-only)                  → VLM smart extraction / OCR fallback
OMR engine micro-service (Python 3.12 + OpenCV + NumPy + Tesseract, port 3032)
  └── QR identity → homography → bubble analysis → answers + diagnostics
```

**Canonical model**: exams are self-contained `QBDocument` drafts; publishing creates immutable `ExamVersion` snapshots that scans bind to (template-mismatch is rejected).

### المصدر المفتوح / Open-source stack
The platform is assembled from the best available open-source projects (Tesseract + bundled Arabic `tessdata`, OpenCV, PDF.js, pdf-lib, Chromium/puppeteer, qrcode, dnd-kit, Amiri/Tajawal fonts …), each behind a thin typed adapter — plus a documented list of evaluated-and-rejected candidates with reasons. See **[OPEN_SOURCE_STACK.md](./OPEN_SOURCE_STACK.md)** for the full table, licences, install/update commands and the verification transcript. One-command integration check:

```bash
bun scripts/oss-verify.ts   # versions + health + bundled assets + OCR smoke — ALL CHECKS PASSED
```

### Security
- Auth on **every** API route (edge middleware + per-route role guards). Public: login/register/me/health only.
- Org isolation: every query scoped by `organizationId` (`orgFilter`); cross-org access → 404 (no existence leak).
- zod validation everywhere; document sanitizer allowlist (data-URL images ≤3MB only); HTML-escaped render output (XSS probes verified).
- Rate limits: login (12/min per IP+email), register, uploads, extraction (30/5min), general API (600/min).
- Uploads: MIME allowlist (pdf/png/jpg/webp) + 20MB cap; download paths traversal-proof.
- Audit log for login/failed-login, exam publish/archive, scans, imports/exports, user changes.
- Secrets via env (`AUTH_SECRET`); `.env` never committed.

---

## التشغيل المحلي / Local run

```bash
# 1) install
bun install

# 2) environment
cp .env.example .env        # set AUTH_SECRET for anything non-local

# 3) database
bun run db:push             # create/sync schema
bun run db:seed             # seed org + users + taxonomy (idempotent)

# 4) OMR engine (separate service, port 3032)
cd mini-services/omr-engine && bun run dev   # auto-restarts on .py changes

# 5) app (port 3000) — from the project root
bun run dev

# 6) open the Preview Panel (the app is served on the sandbox preview URL)
```

**Seeded accounts** (change immediately in production via الإدارة):

| Role | Email | Password |
|---|---|---|
| Super admin | `admin@alnokhba.qb` | `Admin@2025` |
| Org admin | `principal@alnokhba.qb` | `Org@2025` |
| Teacher | `teacher@alnokhba.qb` | `Teacher@2025` |
| Viewer | `viewer@alnokhba.qb` | `Viewer@2025` |

Registration (حساب جديد) creates a **new organisation** with the registrant as its org_admin — banks are isolated per organisation.

### Useful commands
```bash
bun run lint          # ESLint (0 errors)
bunx tsc --noEmit     # TypeScript check
bun run db:push       # sync schema
bun run db:seed       # seed users/org/taxonomy
bun scripts/test-extract.ts       # E2E: render exam page → VLM extraction → review → import → dedup
python3 tests/omr-engine-harness.py  # OMR engine regression (24 cases)
bash scripts/backup.sh            # consistent SQLite + files backup
bash scripts/restore.sh backups/anqb-XXX.tar.gz
```

---

## النشر / Deployment

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** — Docker Compose (app + OMR engine + Caddy HTTPS) targeted at Hostinger VPS, PostgreSQL migration, backups/restore, and maintenance.

---

## الاختبارات والتحقق / Verification summary

- **OMR engine harness: 24/24 PASS** (pencil/pen/blue fills, phone camera, rotations ±3/±10/90/180, low light, multiples/unclear/blank/ghosts, wrong-template rejection, QR identity, student-ID, auto-grading).
- **App-level OMR E2E**: filled sheet → `POST /api/scan` → QR identity → template match → grade **10/10, confidence 1.0**.
- **Smart extraction E2E**: rendered exam page → 3 candidates in ~6s (95–98% confidence) → import → re-import correctly flagged **3/3 duplicates**.
- **RBAC isolation**: second org sees **zero** rows; cross-org mutations → leak-safe 404; viewer → 403 on mutations.
- **Browser E2E**: login → dashboard → bank (create question) → extraction studio → designer (add/save) → preview iframe → vector PDF download (server log 200) → publish (version snapshot) → OMR studio → scan studio → PDF workspace (open/annotate) → whiteboard (draw/undo) → admin (users/audit/orgs) → EN/AR toggle flips `dir` → mobile 390×844 with sticky footer.
- `bun run lint`: 0 errors · `tsc --noEmit`: 0 project errors.

## القيود المعروفة / Known limitations

1. **UI i18n depth**: navigation/shell and all new modules are fully bilingual; some legacy panes (designer/assignments/settings) remain Arabic-only while their logic is language-neutral. Exam content itself is fully RTL/LTR.
2. **Handwritten-question recognition** depends on VLM quality — confidence flags + mandatory review mitigate; very messy handwriting may need manual entry.
3. **PDF annotations flatten** on export (option 2) — the original-quality export keeps vector text but cannot include annotations; both options are clearly labelled in the UI.
4. **Extraction batch cap**: 10 pages per run (UI guidance splits larger documents) to keep VLM calls reliable.
5. **SQLite** is the tested store; PostgreSQL is a Prisma provider switch (see DEPLOYMENT.md) — recommended for large multi-org deployments.
6. Tesseract ships `eng` only; Arabic OCR is served by the VLM fallback (by design).
