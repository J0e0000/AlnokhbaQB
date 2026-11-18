// Printable answer-sheet generator: emits a PDF with fiducial corner markers,
// a QR serial, name/date fields and bubble grids — plus the exact matching
// FormTemplate JSON, so generated sheets read perfectly after scanning.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { FormTemplate, FormMarker, FormArea } from './types';
import { makeTemplate } from './types';

export interface GeneratorOptions {
  title: string;
  questions: number;
  labels: string[];
  orientation: 'down' | 'across';
  copies: number;
  includeQr: boolean;
}

// A4 in points
const W = 595.28;
const H = 841.89;
const M = 18; // marker size (pt)
const MO = 20; // marker offset from the page corner
const ROW_H = 24;
const LABEL_W = 34;
const GRID_TOP = 170;
const GRID_BOTTOM = H - 60;

function normalizedMarkers(): FormMarker[] {
  // template coordinate space: top-left origin, normalized 0..1
  return [
    { x: MO / W, y: MO / H, w: M / W, h: M / H },
    { x: (W - MO - M) / W, y: MO / H, w: M / W, h: M / H },
    { x: MO / W, y: (H - MO - M) / H, w: M / W, h: M / H },
  ];
}

export function buildGeneratorTemplate(opts: GeneratorOptions): FormTemplate {
  const areas = layoutAreas(opts);
  return makeTemplate({
    name: opts.title || 'Generated form',
    areas,
    markers: normalizedMarkers(),
    threshold: 0.12,
    lenient: false,
    refWidth: 1240, // A4 @150dpi aspect-true reference size for warping
    refHeight: Math.round((1240 * H) / W),
  });
}

function layoutAreas(opts: GeneratorOptions): FormArea[] {
  const nLabels = opts.labels.length;
  const perBlock = Math.floor((GRID_BOTTOM - GRID_TOP) / ROW_H);
  const blockW = 46 + nLabels * LABEL_W;
  const gridLeft = 58;
  const gridRight = W - 40;
  const perRow = Math.max(1, Math.floor((gridRight - gridLeft) / blockW));
  const total = Math.max(1, Math.min(300, opts.questions));
  const blocks = Math.ceil(total / perBlock);
  const rows = Math.ceil(blocks / perRow);
  if (rows > 1) {
    // stack rows of blocks vertically → shrink row height so everything fits
    throw new Error(
      `Too many questions for one page (max ≈ ${perBlock * perRow} with ${nLabels} options). Split the form into several areas by hand, or reduce questions.`
    );
  }

  const areas: FormArea[] = [];
  let q = 0;
  for (let b = 0; b < blocks && q < total; b++) {
    const col = b % perRow;
    const count = Math.min(perBlock, total - q);
    const bx = gridLeft + col * blockW;
    const by = GRID_TOP;
    areas.push({
      id: `gen-${b}`,
      type: 'omr',
      name: `Generated Q${q + 1}–${q + count}`,
      x: bx / W,
      y: by / H,
      // the area spans exactly the bubble columns (question-number gutter excluded)
      w: (nLabels * LABEL_W) / W,
      h: (count * ROW_H) / H,
      questions: count,
      labels: opts.labels,
      orientation: opts.orientation,
    });
    q += count;
  }
  return areas;
}

/**
 * Render text (any script — Arabic included) to a crisp PNG via canvas,
 * because pdf-lib standard fonts only encode WinAnsi.
 */
async function textToPng(text: string, fontPx: number, bold: boolean, color = '#111111'): Promise<{ bytes: Uint8Array; widthPt: number; heightPt: number } | null> {
  if (!text) return null;
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  const family = 'Tajawal, "Segoe UI", sans-serif';
  const fontSpec = `${bold ? '700' : '400'} ${fontPx * 2}px ${family}`;
  measure.font = fontSpec;
  const w = Math.ceil(measure.measureText(text).width) + 16;
  const h = Math.ceil(fontPx * 2 * 1.7);
  if (w <= 16 || h <= 8) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.font = fontSpec;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, h / 2);
  const url = c.toDataURL('image/png');
  const b64 = url.split(',')[1] ?? '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, widthPt: w / 2, heightPt: h / 2 };
}

