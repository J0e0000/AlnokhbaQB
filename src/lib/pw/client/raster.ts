// Rasterize PDF pages via pdf.js -> JPEG/PNG blobs. Shared by PDF-to-image,
// compress and redact (which needs flattened pages).

import { openPdf, renderPage, closePdf } from '../pdfjs';
import { canvasToBlob } from '../blob';

export interface RasterPage {
  page: number;
  blob: Blob;
  widthPt: number;
  heightPt: number;
}

export async function rasterizePdf(
  file: File,
  opts: {
    scale: number;
    format?: 'image/jpeg' | 'image/png';
    quality?: number;
    onProgress?: (done: number, total: number, message: string) => void;
  }
): Promise<RasterPage[]> {
  const { scale, format = 'image/jpeg', quality = 0.9, onProgress } = opts;
  const pdf = await openPdf(await file.arrayBuffer());
  const out: RasterPage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const r = await renderPage(pdf, i, scale);
    const blob = await canvasToBlob(r.canvas, format, quality);
    out.push({ page: i, blob, widthPt: r.widthPt, heightPt: r.heightPt });
    onProgress?.(i, pdf.numPages, `Rendering page ${i} of ${pdf.numPages}`);
  }
  await closePdf(pdf);
  return out;
}
