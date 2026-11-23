// ============================================================
// ALNOKHBA QB — Fixed reusable answer sheet renderer
// Same SVG/HTML hybrid approach as render-omr.ts: geometry in SVG
// (exact mm), text in HTML (CSS bidi). The printed sheet carries no
// student identity — only the exam QR, the handwritten ID strip, the
// version bubble row and the numbered answer grid.
// ============================================================

import { FIXED_GEOMETRY, type FixedSheetTemplate } from './fixed-sheet';
import { qrSvgGroup, txt } from './render-omr';

export function renderFixedSheetInner(template: FixedSheetTemplate, sheet: number): string {
  const W = template.page.widthMm;
  const H = template.page.heightMm;
  const svg: string[] = [];
  const html: string[] = [];

  const f = template.frame;
  svg.push(
    `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="none" stroke="#000000" stroke-width="0.5"/>`
  );

  for (const m of template.markers) {
    const halo = m.sizeMm + 4;
    svg.push(
      `<rect x="${(m.x - halo / 2).toFixed(2)}" y="${(m.y - halo / 2).toFixed(2)}" width="${halo}" height="${halo}" fill="#ffffff"/>`,
      `<rect x="${(m.x - m.sizeMm / 2).toFixed(2)}" y="${(m.y - m.sizeMm / 2).toFixed(2)}" width="${m.sizeMm}" height="${m.sizeMm}" fill="#000000"/>`
    );
  }

  const payload = template.qr.payloadBySheet[sheet] ?? template.qr.payloadBySheet[0];
  svg.push(qrSvgGroup(payload, template.qr.x, template.qr.y, template.qr.sizeMm));

  // ---- header
  html.push(txt(template.examTitle, { size: 15, bold: true, right: W - 24, top: 7 }));
  html.push(
    txt('ورقة إجابة موحّدة — تُوزَّع على أي طالب', {
      size: 9,
      color: '#333333',
      right: W - 24,
      top: 24,
    })
  );
  if (template.sheets > 1) {
    html.push(
      txt(`صفحة ${sheet + 1} من ${template.sheets}`, {
        size: 11,
        color: '#333333',
        right: W - 26,
        top: 31,
      })
    );
  }

  // ---- handwritten student ID strip (every page: pages can arrive in any order)
  const idb = template.idBoxes;
  html.push(txt('رقم الطالب', { size: 10, bold: true, right: 112, top: 10 }));
  for (const box of idb.boxes) {
    svg.push(
      `<rect x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.w.toFixed(2)}" height="${box.h.toFixed(2)}" fill="none" stroke="#000000" stroke-width="0.45" rx="1.2"/>`
    );
    html.push(
      txt(String(box.index + 1), {
        size: 7,
        color: '#777777',
        center: box.x + box.w / 2,
        top: box.y + box.h + 0.6,
      })
    );
  }

  // ---- ID bubble grid (every page): the deterministic identity
  const ig = template.idGrid;
  const igY = (i: number) => ig.columns[0].yTopMm + i * ig.pitchYMm;
  html.push(txt('ظلّل رقم الطالب', { size: 8, bold: true, left: FIXED_GEOMETRY.idGrid.labelXMm - 2, top: ig.columns[0].yTopMm - 7.5 }));
  ig.columns[0].digitOrder.forEach((digit, i) => {
    html.push(txt(String(digit), { size: 7, color: '#444444', right: FIXED_GEOMETRY.idGrid.labelXMm, top: igY(i) - 1.2 }));
  });
  for (const col of ig.columns) {
    html.push(
      txt(String(col.index + 1), {
        size: 6,
        color: '#888888',
        center: col.xMm,
        top: igY(col.digitOrder.length - 1) + ig.radiusMm + 1,
      })
    );
    col.digitOrder.forEach((_digit, i) => {
      svg.push(
        `<circle cx="${col.xMm.toFixed(2)}" cy="${igY(i).toFixed(2)}" r="${ig.radiusMm.toFixed(2)}" fill="none" stroke="#000000" stroke-width="0.25"/>`
      );
    });
  }

  // ---- version bubble row (every page)
  const vm = template.versionMarks;
  html.push(txt('النسخة', { size: 11, bold: true, right: vm.xsMm[0] - 6, top: vm.yMm - 3 }));
  vm.letters.forEach((letter, i) => {
    const x = vm.xsMm[i];
    svg.push(
      `<circle cx="${x.toFixed(2)}" cy="${vm.yMm.toFixed(2)}" r="${vm.bubbleRMm.toFixed(2)}" fill="none" stroke="#000000" stroke-width="0.35"/>`
    );
    html.push(txt(letter, { size: 9, bold: true, center: x, top: vm.yMm - 5.4 }));
  });
  html.push(
    txt('ظلّل دائرة واحدة فقط', {
      size: 7,
      color: '#555555',
      left: vm.xsMm[0] - 2,
      top: vm.yMm + 3.6,
    })
  );

  // ---- answer grid
  const letters = Object.keys(template.questions[0]?.options ?? { A: 1, B: 1, C: 1, D: 1 });
  const g = template.grid;
  for (let printedCol = 0; printedCol < g.columnLeftsMm.length; printedCol++) {
    const colLeft = g.columnLeftsMm[printedCol];
    const colQuestions = template.questions.filter((q) => q.sheet === sheet && q.column === printedCol);
    if (colQuestions.length === 0) continue;
    const minN = Math.min(...colQuestions.map((q) => q.number));
    const maxN = Math.max(...colQuestions.map((q) => q.number));
    html.push(
      txt(`س ${minN}–${maxN}`, {
        size: 10,
        bold: true,
        center: colLeft + g.columnWidthMm / 2 - 6,
        top: FIXED_GEOMETRY.grid.headerY - 4.6,
      })
    );
    letters.forEach((letter, oi) => {
      const oiPrinted = template.direction === 'rtl' ? letters.length - 1 - oi : oi;
      html.push(
        txt(letter, {
          size: 10,
          bold: true,
          center: colLeft + g.optionXsMm[oiPrinted],
          top: FIXED_GEOMETRY.grid.headerY + 0.2,
        })
      );
    });
    html.push(
      txt('رقم', { size: 9, color: '#444444', center: colLeft + g.numberXMm, top: FIXED_GEOMETRY.grid.headerY + 0.2 })
    );
    for (const q of colQuestions) {
      const row = Math.round((q.options[letters[0]].y - g.firstRowYMm.main) / g.rowPitchMm);
      const y = g.firstRowYMm.main + row * g.rowPitchMm;
      html.push(
        txt(String(q.number), {
          size: 10,
          bold: true,
          center: colLeft + g.numberXMm,
          top: y - 1.9,
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

  html.push(
    txt('ظلّل الدائرة بالكامل بقلم رصاص أو حبر أسود • لتغيير إجابة امسحها جيدًا • إجابة واحدة لكل سؤال', {
      size: 9.5,
      color: '#444444',
      center: W / 2,
      top: H - 12,
    })
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">${svg.join('')}</svg>${html.join('')}`;
}

export function renderFixedSheetHtml(template: FixedSheetTemplate): string {
  const pages: string[] = [];
  for (let s = 0; s < template.sheets; s++) {
    pages.push(`<div class="sheet">${renderFixedSheetInner(template, s)}</div>`);
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
