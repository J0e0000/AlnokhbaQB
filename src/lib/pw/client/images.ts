// Image <-> PDF conversions, fully client-side.

import { PDFDocument } from 'pdf-lib';
import { baseName, canvasToBlob, bytesToDataUrl } from '../blob';
import { rasterizePdf } from './raster';
import type { OptionValues, OutFile, RunCtx } from '../types';

const A4 = { w: 595.28, h: 841.89 };

async function toEmbeddablePng(file: File): Promise<ArrayBuffer | null> {
  // JPEG/PNG embed natively; anything else (webp, gif, bmp, avif) goes through canvas.
  if (file.type === 'image/jpeg' || file.type === 'image/png') return null;
  const dataUrl = bytesToDataUrl(await file.arrayBuffer(), file.type || 'image/png');
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Cannot read image "${file.name}"`));
    img.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  ctx.drawImage(img, 0, 0);
  const blob = await canvasToBlob(canvas, 'image/png');
  return blob.arrayBuffer();
}

/** Images -> PDF. One image per page, fit-to-image or A4 with margins. */
export async function runImagesToPdf(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  if (files.length === 0) throw new Error('Add at least one image');
  const doc = await PDFDocument.create();
  const size = String(opts.pageSize ?? 'fit');
  const margin = size === 'fit' ? 0 : Number(opts.margin ?? 10);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    ctx.onProgress(`Embedding ${f.name} (${i + 1}/${files.length})…`, Math.round(((i + 1) / files.length) * 90));
    const converted = await toEmbeddablePng(f);
    const buf = converted ?? (await f.arrayBuffer());
    const image =
      converted || f.type === 'image/png'
        ? await doc.embedPng(buf)
        : await doc.embedJpg(buf);
    if (size === 'fit') {
      const page = doc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    } else {
      const landscape = image.width > image.height;
      const pw = landscape ? A4.h : A4.w;
      const ph = landscape ? A4.w : A4.h;
      const page = doc.addPage([pw, ph]);
      const maxW = pw - margin * 2;
      const maxH = ph - margin * 2;
      const scale = Math.min(maxW / image.width, maxH / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, {
        x: (pw - w) / 2,
        y: (ph - h) / 2,
        width: w,
        height: h,
      });
    }
  }
  const bytes = await doc.save();
  ctx.onProgress('Writing PDF…', 100);
  return [
    {
      name: 'images.pdf',
      blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }),
      info: `${files.length} image${files.length > 1 ? 's' : ''}`,
    },
  ];
}

/** PDF -> JPG or PNG images at 1x/2x/3x (72/144/216 dpi). */
export async function runPdfToImages(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  const scaleMap: Record<string, number> = { '1': 1, '2': 2, '3': 3 };
  const scale = scaleMap[String(opts.resolution ?? '2')] ?? 2;
  const format = String(opts.format ?? 'jpg') === 'png' ? 'image/png' : 'image/jpeg';
  const ext = format === 'image/png' ? 'png' : 'jpg';
  const base = baseName(files[0].name);
  const pages = await rasterizePdf(files[0], {
    scale,
    format,
    quality: 0.92,
    onProgress: (done, total, message) =>
      ctx.onProgress(message, Math.round((done / total) * 95)),
  });
  return pages.map((p) => ({
    name: `${base}_page_${String(p.page).padStart(3, '0')}.${ext}`,
    blob: p.blob,
  }));
}

/** Scan capture already produced images — same pipeline as images->PDF. */
export async function runScanToPdf(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  return runImagesToPdf(files, opts, ctx);
}
