// Exporters: CSV (Excel-safe), XLSX (SheetJS), PDF report (pdf-lib), TSV
// clipboard, and template JSON. All run in the browser.

import type { FormTemplate, SheetResult } from './types';
import { gradedQuestionNumbers } from './grading';
import { gradeResults } from './grading';

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function displayValue(r: SheetResult, field: string, lang: 'ar' | 'en'): string {
  if (field === 'file_name') return r.fileName;
  const v = r.fields[field];
  if (!v) return '';
  switch (v.status) {
    case 'blank':
      return lang === 'ar' ? '(فارغ)' : '(blank)';
    case 'multiple':
      return (v.labels ?? []).join(',') + (lang === 'ar' ? '*' : '*');
    case 'unreadable':
      return lang === 'ar' ? '(غير مقروء)' : '(unreadable)';
    default:
      return (v.labels ?? []).join(',') || v.text || '';
  }
}

export function buildCsv(results: SheetResult[], template: FormTemplate, lang: 'ar' | 'en'): string {
  const graded = gradedQuestionNumbers(template);
  const { perSheet } = gradeResults(results, template);
  const scoreById = new Map(perSheet.map((s) => [s.sheetId, s]));
  const header = [
    'file_name',
    ...results[0]?.fieldOrder.slice(1) ?? templateOrder(template),
    ...graded.map((q) => `Q${q}_result`),
    'score',
    'percentage',
    'flags',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of results) {
    const cols = r.fieldOrder.length > 1 ? r.fieldOrder : templateOrder(template);
    const s = scoreById.get(r.sheetId);
    const cells = [
      csvCell(r.fileName),
      ...cols.slice(1).map((f) => csvCell(displayValue(r, f, lang))),
      ...graded.map((q) => {
        const v = findOmr(r, q);
        if (!v) return csvCell('');
        const answer = (v.labels ?? []).join(',');
        if (v.status === 'multiple') return csvCell('*');
        if (v.status === 'blank') return csvCell('');
        return csvCell(answer === template.key[String(q)] ? '1' : '0');
      }),
      csvCell(s?.score ?? ''),
      csvCell(s?.percentage ?? ''),
      csvCell(r.flags.join('|')),
    ];
    lines.push(cells.join(','));
  }
  // BOM so Excel opens Arabic correctly
  return '\uFEFF' + lines.join('\r\n');
}

function templateOrder(template: FormTemplate): string[] {
  const out: string[] = ['file_name'];
  template.areas.forEach((a, i) => {
    const n = i + 1;
    if (a.type === 'bcr') out.push(`BCR-${n}`);
    else if (a.type === 'ocr') out.push(`OCR-${n}`);
    else {
      const count = Math.max(1, a.questions ?? 1);
      for (let q = 0; q < count; q++) out.push(`OMR-${n}-${q + 1}`);
    }
  });
  return out;
}

function findOmr(r: SheetResult, q: number): SheetResult['fields'][string] | undefined {
  for (const key of Object.keys(r.fields)) {
    const v = r.fields[key];
    if (v.kind === 'omr' && v.question === q) return v;
  }
  return undefined;
}