export async function generateSheetsPdf(opts: GeneratorOptions): Promise<{ blob: Blob; template: FormTemplate }> {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const template = buildGeneratorTemplate(opts);

  const titleImg = await textToPng(opts.title || 'Answer sheet', 15, true);
  const titleImage = titleImg ? await doc.embedPng(titleImg.bytes) : null;

  let QR_PNG: Uint8Array | null = null;
  if (opts.includeQr) {
    const QRCode = (await import('qrcode')).default;
    const url = await QRCode.toDataURL(`${opts.title || 'FORM'}|sheet|{n}|${opts.copies}`, {
      margin: 0,
      width: 240,
      errorCorrectionLevel: 'M',
    });
    const b64 = url.split(',')[1] ?? '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    QR_PNG = bytes;
  }
  const qrImage = QR_PNG ? await doc.embedPng(QR_PNG) : null;

  for (let copy = 1; copy <= opts.copies; copy++) {
    const page = doc.addPage([W, H]);

    // fiducial markers (solid black squares; y conversion: pdf origin is bottom-left)
    const drawMarker = (xTopLeft: number, yTopLeft: number) => {
      page.drawRectangle({ x: xTopLeft, y: H - yTopLeft - M, width: M, height: M, color: rgb(0, 0, 0) });
    };
    drawMarker(MO, MO);
    drawMarker(W - MO - M, MO);
    drawMarker(MO, H - MO - M);

    // header (canvas-rendered image → any script, Arabic included)
    if (titleImage && titleImg) {
      page.drawImage(titleImage, { x: (W - titleImg.widthPt) / 2, y: H - 66 - titleImg.heightPt / 2, width: titleImg.widthPt, height: titleImg.heightPt });
    }
    const sub = `Questions: ${opts.questions}   Options: ${opts.labels.join(' ')}`;
    const sw = reg.widthOfTextAtSize(sub, 9);
    page.drawText(sub, { x: (W - sw) / 2, y: H - 82, size: 9, font: reg, color: rgb(0.35, 0.35, 0.35) });

    // QR serial (top-right, below the TR marker)
    if (qrImage) {
      const qs = 76;
      page.drawImage(qrImage, { x: W - MO - qs - 14, y: H - 150, width: qs, height: qs });
      const serial = `${copy}/${opts.copies}`;
      page.drawText(`#${serial}`, { x: W - MO - qs - 14, y: H - 163, size: 8, font: reg, color: rgb(0.3, 0.3, 0.3) });
    }

    // name / date fields (pdf-lib lines have no dash option — draw manual dashes)
    const dashedLine = (x0: number, x1: number, yTop: number) => {
      const y = H - yTop;
      for (let x = x0; x < x1; x += 5) {
        page.drawLine({ start: { x, y }, end: { x: Math.min(x1, x + 2.5), y }, thickness: 0.8, color: rgb(0.55, 0.55, 0.55) });
      }
    };
    page.drawText('Name:', { x: 58, y: H - 130, size: 10, font: reg });
    dashedLine(96, 300, 132);
    page.drawText('Date:', { x: 330, y: H - 130, size: 10, font: reg });
    dashedLine(362, 470, 132);

    // bubble grids
    let qNumber = 1;
    template.areas.forEach((area) => {
      const labels = area.labels ?? [];
      const count = area.questions ?? 1;
      const bx = area.x * W;
      const byTop = area.y * H;
      const across = area.orientation === 'across';
      const rowsN = across ? labels.length : count;
      const colsN = across ? count : labels.length;
      const cellW = (area.w * W) / colsN;
      const cellH = (area.h * H) / rowsN;

      for (let qIn = 0; qIn < count; qIn++) {
        // question number in the gutter, right-aligned to the bubble start
        const rowY = byTop + (across ? 0 : qIn * cellH) + cellH / 2;
        const gutterX = bx - 12;
        const label = String(qNumber + qIn);
        const nw = reg.widthOfTextAtSize(label, 8);
        page.drawText(label, { x: gutterX - nw, y: H - rowY - 3, size: 8, font: reg, color: rgb(0.25, 0.25, 0.25) });

        labels.forEach((lb, o) => {
          const i = across ? o : qIn;
          const j = across ? qIn : o;
          const cx = bx + (j + 0.5) * cellW;
          const cy = byTop + (i + 0.5) * cellH;
          const bw = Math.min(15, cellW * 0.62);
          const bh = Math.min(13, cellH * 0.58);
          page.drawRectangle({
            x: cx - bw / 2,
            y: H - cy - bh / 2,
            width: bw,
            height: bh,
            borderColor: rgb(0.1, 0.1, 0.1),
            borderWidth: 1,
            borderOpacity: 0.85,
          });
          const lw = reg.widthOfTextAtSize(lb, 7);
          page.drawText(lb, { x: cx - lw / 2, y: H - cy + 2.5, size: 7, font: reg, color: rgb(0.42, 0.42, 0.42) });
        });
      }
      qNumber += count;
    });
  }

  const bytes = await doc.save();
  return { blob: new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), template };
}
