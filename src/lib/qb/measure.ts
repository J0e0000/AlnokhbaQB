// ============================================================
// ALNOKHBA QB — Content measurement + collision-free reflow
//
// The exam canvas stores ABSOLUTE mm boxes. Auto-layout used to
// stack questions at a FIXED pitch (heightMm 22 / stride 26mm) —
// any prompt or option long enough to wrap ran past its box and
// OVERLAPPED the next question, both in the on-screen preview and
// in the printed PDF (they share one renderer).
//
// This module is the deterministic fix, shared by every entry
// point (never persisted — applied at render time):
//
//  1. measure*()      — char-class width table → wrapped line count
//                       → mm height, for every flowable element type.
//  2. reflowDocument()— per page: grow flowable boxes to fit their
//                       content, push overlapping flowables DOWN until
//                       overlap-free; anything past the bottom margin
//                       flows onto continuation pages (pageCount grows).
//                       Pinned decorations (shapes/lines/images/logos/
//                       page numbers) keep their stored geometry.
//
// The SAME estimator drives the designer store (initial question
// heights + auto-grow on edit) and the bank/OCR importers, so newly
// created documents stack correctly by construction.
// ============================================================

import type {
  QBDocument,
  QBElement,
  QBHeaderElement,
  QBNameFieldsElement,
  QBQuestion,
  QBQuestionElement,
  QBTextElement,
} from './types';

const PT_TO_MM = 25.4 / 72;

/** Vertical gap inserted when a flowable is pushed below another. */
const REFLOW_GAP_MM = 2.5;
/** Continuation pages allowed beyond the stored pageCount. */
const MAX_CONTINUATION_PAGES = 48;
/** Slight over-reserve so the estimator never under-sizes a box. */
const SAFETY = 1.05;

// Average glyph advance as a fraction of the font size (em) by character
// class — calibrated for Tajawal/Amiri. Slightly wide on purpose.
const ARABIC_EM = 0.52;
const LATIN_UPPER_EM = 0.68;
const LATIN_LOWER_EM = 0.52;
const DIGIT_EM = 0.56;
const SPACE_EM = 0.26;
const PUNCT_EM = 0.36;
const DEFAULT_EM = 0.55;

function charEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (ch === ' ') return SPACE_EM;
  if (code < 0x20) return 0; // control chars render as nothing
  if (code >= 0x0600 && code <= 0x06ff) return ARABIC_EM;
  if (code >= 0x0750 && code <= 0x077f) return ARABIC_EM;
  if (code >= 0x08a0 && code <= 0x08ff) return ARABIC_EM;
  if (code >= 0xfb50 && code <= 0xfdff) return ARABIC_EM;
  if (code >= 0xfe70 && code <= 0xfeff) return ARABIC_EM;
  if (code >= 0x30 && code <= 0x39) return DIGIT_EM;
  if (code >= 0x41 && code <= 0x5a) return LATIN_UPPER_EM;
  if (code >= 0x61 && code <= 0x7a) return LATIN_LOWER_EM;
  return DEFAULT_EM;
}

/** Estimated rendered width of one text run, in mm. */
export function measureTextWidthMm(text: string, fontSizePt: number): number {
  if (!text) return 0;
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * Math.max(fontSizePt, 1) * PT_TO_MM;
}

/** Visual line count of a text block inside `availMm` (white-space: pre-wrap). */
function wrappedLines(text: string, fontSizePt: number, availMm: number): number {
  const width = Math.max(availMm, 5);
  let lines = 0;
  for (const p of text.split('\n')) {
    if (p.length === 0) {
      lines += 1;
      continue;
    }
    lines += Math.max(1, Math.ceil(measureTextWidthMm(p, fontSizePt) / width));
  }
  return Math.max(1, lines);
}

function lineHeightMm(fontSizePt: number, lineHeight: number): number {
  return fontSizePt * PT_TO_MM * Math.max(lineHeight, 0.8);
}

function questionFontScale(doc: QBDocument): number {
  return doc.branding.fontScale === 's' ? 0.85 : doc.branding.fontScale === 'l' ? 1.18 : 1;
}

// ---------- per-type content height estimators ----------

function textContentHeightMm(el: QBTextElement): number {
  const lh = lineHeightMm(el.style.fontSize, el.style.lineHeight);
  return wrappedLines(el.content.text, el.style.fontSize, el.widthMm) * lh;
}

function headerContentHeightMm(el: QBHeaderElement, doc: QBDocument): number {
  const c = el.content;
  // mirror renderHeaderElement's effective sizing
  const eff =
    c.level === 1
      ? el.style.fontSize
      : Math.max(c.level === 2 ? el.style.fontSize - 2 : el.style.fontSize - 4, 8);
  const lh = lineHeightMm(eff, el.style.lineHeight);
  let h = wrappedLines(c.text, eff, el.widthMm) * lh;
  if (c.showMeta) {
    const items = [doc.branding.subtitle, doc.branding.academicYear, doc.branding.duration]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());
    if (items.length > 0) {
      const metaSize = Math.max(7, Math.round(eff * 0.6));
      const metaText = items.join(' • ');
      h += 1 + wrappedLines(metaText, metaSize, el.widthMm) * lineHeightMm(metaSize, el.style.lineHeight);
    }
  }
  return h;
}

