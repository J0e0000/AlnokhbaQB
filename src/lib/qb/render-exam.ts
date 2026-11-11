// ============================================================
// ALNOKHBA QB — Canonical Exam Renderer (HTML)
// THE single renderer used BOTH for on-screen preview (iframe
// srcDoc) and for Puppeteer PDF generation → guaranteed WYSIWYG.
// All geometry is absolute, millimeter-based, left/top anchored —
// direction (rtl/ltr) affects only inline text flow, never position.
// ============================================================

import type {
  QBDocument,
  QBElement,
  QBHeaderElement,
  QBImageElement,
  QBLineElement,
  QBLogoElement,
  QBNameFieldsElement,
  QBPageNumberElement,
  QBQuestionElement,
  QBQuestion,
  QBShapeElement,
  QBTextElement,
  QBTextStyle,
} from './types';

export interface RenderExamOptions {
  /** 'print' = pure white (PDF source) | 'embed' = gray backdrop + page shadow (iframe preview) */
  mode?: 'print' | 'embed';
}

// ---------- helpers ----------

function esc(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function mm(v: number): string {
  return `${round2(v)}mm`;
}

// ---------- fonts (file:// — served to headless Chrome only) ----------

const ARABIC_RANGE =
  'U+0600-06FF, U+0750-077F, U+0870-088E, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C-200F, U+2010-2011, U+204F, U+2E41';
const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2212, U+FEFF, U+FFFD';

function fontFaceCss(): string {
  const root = process.cwd();
  const file = (name: string) => `file://${root}/public/fonts/${name}`;
  const face = (family: string, fileName: string, weight: number, range: string) =>
    `@font-face { font-family: '${family}'; src: url('${file(fileName)}') format('woff2'); font-weight: ${weight}; font-style: normal; unicode-range: ${range}; }`;
  return [
    face('Tajawal', 'tajawal-arabic-400-normal.woff2', 400, ARABIC_RANGE),
    face('Tajawal', 'tajawal-latin-400.woff2', 400, LATIN_RANGE),
    face('Tajawal', 'tajawal-arabic-500-normal.woff2', 500, ARABIC_RANGE),
    face('Tajawal', 'tajawal-latin-700.woff2', 700, LATIN_RANGE),
    face('Tajawal', 'tajawal-arabic-700-normal.woff2', 700, ARABIC_RANGE),
    face('Amiri', 'amiri-arabic-400-normal.woff2', 400, ARABIC_RANGE),
    face('Amiri', 'amiri-latin-400.woff2', 400, LATIN_RANGE),
    face('Amiri', 'amiri-arabic-700-normal.woff2', 700, ARABIC_RANGE),
  ].join('\n  ');
}

// ---------- shared style builders ----------

function textStyleCss(style: QBTextStyle, docDirection: QBDocument['direction']): string {
  const dir = style.direction ?? docDirection;
  return [
    `font-family:'${style.fontFamily}',${style.fontFamily === 'Amiri' ? 'serif' : 'sans-serif'}`,
    `font-size:${style.fontSize}pt`,
    `font-weight:${style.bold ? 700 : 400}`,
    style.italic ? 'font-style:italic' : '',
    style.underline ? 'text-decoration:underline' : '',
    `text-align:${style.align}`,
    `color:${style.color}`,
    `line-height:${style.lineHeight}`,
    `direction:${dir}`,
  ]
    .filter(Boolean)
    .join(';');
}

/** Absolute mm box; position is ALWAYS left/top based (explicit, never logical). */
function elementBoxCss(el: QBElement): string {
  const parts = [
    `left:${mm(el.x)}`,
    `top:${mm(el.y)}`,
    `width:${mm(el.widthMm)}`,
    `height:${mm(el.heightMm)}`,
  ];
  if (el.rotation) {
    parts.push(`transform:rotate(${round2(el.rotation)}deg)`, 'transform-origin:top left');
  }
  return parts.join(';');
}

function borderFrameCss(doc: QBDocument): string {
  const b = doc.branding;
  if (!b.showBorders || b.borderStyle === 'none') return '';
  const c = b.borderColor;
  // inset box-shadow keeps the page exactly its mm size (no layout shift)
  if (b.borderStyle === 'double') {
    return `box-shadow:inset 0 0 0 0.45mm ${c},inset 0 0 0 1.5mm #ffffff,inset 0 0 0 1.95mm ${c};`;
  }
  return `box-shadow:inset 0 0 0 0.45mm ${c};`;
}

// ---------- element renderers ----------

function renderTextElement(el: QBTextElement, doc: QBDocument): string {
  return `<div class="el el-text" style="${elementBoxCss(el)};${textStyleCss(el.style, doc.direction)}">${esc(el.content.text)}</div>`;
}

function headerMetaHtml(doc: QBDocument, headerSizePt: number): string {
  const b = doc.branding;
  const items = [b.subtitle, b.academicYear, b.duration]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
  if (items.length === 0) return '';
  const size = Math.max(7, Math.round(headerSizePt * 0.6));
  const sep = `<span class="hdr-meta-sep">•</span>`;
  return `<div class="hdr-meta" style="font-size:${size}pt">${items.map((s) => esc(s)).join(sep)}</div>`;
}

function renderHeaderElement(el: QBHeaderElement, doc: QBDocument): string {
  const c = el.content;
  const eff =
    c.level === 1
      ? el.style.fontSize
      : Math.max(c.level === 2 ? el.style.fontSize - 2 : el.style.fontSize - 4, 8);
  const style: QBTextStyle = {
    ...el.style,
    fontSize: eff,
    bold: el.style.bold || c.level <= 2,
  };
  const meta = c.showMeta ? headerMetaHtml(doc, eff) : '';
  return `<div class="el" style="${elementBoxCss(el)}"><div class="hdr" style="${textStyleCss(style, doc.direction)}">${esc(c.text)}${meta}</div></div>`;
}

function renderImageElement(
  el: QBImageElement | QBLogoElement,
  _doc: QBDocument,
  kind: 'image' | 'logo'
): string {
  const fit = kind === 'logo' || !('fit' in el.content) ? 'contain' : el.content.fit;
  return `<div class="el" style="${elementBoxCss(el)}"><img src="${esc(el.content.dataUrl)}" style="width:100%;height:100%;object-fit:${fit};display:block" alt=""></div>`;
}

function questionInnerHtml(el: QBQuestionElement, q: QBQuestion, doc: QBDocument): string {
  const c = el.content;
  const isRtl = doc.direction === 'rtl';
  const parts: string[] = [];

  // Paper font scale (port of original design.font s/m/l) — render-time only,
  // never stored: 's' ×0.85, 'm' ×1, 'l' ×1.18 applied to question text.
  const scale = doc.branding.fontScale === 's' ? 0.85 : doc.branding.fontScale === 'l' ? 1.18 : 1;
  const styleCss = textStyleCss(
    scale === 1 ? el.style : { ...el.style, fontSize: Math.round(el.style.fontSize * scale * 10) / 10 },
    doc.direction
  );

  const numberPrefix = c.showNumber ? `<b class="q-number">${q.number}. </b>` : '';
  const marksSuffix = c.showMarks
    ? ` <span class="q-marks">(${q.marks} ${isRtl ? 'درجات' : 'marks'})</span>`
    : '';
  parts.push(`<div class="q-prompt">${numberPrefix}${esc(q.prompt)}${marksSuffix}</div>`);

  if (q.imageDataUrl) {
    parts.push(`<img class="q-image" src="${esc(q.imageDataUrl)}" alt="">`);
  }

  if (q.options.length > 0) {
    const items = q.options
      .map(
        (o) =>
          `<span class="q-option">${c.showOptionLetter ? `<b>${esc(o.id)})</b> ` : ''}${esc(o.text)}</span>`
      )
      .join('');
    const layoutClass =
      c.optionLayout === 'inline'
        ? 'q-opt-inline'
        : c.optionLayout === 'grid2'
          ? 'q-opt-grid2'
          : 'q-opt-vertical';
    parts.push(`<div class="q-options ${layoutClass}">${items}</div>`);
  }

  return `<div class="q" style="${styleCss}">${parts.join('')}</div>`;
}

