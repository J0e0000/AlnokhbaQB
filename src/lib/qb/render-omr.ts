// ============================================================
// ALNOKHBA QB — OMR Sheet Renderer (hybrid SVG + HTML)
// - SVG layer: bubbles, markers, QR, frame, lines (the geometry
//   the recognition engine depends on; exact mm coordinates).
// - HTML layer: all text (Arabic/English) — CSS handles bidi and
//   alignment reliably, unlike SVG text anchoring for RTL.
// The SAME template JSON drives this renderer AND the Python
// engine → generator/reader can never drift.
// ============================================================

import type { OMRTemplate } from './types';

const QR_GROUP_CACHE = new Map<string, string>();

/** Render a QR payload as a black/white SVG group string (vector, crisp). */
function qrSvgGroup(payload: string, x: number, y: number, sizeMm: number): string {
  let group = QR_GROUP_CACHE.get(payload);
  if (!group) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const QRCode = require('qrcode') as typeof import('qrcode');
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const data = qr.modules.data;
    const cell = 1 / size;
    let path = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (data[r * size + c]) {
          path += `M${(c * cell).toFixed(4)} ${(r * cell).toFixed(4)}h${cell.toFixed(4)}v${cell.toFixed(4)}h-${cell.toFixed(4)}z`;
        }
      }
    }
    group = `<g transform="translate(${x} ${y}) scale(${sizeMm})"><path d="${path}" fill="#000000" shape-rendering="crispEdges"/></g>`;
    QR_GROUP_CACHE.set(payload, group);
  }
  return group;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface TxtOpts {
  size: number; // font-size in pt
  bold?: boolean;
  color?: string;
  /** right edge x in mm (right-aligned text) */
  right?: number;
  /** left edge x in mm (left-aligned text) */
  left?: number;
  /** center x in mm */
  center?: number;
  top: number; // top y in mm
}

/** Absolutely positioned HTML text node — CSS bidi/alignment, fully deterministic. */
function txt(content: string, o: TxtOpts): string {
  const styles: string[] = [
    'position:absolute',
    `top:${o.top.toFixed(2)}mm`,
    `font-size:${o.size}pt`,
    `line-height:1.1`,
    'white-space:nowrap',
    o.bold ? 'font-weight:700' : 'font-weight:400',
    `color:${o.color ?? '#000000'}`,
  ];
  if (o.right !== undefined) {
    styles.push(`right:${(210 - o.right).toFixed(2)}mm`, 'text-align:right');
  } else if (o.left !== undefined) {
    styles.push(`left:${o.left.toFixed(2)}mm`, 'text-align:left');
  } else if (o.center !== undefined) {
    styles.push(
      `left:${o.center.toFixed(2)}mm`,
      'transform:translateX(-50%)',
      'text-align:center'
    );
  }
  return `<div style="${styles.join(';')}">${escapeHtml(content)}</div>`;
}

