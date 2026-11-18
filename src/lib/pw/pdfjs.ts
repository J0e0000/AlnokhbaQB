// pdf.js wrapper (browser only). All Tier-1 rendering/text extraction funnels
// through here so the worker is configured once and callers stay small.

import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfJsModule = typeof import('pdfjs-dist');

let modPromise: Promise<PdfJsModule> | null = null;

// pdfjs-dist v6 removed PDFDocumentProxy.destroy() — destruction lives on the
// loading task. Track tasks so callers can release worker memory via closePdf.
const taskByDoc = new WeakMap<PDFDocumentProxy, { destroy: () => Promise<void> }>();

export async function closePdf(doc: PDFDocumentProxy): Promise<void> {
  const task = taskByDoc.get(doc);
  if (task) {
    try {
      await task.destroy();
    } catch {
      /* already destroyed */
    }
  }
}

export async function getPdfJs(): Promise<PdfJsModule> {
  if (!modPromise) {
    modPromise = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      return m;
    });
  }
  return modPromise;
}

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs();
  // pdf.js transfers/detaches the buffer it receives — always hand over a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
  });
  const doc = await task.promise;
  taskByDoc.set(doc, task);
  return doc;
}

export async function openPdfFile(file: File): Promise<PDFDocumentProxy> {
  return openPdf(await file.arrayBuffer());
}

export async function pdfPageCount(file: File): Promise<number> {
  const pdf = await openPdfFile(file);
  const n = pdf.numPages;
  await closePdf(pdf);
  return n;
}

export interface RenderedPage {
  page: number;
  canvas: HTMLCanvasElement;
  /** Page size in PDF points (unrotated by scale). */
  widthPt: number;
  heightPt: number;
}

/** Render one page onto a white-filled canvas at `scale` (1 = 72 dpi). */
export async function renderPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  scale: number
): Promise<RenderedPage> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const base = page.getViewport({ scale: 1 });
  return { page: pageNumber, canvas, widthPt: base.width, heightPt: base.height };
}

export async function renderAllPages(
  file: File,
  scale: number,
  onProgress?: (done: number, total: number) => void
): Promise<{ pdf: PDFDocumentProxy; pages: RenderedPage[] }> {
  const pdf = await openPdfFile(file);
  const pages: RenderedPage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    pages.push(await renderPage(pdf, i, scale));
    onProgress?.(i, pdf.numPages);
  }
  return { pdf, pages };
}

export interface TextItemBox {
  str: string;
  /** Page-space (72dpi, top-left origin) geometry. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function extractPageTextItems(
  pdf: PDFDocumentProxy,
  pageNumber: number
): Promise<TextItemBox[]> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const out: TextItemBox[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const t = item as { str: string; transform?: number[]; width?: number; height?: number };
    if (!t.str) continue;
    const tr = t.transform ?? [1, 0, 0, 1, 0, 0];
    const height = Math.hypot(tr[2] ?? 0, tr[3] ?? 1.5) || (t.height ?? 10);
    out.push({
      str: t.str,
      x: tr[4] ?? 0,
      y: tr[5] ?? 0,
      width: t.width ?? 0,
      height,
    });
  }
  return out;
}

/** Plain text of every page, joined with page markers. */
export async function extractDocumentText(
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<{ pages: string[]; text: string }> {
  const pdf = await openPdfFile(file);
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const items = await extractPageTextItems(pdf, i);
    let line = '';
    let lastY: number | null = null;
    const parts: string[] = [];
    for (const it of items) {
      if (lastY !== null && Math.abs(it.y - lastY) > it.height * 0.6) {
        parts.push(line.trim());
        line = '';
      }
      line += (line && !line.endsWith(' ') && it.str && !/^\s/.test(it.str) ? ' ' : '') + it.str;
      lastY = it.y;
    }
    if (line.trim()) parts.push(line.trim());
    pages.push(parts.join('\n'));
    onProgress?.(i, pdf.numPages);
  }
  await closePdf(pdf);
  const text = pages.map((p, i) => `[[Page ${i + 1}]]\n${p}`).join('\n\n');
  return { pages, text };
}

export interface Thumb {
  page: number;
  url: string;
  widthPt: number;
  heightPt: number;
  rotation: number;
}

/** Render small page previews (used by the organize grid and editors). */
export async function makeThumbnails(
  file: File,
  opts: { maxPages?: number; pixelWidth?: number } = {}
): Promise<{ thumbs: Thumb[]; pdf: PDFDocumentProxy }> {
  const { maxPages, pixelWidth = 200 } = opts;
  const pdf = await openPdfFile(file);
  const thumbs: Thumb[] = [];
  const total = Math.min(pdf.numPages, maxPages ?? pdf.numPages);
  for (let i = 1; i <= total; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = pixelWidth / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not supported in this browser');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    thumbs.push({
      page: i,
      url: canvas.toDataURL('image/jpeg', 0.8),
      widthPt: base.width,
      heightPt: base.height,
      rotation: page.rotate ?? 0,
    });
  }
  return { thumbs, pdf };
}

/** User-friendly message for pdf.js / pdf-lib failures. */
export function friendlyPdfError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/password/i.test(msg)) return 'This PDF is encrypted. Remove the password first (use the Unlock tool).';
  if (
    /Invalid PDF|structure|corrupt|Cannot read properties|unexpected|is not a function|xref|trailer/i.test(
      msg
    )
  ) {
    return 'This file looks damaged or is not a valid PDF. Try the Repair tool, or check that you picked the right file.';
  }
  if (/dummy|Worker/i.test(msg)) return 'PDF engine failed to start — reload the page and try again.';
  return msg || 'Something went wrong processing this PDF.';
}
