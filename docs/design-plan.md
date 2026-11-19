# النخبة QB — خطة التصميم (Design Plan)

Status: reviewed against the frontend-design "tells" list before any code was written.
Scope: interface remake only. No API, data-model, or PDF/OMR render changes
(`src/lib/qb/render-exam.ts` and `src/lib/pdf` are read-only for this work).

## 1. Subject

A daily work tool for Egyptian teachers: build an exam, print it with OMR answer
sheets, scan and grade a stack in minutes. Calm, dense where useful, legible,
trustworthy. The single memorable element is **the exam sheet itself** — paper
on a desk at true A4 proportion. Everything else is quiet chrome.

## 2. Palette (6 named values, defined as CSS variables in `globals.css`)

| Token | Hex | Role |
|---|---|---|
| Ink `--ink` | `#14213D` | Structure: sidebar, headings, body text on paper |
| Desk `--desk` | `#E9ECF1` | App background — the desk the paper sits on |
| Paper `--paper` | `#FFFFFF` | Content surfaces, cards, the exam sheet |
| Brass `--brass` | `#A9822A` | ONE job: primary action + selected state |
| Pen Red `--pen-red` | `#B3261E` | Wrong answers, errors, destructive |
| Marker Green `--marker-green` | `#1B7A4B` | Correct answers, success, connected |

Supporting neutrals (not accents): line `#D3D9E3` (1px borders), muted text
`#4A5468`, desk-deep `#E2E7EF` (secondary surfaces), paper-muted `#F1F3F7`.

Contrast notes (verified): Ink on Paper 16.0:1; Ink on Desk 13.4:1; muted text
on Paper 7.6:1; **Brass button uses Ink text — 4.50:1** (white text on brass is
3.56:1 and fails AA for normal text, so it is not used); Pen Red with white text
6.5:1; Marker Green on Paper 5.3:1. Brass is never body text on white.

shadcn token mapping: `--background`→Desk, `--card`/`--popover`→Paper,
`--primary`→Brass, `--primary-foreground`→Ink, `--destructive`→Pen Red,
`--ring`→Ink, plus `--success`/`--warning` custom roles. All existing shadcn
components inherit the palette without edits.

## 3. Type roles

- **Tajawal 400/500/700** — all UI text. 500 for labels/nav, 700 for emphasis.
- **Amiri 400/700** — the "printed voice": exam titles, the paper preview
  header, the wordmark. UI and printout match because PDFs embed Amiri too.
- Scale: body 15–16px; headings 20/24/32; **floor 13px** (all `text-[10px]` /
  `text-[11px]` / `text-xs` usages are replaced). Arabic line-height 1.7.
- Digits: Western, `tabular-nums`, for scores, versions, IDs, seat numbers —
  they must match the printed sheets. No hyphenation, no justification.

## 4. Layout concept

Desktop ≥1024px: right-side persistent sidebar (RTL start side), Ink navy,
240px, grouped sections; content on Desk. Mobile: bottom bar with the 4 most
used destinations (امتحاناتي، مسح، الطلاب، المزيد) and a sheet for the rest.
Inside an exam: header with the exam title (Amiri) and a **numbered stage
stepper** (التصميم ١ → المعاينة ٢ → أوراق OMR ٣) — the only numbered sequence
in the product, because printing stages are a real order.

```
Desktop (RTL, sidebar on the right — start side)
┌──────────────────────────────┬────────────────────────────┐
│  الامتحانات                  │  النخبة ◫        [wordmark] │
│   امتحاناتي                  ├────────────────────────────┤
│   بنك الأسئلة                │  امتحاناتي                  │
│   استيراد من ملف             │  كمّل من حيث توقفت: ...      │
│  التصحيح                     │  [امتحان جديد] (brass)       │
│   مسح وتصحيح                 │  ┌────────────────────────┐ │
│   معالج OMR                  │  │ جدول: العنوان │ المادة │ │ │
│   كشف الغش                   │  │ الأسئلة │ الحالة │ آخر   │ │ │
│  الطلاب                      │  │ تعديل + قائمة إجراءات   │ │ │
│   الطلاب                     │  └────────────────────────┘ │
│   الواجبات  أونلاين          │  (table, not card grid)      │
│  الإعدادات                   │                              │
│  ── حالة النظام ───────────  │                              │
│   قاعدة البيانات   متصل      │                              │
│   محرك PDF         متصل      │                              │
│   محرك التصحيح     متصل      │                              │
└──────────────────────────────┴────────────────────────────┘

Exam workspace  /exams/[id]/…
┌────────────────────────────────────────────────────────────┐
│ ← امتحان الرياضيات — أكتوبر          (Amiri title, back)    │
│ ① التصميم   ② المعاينة   ③ أوراق OMR    (stage stepper)     │
├────────────────────────────────────────────────────────────┤
│  paper on desk: A4 surface, soft real-paper edge            │
└────────────────────────────────────────────────────────────┘

Mobile ≤ 390px — scan
┌──────────────────────────┐
│  مسح ورقة الإجابة         │
│ ┌──────────────────────┐ │
│ │   كاميرا / رفع        │ │  ≥44px targets, one-handed
│ └──────────────────────┘ │
│  النتائج: ✓ صحيحة ✗ خطأ  │  icons + color, never color alone
├──────────────────────────┤
│ امتحاناتي | مسح | طلاب | ⋯│  bottom bar
└──────────────────────────┘
```