function renderQuestionElement(el: QBQuestionElement, doc: QBDocument): string {
  const q = doc.questions.find((qq) => qq.id === el.content.questionId);
  // Unknown questionId (sanitizer normally strips these) → empty box, never raw HTML.
  const inner = q ? questionInnerHtml(el, q, doc) : '';
  return `<div class="el" style="${elementBoxCss(el)}">${inner}</div>`;
}

function renderShapeElement(el: QBShapeElement, doc: QBDocument): string {
  const c = el.content;
  const border =
    c.strokeWidth > 0 ? `border:${mm(c.strokeWidth)} solid ${c.stroke};` : '';
  const radius = c.shape === 'ellipse' ? 'border-radius:50%;' : '';
  return `<div class="el" style="${elementBoxCss(el)}"><div style="width:100%;height:100%;${border}${radius}background:${c.fill};"></div></div>`;
}

function renderLineElement(el: QBLineElement, doc: QBDocument): string {
  const c = el.content;
  const dash = c.dash === 'dashed' ? 'dashed' : 'solid';
  return `<div class="el" style="${elementBoxCss(el)}"><div style="width:100%;border-top:${mm(c.strokeWidth)} ${dash} ${c.stroke};"></div></div>`;
}

function renderPageNumberElement(
  el: QBPageNumberElement,
  doc: QBDocument,
  pageIndex: number,
  pageCount: number
): string {
  const label =
    doc.direction === 'rtl'
      ? `صفحة ${pageIndex + 1} من ${pageCount}`
      : `Page ${pageIndex + 1} of ${pageCount}`;
  return `<div class="el" style="${elementBoxCss(el)};display:flex;align-items:center;justify-content:center"><div style="${textStyleCss(el.style, doc.direction)}">${esc(label)}</div></div>`;
}

