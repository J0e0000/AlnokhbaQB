// Annotation model + flattening for Sign / Edit / Redact.
//
// Coordinate system: PDF points relative to the page's scale-1 viewport with a
// TOP-LEFT origin (matches pdf.js previews). Flattening converts to pdf-lib's
// bottom-left origin. Redaction goes further: affected pages are rasterized so
// the content under the box is truly removed, not just covered.

import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { bytesToDataUrl } from '../blob';
import { saveDoc } from './organize';
import { rasterizePdf } from './raster';
import { baseName } from '../blob';
import type { OptionValues, OutFile, RunCtx } from '../types';

export interface BaseAnn {
  page: number; // 0-based
  x: number;    // points, top-left origin
  y: number;
  w: number;
  h: number;
}

export type Annotation = BaseAnn &
  (
    | { kind: 'text'; text: string; size: number; color: string }
    | { kind: 'rect'; color: string; opacity: number; stroke: boolean }
    | { kind: 'image'; dataUrl: string; opacity?: number; rotation?: number }
  );

function hexRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const int = parseInt(v.slice(0, 6) || '000000', 16);
  return { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 };
}

async function dataUrlToPngBytes(doc: PDFDocument, dataUrl: string) {
  const res = await fetch(dataUrl);
  const buf = await res.arrayBuffer();
  return doc.embedPng(buf);
}

/** Draw annotations onto pages with pdf-lib (used by Sign + Edit). */
export async function flattenAnnotations(
  file: File,
  annotations: Annotation[],
  pageSizes: { widthPt: number; heightPt: number }[],
  ctx?: RunCtx
): Promise<OutFile[]> {
  const doc = await PDFDocument.load(await file.arrayBuffer(), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  let done = 0;
  for (const ann of annotations) {
    const page = pages[ann.page];
    if (!page) continue;
    const { height } = page.getSize();
    const yTop = height - ann.y; // convert top-left -> bottom-left origin
    if (ann.kind === 'text') {
      const c = hexRgb(ann.color);
      page.drawText(ann.text, {
        x: ann.x,
        // drawText y is the baseline; our y is the top of the box
        y: yTop - ann.size,
        size: ann.size,
        font: boldFont,
        color: rgb(c.r, c.g, c.b),
      });
    } else if (ann.kind === 'rect') {
      const c = hexRgb(ann.color);
      if (ann.stroke) {
        page.drawRectangle({
          x: ann.x,
          y: yTop - ann.h,
          width: ann.w,
          height: ann.h,
          borderColor: rgb(c.r, c.g, c.b),
          borderWidth: 2,
          opacity: 0,
          borderOpacity: 1,
        });
      } else {
        page.drawRectangle({
          x: ann.x,
          y: yTop - ann.h,
          width: ann.w,
          height: ann.h,
          color: rgb(c.r, c.g, c.b),
          opacity: ann.opacity,
        });
      }
    } else if (ann.kind === 'image') {
      const image = await dataUrlToPngBytes(doc, ann.dataUrl);
      page.drawImage(image, {
        x: ann.x,
        y: yTop - ann.h,
        width: ann.w,
        height: ann.h,
        rotate: degrees(ann.rotation ?? 0),
        opacity: ann.opacity ?? 1,
      });
    }
    done++;
    ctx?.onProgress(`Writing annotation ${done}/${annotations.length}…`, Math.round((done / Math.max(1, annotations.length)) * 90));
  }
  return [await saveDoc(doc, `${baseName(file.name)}_edited.pdf`, `${annotations.length} annotation${annotations.length === 1 ? '' : 's'} applied`)];
}

/**
 * Redact: rasterize every page that carries boxes (the whole page becomes a
 * flat image with boxes burned in), leaving untouched pages vectorial.
 * This genuinely removes the text under the boxes from the page content.
 */
export async function flattenRedaction(
  file: File,
  boxesByPage: Record<number, { x: number; y: number; w: number; h: number }[]>, // page (0-based) -> boxes in pt, top-left origin
  opts: OptionValues,
  ctx: RunCtx
): Promise<OutFile[]> {
  const affected = Object.keys(boxesByPage)
    .map(Number)
    .filter((p) => boxesByPage[p]?.length > 0)
    .sort((a, b) => a - b);
  if (affected.length === 0) throw new Error('Draw at least one redaction box');

  const color = String(opts.color ?? '#000000');
  ctx.onProgress(`Rasterizing ${affected.length} redacted page${affected.length > 1 ? 's' : ''}…`, 10);
  const scale = 2;
  const rasters = await rasterizePdf(file, {
    scale,
    format: 'image/jpeg',
    quality: 0.92,
    onProgress: (done, total, message) => ctx.onProgress(message, 10 + Math.round((done / total) * 70)),
  });

  const doc = await PDFDocument.load(await file.arrayBuffer(), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const rasterMap = new Map(rasters.map((r) => [r.page - 1, r]));
  const base = await PDFDocument.create();

  for (let i = 0; i < doc.getPageCount(); i++) {
    const raster = rasterMap.get(i);
    if (raster) {
      // Draw the flattened page plus opaque boxes.
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(raster.widthPt * scale);
      canvas.height = Math.round(raster.heightPt * scale);
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) throw new Error('Canvas is not supported in this browser');
      const img = new Image();
      img.src = bytesToDataUrl(await raster.blob.arrayBuffer(), 'image/jpeg');
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to decode rendered page'));
      });
      ctx2d.drawImage(img, 0, 0);
      ctx2d.fillStyle = color;
      for (const b of boxesByPage[i] ?? []) {
        ctx2d.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
      }
      const pngBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), 'image/png')
      );
      const image = await base.embedPng(await pngBlob.arrayBuffer());
      const page = base.addPage([raster.widthPt, raster.heightPt]);
      page.drawImage(image, { x: 0, y: 0, width: raster.widthPt, height: raster.heightPt });
    } else {
      const [copied] = await base.copyPages(doc, [i]);
      base.addPage(copied);
    }
    ctx.onProgress(`Rebuilding page ${i + 1}/${doc.getPageCount()}…`, 70 + Math.round(((i + 1) / doc.getPageCount()) * 25));
  }
  const out = await saveDoc(base, `${baseName(file.name)}_redacted.pdf`, `${affected.length} page${affected.length === 1 ? '' : 's'} flattened & redacted`);
  ctx.onProgress('Done', 100);
  return [out];
}