/** Render one sheet of the OMR template. Returns the inner HTML of a .sheet div. */
export function renderOmrSheetInner(template: OMRTemplate, sheet: number): string {
  const W = template.page.widthMm;
  const H = template.page.heightMm;
  const svg: string[] = [];
  const html: string[] = [];

  // Frame (thin but solid — aids sheet edge detection)
  const f = template.frame;
  svg.push(
    `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="none" stroke="#000000" stroke-width="0.5"/>`
  );

  // Corner markers
  for (const m of template.markers) {
    svg.push(
      `<rect x="${(m.x - m.sizeMm / 2).toFixed(2)}" y="${(m.y - m.sizeMm / 2).toFixed(2)}" width="${m.sizeMm}" height="${m.sizeMm}" fill="#000000"/>`
    );
  }

  // QR (top-left)
  const payload = template.qr.payloadBySheet[sheet] ?? template.qr.payloadBySheet[0];
  svg.push(qrSvgGroup(payload, template.qr.x, template.qr.y, template.qr.sizeMm));

  // Header text
  const isMain = sheet === 0;
  html.push(txt(template.examTitle, { size: 20, bold: true, right: W - 26, top: 12 }));
  html.push(txt(`إجابة الامتحان — النسخة ${template.versionNumber}`, { size: 13, color: '#333333', right: W - 26, top: 25 }));
  if (!isMain) {
    html.push(txt(`ورقة متابعة ${sheet + 1} / ${template.sheets}`, { size: 13, color: '#333333', right: W - 26, top: 34 }));
  }

  // Student name line (sheet 0 only)
  if (isMain) {
    html.push(txt('اسم الطالب:', { size: 14, right: W - 26, top: 38 }));
    html.push(
      `<div style="position:absolute;top:41.5mm;right:${(210 - (W - 58)).toFixed(2)}mm;width:88mm;border-bottom:0.3mm dashed #000;height:5mm"></div>`
    );
  }

  const letters = Object.keys(
    template.questions[0]?.options ?? { A: 1, B: 1, C: 1, D: 1 }
  );

  // Student ID grid (sheet 0 only)
  if (isMain && template.studentId) {
    const sid = template.studentId;
    html.push(
      txt('رقم الطالب — ظلّل رقمًا واحدًا في كل عمود', { size: 12, right: 108, top: 43 })
    );
    // value labels 0..9
    for (let v = 0; v < sid.valueYs.length; v++) {
      const labelX = sid.digitColumnXs[0] - 8;
      html.push(txt(String(v), { size: 10, center: labelX, top: sid.valueYs[v] - 1.7 }));
    }
    // digit position labels + bubbles
    for (let d = 0; d < sid.digits; d++) {
      const cx = sid.digitColumnXs[d];
      html.push(txt(String(d + 1), { size: 8, color: '#555555', center: cx, top: 44.6 }));
      for (let v = 0; v < sid.valueYs.length; v++) {
        svg.push(
          `<circle cx="${cx.toFixed(2)}" cy="${sid.valueYs[v].toFixed(2)}" r="${sid.bubbleRMm.toFixed(2)}" fill="none" stroke="#000000" stroke-width="0.30"/>`
        );
      }
    }
  }

  // Question grid
  const firstRowY = isMain ? template.grid.firstRowYMm.main : template.grid.firstRowYMm.continuation;
  const headerY = isMain ? 104 : 48;
  const cols = template.grid.columnLeftsMm.length;

  for (let printedCol = 0; printedCol < cols; printedCol++) {
    const colLeft = template.grid.columnLeftsMm[printedCol];
    const colQuestions = template.questions.filter(
      (q) => q.sheet === sheet && q.column === printedCol
    );
    if (colQuestions.length === 0) continue;
    const minN = Math.min(...colQuestions.map((q) => q.number));
    const maxN = Math.max(...colQuestions.map((q) => q.number));
    html.push(
      txt(`س ${minN}–${maxN}`, {
        size: 11,
        bold: true,
        center: colLeft + template.grid.columnWidthMm / 2 - 6,
        top: headerY - 4.4,
      })
    );
    // Option letters header
    letters.forEach((letter, oi) => {
      const oiPrinted = template.direction === 'rtl' ? letters.length - 1 - oi : oi;
      const bx = colLeft + template.grid.optionXsMm[oiPrinted];
      html.push(txt(letter, { size: 11, bold: true, center: bx, top: headerY + 0.4 }));
    });
    html.push(
      txt('رقم', { size: 10, color: '#444444', center: colLeft + template.grid.numberXMm, top: headerY + 0.4 })
    );
    // Rows
    for (const q of colQuestions) {
      const row = Math.round((q.options[letters[0]].y - firstRowY) / template.grid.rowPitchMm);
      const y = firstRowY + row * template.grid.rowPitchMm;
      html.push(
        txt(String(q.number), {
          size: 11,
          bold: true,
          center: colLeft + template.grid.numberXMm,
          top: y - 2,
        })
      );
      for (const letter of letters) {
        const pos = q.options[letter];
        svg.push(
          `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(2)}" r="${q.radiusMm.toFixed(2)}" fill="none" stroke="#000000" stroke-width="0.30"/>`
        );
      }
    }
  }

  // Footer note
  html.push(
    txt('استخدم قلم رصاص أو حبر أسود • ظلّل الدائرة بالكامل • لمسح إجابة امسحها جيدًا', {
      size: 11,
      color: '#444444',
      center: W / 2,
      top: H - 13,
    })
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">${svg.join('')}</svg>${html.join('')}`;
}

/** Full standalone HTML document for all sheets (print-ready, exact A4). */
export function renderOmrHtml(template: OMRTemplate): string {
  const pages: string[] = [];
  for (let s = 0; s < template.sheets; s++) {
    pages.push(
      `<div class="sheet">${renderOmrSheetInner(template, s)}</div>`
    );
  }
  return `<!DOCTYPE html>
<html lang="ar">
<head>
<meta charset="utf-8">
<style>
  @font-face { font-family: 'Tajawal'; src: url('file://${process.cwd()}/public/fonts/tajawal-arabic-400-normal.woff2') format('woff2'); font-weight: 400; }
  @font-face { font-family: 'Tajawal'; src: url('file://${process.cwd()}/public/fonts/tajawal-arabic-700-normal.woff2') format('woff2'); font-weight: 700; }
  @page { size: ${template.page.widthMm}mm ${template.page.heightMm}mm; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #ffffff; font-family: 'Tajawal', sans-serif; }
  .sheet { width: ${template.page.widthMm}mm; height: ${template.page.heightMm}mm; overflow: hidden; page-break-after: always; position: relative; }
  .sheet:last-child { page-break-after: auto; }
  svg { display: block; }
  div { font-family: 'Tajawal', sans-serif; }
</style>
</head>
<body>
${pages.join('\n')}
</body>
</html>`;
}