## 5. Radius, depth, motion

- Radius by role: inputs/buttons 6px (`rounded-md`), panels 8px
  (`rounded-lg`), dialogs/sheets 12px (`rounded-xl`). No uniform pill radius.
- 1px borders + spacing carry the structure. One soft shadow, reserved for
  floating layers (dropdowns, dialogs, mobile sheet). No gradients.
- Motion: none on page load. Only action feedback (save status, scan progress,
  dialog open/close), 120–160ms. `prefers-reduced-motion` honored.

## 6. Copy rules (applied in Phase 4 via `src/lib/ui/strings.ts`)

Plain specific verbs, action names say what the user gets ("احفظ التعديلات").
No marketing filler, no tech lists, no "•"-joined meta strings — the footer
tech line is deleted, not reworded. Errors state what happened + the fix.
Glossary: امتحان / نموذج / ورقة OMR used consistently; every string carries an
`en` key for future English. Western digits everywhere in UI data.

## 7. Self-critique against the tells (done BEFORE coding)

1. **Cream + serif + terracotta tell.** Rejected the warm-paper variant I
   first sketched: Desk is a cool grey-blue `#E9ECF1`, and Amiri is confined
   to the printed voice (titles/preview/wordmark) so no "broadsheet serif"
   read.
2. **SaaS-card kit tell.** My first exams-list sketch was a card grid —
   replaced with a table before writing code (the brief mandates this too);
   settings is a two-column form, not a grid of identical cards.
3. **Template-chrome tells.** No all-caps eyebrows (Arabic has no caps — any
   tracked-out Latin labels are out anyway); the old "بنك أسئلة • PDF • OMR •
   تصحيح آلي" tagline and the tech footer are deleted, not restyled; no
   monospace small labels — seating/QR codes are data and use tabular-nums
   Tajawal; no "→" on any link or button.
4. **Numbered markers tell.** ①②③ appear only on the exam stage stepper (a
   real sequence). Nowhere else.
5. **Hover-on-everything tell.** Hover states exist only on interactive
   controls; exam table rows and cards get no transition effects.
6. **Accent-on-one-word / gradient tells.** No accent spans inside headings;
   no gradients anywhere (removed `btn-primary-grad` usages in re-skinned
   panes).
7. **Brass discipline.** Brass appears only as: primary buttons, the active
   stage tab underline, and the selected sidebar item. Checked that no
   body-size brass text sits on white (4.50:1 passes only with Ink text on
   brass backgrounds).

**One thing removed:** the footer entirely, and with it every tech-branding
string (Python/OpenCV/Chromium never appear in UI). The wordmark "النخبة" in
Amiri with a registration-mark glyph replaces the "ن" tile.

## 8. Deliberately NOT changed

- All pane logic (Designer/ExamCanvas, ScanStudio pipeline, OMR/OCR flows,
  Online/Assignments) — only chrome and tokens change.
- API routes, data models, `render-exam.ts`, `src/lib/pdf`.
- The two restored features that lost their shell wiring (كشف الغش, معالج
  OMR) keep their components; they are re-wired to routes, not rewritten.

## 9. IA / routing map

`/` → redirect to `/exams`. Routes: `/exams`, `/exams/[id]/design`,
`/exams/[id]/preview`, `/exams/[id]/omr`, `/bank`, `/import`, `/scan`,
`/pipeline`, `/cheating`, `/students`, `/assignments`, `/online`, `/settings`,
`/login`. Browser back/refresh/deep links work; exam-scoped screens exist only
inside an exam (the "disabled until selected" nav pattern is deleted).

## 10. Quality floor

Logical properties (ms/me/ps/pe/start/end) instead of left/right; mirror
directional icons; `<bdi>` around mixed Latin tokens inside Arabic sentences.
WCAG 2.2 AA: 4.5:1 text, 3:1 UI components + focus rings (2px, never hidden
under sticky headers), ≥24px targets (40–44px on mobile scan controls), color
never the only signal (icons accompany ✓/✗). Tables scroll inside their own
container; no horizontal page scroll at 390/768/1280/1536. Lighthouse
accessibility ≥95 and no serious axe violations targeted on Phase 1; verified
in-browser at four widths with screenshots in `docs/screens/`.