function nameFieldsContentHeightMm(el: QBNameFieldsElement): number {
  const rows = el.content.fields.length + (el.content.showStudentId ? 1 : 0);
  if (rows === 0) return 0;
  const lh = lineHeightMm(el.style.fontSize, el.style.lineHeight);
  return rows * lh + (rows - 1) * 2; // .nf gap: 2mm
}

/**
 * Height of ONE question block (prompt + image + options) in mm —
 * mirrors questionInnerHtml's DOM structure and option layouts.
 */
export function questionContentHeightMm(
  el: QBQuestionElement,
  q: QBQuestion,
  doc: QBDocument
): number {
  const scale = questionFontScale(doc);
  const fs = Math.max(1, el.style.fontSize * scale);
  const lh = lineHeightMm(fs, el.style.lineHeight);
  const avail = Math.max(el.widthMm, 10);

  const numberPrefix = el.content.showNumber ? `${q.number}. ` : '';
  const marksSuffix = el.content.showMarks
    ? ` (${q.marks} ${doc.direction === 'rtl' ? 'درجات' : 'marks'})`
    : '';
  let h = wrappedLines(`${numberPrefix}${q.prompt}${marksSuffix}`, fs, avail) * lh;

  if (q.imageDataUrl) h += 30 + 1; // .q-image max-height 30mm + margin-top 1mm

  if (q.options.length === 0) return h;

  const optionTexts = q.options.map((o) =>
    el.content.showOptionLetter ? `${o.id}) ${o.text}` : o.text
  );
  const widths = optionTexts.map((t) => measureTextWidthMm(t, fs));

  let optHeight: number;
  if (el.content.optionLayout === 'grid2') {
    // 2 columns, 6mm column-gap, 0.8mm row-gap; row height = max of the pair
    const colW = Math.max((avail - 6) / 2, 5);
    const lineCounts = widths.map((w) => Math.max(1, Math.ceil(w / colW)));
    let rowsHeight = 0;
    for (let r = 0; r < q.options.length; r += 2) {
      rowsHeight += Math.max(lineCounts[r], lineCounts[r + 1] ?? 0) * lh;
    }
    const rows = Math.ceil(q.options.length / 2);
    optHeight = rowsHeight + (rows - 1) * 0.8;
  } else if (el.content.optionLayout === 'vertical') {
    // each option on its own line(s), 0.6mm row-gap
    const lineCounts = widths.map((w) => Math.max(1, Math.ceil(w / avail)));
    const lines = lineCounts.reduce((a, b) => a + b, 0);
    optHeight = lines * lh + (q.options.length - 1) * 0.6;
  } else {
    // inline: greedy flex-wrap packing, 6mm column-gap, 0.5mm row-gap
    let lines = 1;
    let lineW = 0;
    for (const w of widths) {
      if (w > avail) {
        // this option alone spans several lines: closes the current line first
        if (lineW > 0) lines += 1;
        lines += Math.ceil(w / avail) - 1;
        lineW = 0;
      } else if (lineW === 0) {
        lineW = w;
      } else if (lineW + 6 + w <= avail) {
        lineW += 6 + w;
      } else {
        lines += 1;
        lineW = w;
      }
    }
    optHeight = lines * lh + (lines - 1) * 0.5;
  }
  return h + 1 + optHeight; // .q-options margin-top 1mm
}

/** Pure content height estimate for any element (unknown types → 0). */
export function elementContentHeightMm(el: QBElement, doc: QBDocument): number {
  switch (el.type) {
    case 'text':
      return textContentHeightMm(el);
    case 'header':
      return headerContentHeightMm(el, doc);
    case 'name-fields':
      return nameFieldsContentHeightMm(el);
    case 'question': {
      const q = doc.questions.find((qq) => qq.id === el.content.questionId);
      return q ? questionContentHeightMm(el, q, doc) : 0;
    }
    default:
      return 0;
  }
}

/**
 * Recommended stored height for a question element: at least the previous
 * convention (22mm) so short questions keep their visual size, and never
 * less than the real content height.
 */
export function recommendedQuestionHeightMm(
  el: QBQuestionElement,
  q: QBQuestion,
  doc: QBDocument
): number {
  return Math.max(22, Math.ceil(questionContentHeightMm(el, q, doc) * SAFETY));
}

// ---------- reflow ----------

interface Rect {
  x: number;
  bottom: number;
  widthMm: number;
  top: number;
}

function cloneDoc(doc: QBDocument): QBDocument {
  return JSON.parse(JSON.stringify(doc)) as QBDocument;
}

const FLOWABLE_TYPES = new Set(['text', 'header', 'question', 'name-fields']);