function renderNameFieldsElement(el: QBNameFieldsElement, doc: QBDocument): string {
  const c = el.content;
  const dir = el.style.direction ?? doc.direction;
  const idLabel = dir === 'rtl' ? 'رقم الطالب' : 'Student ID';
  const rows: string[] = [];
  for (const field of c.fields) {
    rows.push(
      `<div class="nf-row"><span class="nf-label">${esc(field)}:</span><span class="nf-leader"></span></div>`
    );
  }
  if (c.showStudentId) {
    rows.push(
      `<div class="nf-row"><span class="nf-label">${esc(idLabel)}:</span><span class="nf-id">______</span></div>`
    );
  }
  return `<div class="el" style="${elementBoxCss(el)};${textStyleCss(el.style, doc.direction)}"><div class="nf">${rows.join('')}</div></div>`;
}

function renderElement(
  el: QBElement,
  doc: QBDocument,
  pageIndex: number,
  pageCount: number
): string {
  switch (el.type) {
    case 'text':
      return renderTextElement(el, doc);
    case 'header':
      return renderHeaderElement(el, doc);
    case 'image':
      return renderImageElement(el, doc, 'image');
    case 'logo':
      return renderImageElement(el, doc, 'logo');
    case 'question':
      return renderQuestionElement(el, doc);
    case 'shape':
      return renderShapeElement(el, doc);
    case 'line':
      return renderLineElement(el, doc);
    case 'page-number':
      return renderPageNumberElement(el, doc, pageIndex, pageCount);
    case 'name-fields':
      return renderNameFieldsElement(el, doc);
    default:
      return '';
  }
}

// ---------- page + document ----------

/** Render ONE physical page (including its border frame) as a `.page` div. */
export function renderExamPage(doc: QBDocument, pageIndex: number): string {
  const pageCount = Math.max(1, doc.pageCount);
  const elements = doc.elements.filter(
    (el) => el.page === pageIndex && el.visible !== false
  );
  const frameCss = borderFrameCss(doc);
  const frame = frameCss ? `<div class="page-frame" style="${frameCss}"></div>` : '';
  // Accent bar (port of original design.color) — thin colored bar at the top
  // of every page, full printable width, under any border frame.
  const accent = doc.branding.accentColor
    ? `<div class="accent-bar" style="background:${doc.branding.accentColor}"></div>`
    : '';
  // Footer line (port of original design.footer) — bottom of the LAST page only.
  const footer =
    doc.branding.footer && pageIndex === pageCount - 1
      ? `<div class="page-foot">${esc(doc.branding.footer)}</div>`
      : '';
  const body = elements.map((el) => renderElement(el, doc, pageIndex, pageCount)).join('\n');
  return `<div class="page">${frame}${accent}\n${body}\n${footer}\n</div>`;
}