export async function buildXlsx(
  results: SheetResult[],
  template: FormTemplate,
  lang: 'ar' | 'en'
): Promise<Blob> {
  const XLSX = await import('xlsx');
  const graded = gradedQuestionNumbers(template);
  const report = gradeResults(results, template);
  const scoreById = new Map(report.perSheet.map((s) => [s.sheetId, s]));

  const header = ['file_name', ...(results[0]?.fieldOrder.slice(1) ?? templateOrder(template).slice(1)), 'score', 'percentage', 'flags'];
  const rows: (string | number)[][] = [header];
  for (const r of results) {
    const cols = r.fieldOrder.length > 1 ? r.fieldOrder : templateOrder(template);
    const s = scoreById.get(r.sheetId);
    rows.push([
      r.fileName,
      ...cols.slice(1).map((f) => displayValue(r, f, lang)),
      s?.score ?? '',
      s?.percentage ?? '',
      r.flags.join('|'),
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);

  const itemRows: (string | number)[][] = [
    ['question', 'key', 'percent_correct', 'correct', 'wrong', 'blank', 'multiple'],
    ...report.items.map((it) => [it.question, it.key, it.percentCorrect, it.correct, it.wrong, it.blank, it.multiple]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(itemRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  XLSX.utils.book_append_sheet(wb, ws2, 'Item analysis');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function buildTsv(results: SheetResult[], template: FormTemplate, lang: 'ar' | 'en'): string {
  const { perSheet } = gradeResults(results, template);
  const scoreById = new Map(perSheet.map((s) => [s.sheetId, s]));
  const header = ['file_name', ...(results[0]?.fieldOrder.slice(1) ?? templateOrder(template).slice(1)), 'score', 'percentage'];
  const lines = [header.join('\t')];
  for (const r of results) {
    const cols = r.fieldOrder.length > 1 ? r.fieldOrder : templateOrder(template);
    const s = scoreById.get(r.sheetId);
    lines.push(
      [
        r.fileName,
        ...cols.slice(1).map((f) => displayValue(r, f, lang)),
        s?.score ?? '',
        s?.percentage ?? '',
      ].join('\t')
    );
  }
  return lines.join('\n');
}

/** Sanitize to WinAnsi (pdf-lib standard fonts can't encode Arabic). */
function latin(s: string): string {
  return s.replace(/[^\x20-\x7E\n]/g, '?');
}

export async function buildPdfReport(results: SheetResult[], template: FormTemplate): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const report = gradeResults(results, template);
  const scoreById = new Map(report.perSheet.map((s) => [s.sheetId, s]));

  const pageW = 595.28;
  const pageH = 841.89;
  const margin = 42;

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;

  const newPage = () => {
    page = doc.addPage([pageW, pageH]);
    y = pageH - margin;
  };
  const ensure = (h: number) => {
    if (y - h < margin) newPage();
  };
  const text = (
    s: string,
    x: number,
    size: number,
    isBold = false,
    color = rgb(0.1, 0.1, 0.1)
  ) => {
    page.drawText(latin(s), { x, y, size, font: isBold ? bold : font, color });
  };

  // Title block
  text(`Forms scanner report — ${template.name}`, margin, 16, true);
  y -= 20;
  text(`Sheets: ${results.length} • Graded questions: ${report.gradedQuestions.length} • Total weight: ${report.totalWeight}`, margin, 10);
  y -= 24;

  // Per-sheet table
  ensure(30);
  text('Per-sheet results', margin, 12, true);
  y -= 16;
  const colX = [margin, margin + 250, margin + 320, margin + 390, margin + 450];
  text('File', colX[0], 9, true);
  text('Score', colX[1], 9, true);
  text('%', colX[2], 9, true);
  text('C/W/B', colX[3], 9, true);
  text('Flags', colX[4], 9, true);
  y -= 12;
  for (const r of results) {
    ensure(16);
    const s = scoreById.get(r.sheetId);
    text(r.fileName.slice(0, 40), colX[0], 8);
    text(`${s?.score ?? ''}/${s?.maxScore ?? ''}`, colX[1], 8);
    text(`${s?.percentage ?? ''}%`, colX[2], 8);
    text(`${s?.correct ?? 0}/${s?.wrong ?? 0}/${s?.blank ?? 0}`, colX[3], 8);
    text(r.flags.join(',').slice(0, 24) || '-', colX[4], 8);
    y -= 13;
  }

  // Item analysis
  ensure(40);
  y -= 10;
  text('Item analysis (percent correct per question)', margin, 12, true);
  y -= 16;
  const perRow = 8;
  for (let i = 0; i < report.items.length; i += perRow) {
    ensure(20);
    const chunk = report.items.slice(i, i + perRow);
    chunk.forEach((it, k) => {
      const x = margin + k * 64;
      text(`Q${it.question}`, x, 8, true);
      text(`${it.percentCorrect}%`, x, 8);
      text(`key ${it.key}`, x, 7, false, rgb(0.45, 0.45, 0.45));
    });
    y -= 26;
  }

  const bytes = await doc.save();
  return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
}

export function templateToJson(template: FormTemplate): string {
  return JSON.stringify({ ...template, exportedAt: new Date().toISOString() }, null, 2);
}