/**
 * Render-time layout pass (never persisted):
 *  - grows every flowable box to at least its measured content height;
 *  - pushes flowables DOWN until no two flowables overlap (2.5mm gap);
 *  - carries anything past the bottom margin onto continuation pages.
 * Shapes, lines, images, logos and page numbers keep their stored geometry.
 */
export function reflowDocument(doc: QBDocument): QBDocument {
  const out = cloneDoc(doc);

  // Auto-attach ORPHAN questions — questions that exist in the document but
  // have no question element on any page (e.g. OMR-only exams created from
  // the bank). Without this the paper renders as a blank cover while the
  // exam claims to have questions. Render-time only; never persisted.
  const attached = new Set(
    out.elements
      .filter((e): e is QBQuestionElement => e.type === 'question')
      .map((e) => e.content.questionId)
  );
  const orphans = out.questions.filter((q) => !attached.has(q.id));
  if (orphans.length > 0) {
    const lastPage = Math.max(0, ...out.elements.map((e) => e.page), 0);
    const maxY = out.elements
      .filter((e) => e.page === lastPage)
      .reduce((m, e) => Math.max(m, e.y + e.heightMm), 36);
    orphans.forEach((q, i) => {
      out.elements.push({
        id: `el-auto-${q.id}`,
        type: 'question',
        page: lastPage,
        x: out.margins.leftMm,
        y: maxY + 4 + i * 26, // rough anchor — the placement pass below refines it
        widthMm: out.pageSize.widthMm - out.margins.leftMm - out.margins.rightMm,
        heightMm: 22,
        rotation: 0,
        style: {
          fontFamily: 'Tajawal',
          fontSize: 12,
          bold: false,
          italic: false,
          underline: false,
          align: out.direction === 'rtl' ? 'right' : 'left',
          color: '#111827',
          lineHeight: 1.5,
        },
        content: {
          questionId: q.id,
          showNumber: true,
          optionLayout: 'vertical',
          showOptionLetter: true,
          showMarks: false,
        },
      });
    });
  }

  const pageH = out.pageSize.heightMm;
  const usableBottom = pageH - out.margins.bottomMm;
  const pageTop = out.margins.topMm;
  const pageCap = Math.min(99, out.pageCount + MAX_CONTINUATION_PAGES);

  const byPage = new Map<number, QBElement[]>();
  for (const el of out.elements) {
    if (el.visible === false) continue;
    const list = byPage.get(el.page) ?? [];
    list.push(el);
    byPage.set(el.page, list);
  }
  const maxStoredPage = Math.max(-1, ...out.elements.map((el) => el.page));

  let carry: QBElement[] = [];
  let lastUsedPage = maxStoredPage;

  for (let p = 0; p <= Math.max(maxStoredPage, pageCap); p++) {
    const stored = byPage.get(p) ?? [];
    if (stored.length === 0 && carry.length === 0) {
      if (p > maxStoredPage) break;
      continue;
    }

    // sort flowables top→bottom (stable); pinned decorations untouched
    const carryCount = carry.length;
    const incoming = [...carry, ...stored];
    carry = [];
    const flow = incoming
      .map((el, idx) => ({ el, idx }))
      .filter(({ el }) => FLOWABLE_TYPES.has(el.type) && !el.rotation)
      .sort((a, b) => a.el.y - b.el.y || a.el.x - b.el.x || a.idx - b.idx);

    const placed: Rect[] = [];
    for (const { el, idx } of flow) {
      const est = elementContentHeightMm(el, out) * SAFETY;
      const h = Math.max(el.heightMm, est);
      const isCarry = idx < carryCount;
      let y = isCarry ? Math.max(el.y, pageTop) : el.y;

      // push down until overlap-free (flowables only; decorations ignored)
      for (let guard = 0; guard < 400; guard++) {
        let moved = false;
        for (const r of placed) {
          const overlapX = r.x < el.x + el.widthMm && el.x < r.x + r.widthMm;
          const overlapY = y < r.bottom && r.top < y + h;
          if (overlapX && overlapY) {
            y = r.bottom + REFLOW_GAP_MM;
            moved = true;
          }
        }
        if (!moved) break;
      }

      // past the bottom margin → continuation page (content is never lost).
      // NOTE: the SAME element object is carried (not a copy) so its final
      // page/y/height mutations land in out.elements.
      if (y + h > usableBottom + 0.5 && p < pageCap) {
        el.y = pageTop;
        el.heightMm = h;
        carry.push(el);
        lastUsedPage = Math.max(lastUsedPage, p + 1);
        continue;
      }

      el.y = y;
      el.heightMm = h;
      el.page = p; // carried elements land on the page they were placed on
      placed.push({ x: el.x, top: y, bottom: y + h, widthMm: el.widthMm });
      lastUsedPage = Math.max(lastUsedPage, p);
    }
    if (p >= pageCap) break;
  }

  out.pageCount = Math.max(out.pageCount, lastUsedPage + 1);
  return out;
}