/**
 * Canonical exam HTML. The SAME output drives:
 *  - on-screen preview  → renderExamHtml(doc, { mode: 'embed' })  (iframe srcDoc)
 *  - PDF                → renderExamHtml(doc)  (print mode, fed to Puppeteer)
 */
export function renderExamHtml(doc: QBDocument, opts?: RenderExamOptions): string {
  const mode = opts?.mode ?? 'print';
  const embed = mode === 'embed';
  const W = doc.pageSize.widthMm;
  const H = doc.pageSize.heightMm;
  const pageCount = Math.max(1, doc.pageCount);

  const pages: string[] = [];
  for (let p = 0; p < pageCount; p++) {
    pages.push(renderExamPage(doc, p));
  }

  return `<!DOCTYPE html>
<html lang="${doc.direction === 'rtl' ? 'ar' : 'en'}">
<head>
<meta charset="utf-8">
<title>${esc(doc.branding.examTitle)}</title>
<style>
  ${fontFaceCss()}
  @page { size: ${mm(W)} ${mm(H)}; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { ${embed ? 'background: #f1f5f9;' : 'background: #ffffff;'} }
  body {
    font-family: 'Tajawal', sans-serif;
    color: #111827;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page {
    width: ${mm(W)};
    height: ${mm(H)};
    position: relative;
    background: #ffffff;
    overflow: hidden;
    page-break-after: always;${embed ? '\n    margin: 12px auto;\n    box-shadow: 0 3px 18px rgba(15, 23, 42, 0.18);' : ''}
  }
  .page:last-child { page-break-after: auto; }
  .page-frame { position: absolute; inset: 0; pointer-events: none; }
  .accent-bar { position: absolute; top: ${mm(doc.margins.topMm > 6 ? doc.margins.topMm - 6 : 2)}; left: ${mm(doc.margins.leftMm)}; right: ${mm(doc.margins.rightMm)}; height: ${mm(2.2)}; border-radius: ${mm(1.5)}; }
  .page-foot { position: absolute; bottom: ${mm(Math.max(4, doc.margins.bottomMm - 4))}; left: ${mm(doc.margins.leftMm)}; right: ${mm(doc.margins.rightMm)}; padding-top: ${mm(1.5)}; border-top: 0.3mm solid #cbd5e1; color: #64748b; font-size: 8.5pt; text-align: center; white-space: pre-wrap; }
  .el { position: absolute; }
  .el-text { white-space: pre-wrap; overflow: visible; }
  .hdr-meta { color: #64748b; font-weight: 400; margin-top: 1mm; }
  .hdr-meta-sep { opacity: 0.55; padding: 0 1.2mm; }
  .q-prompt { white-space: pre-wrap; }
  .q-number { font-weight: 700; }
  .q-marks { color: #64748b; font-size: 0.75em; font-weight: 400; }
  .q-image { display: block; max-height: 30mm; max-width: 100%; margin-top: 1mm; }
  .q-options { margin-top: 1mm; }
  .q-opt-inline { display: flex; flex-wrap: wrap; column-gap: 6mm; row-gap: 0.5mm; }
  .q-opt-grid2 { display: grid; grid-template-columns: 1fr 1fr; column-gap: 6mm; row-gap: 0.8mm; }
  .q-opt-vertical { display: flex; flex-direction: column; row-gap: 0.6mm; }
  .q-option { white-space: pre-wrap; }
  .nf { display: flex; flex-direction: column; gap: 2mm; width: 100%; }
  .nf-row { display: flex; align-items: flex-end; gap: 1.5mm; }
  .nf-label { white-space: nowrap; }
  .nf-leader { flex: 1; height: 0.4em; border-bottom: 0.3mm dotted currentColor; }
  .nf-id { letter-spacing: 0.5mm; }
</style>
</head>
<body>
<div class="doc" dir="${doc.direction}">
${pages.join('\n')}
</div>
</body>
</html>`;
}
