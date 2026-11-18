// Sheet loading + preprocessing. Images honor EXIF orientation; PDFs are
// rendered one page per sheet via pdf.js. All processing stays in-browser.

export interface SourceSheet {
  id: string;
  fileName: string;
  /** Page number within the source file (images = 1). */
  page: number;
  canvas: HTMLCanvasElement;
}

let sheetSeq = 0;
export function nextSheetId(): string {
  sheetSeq += 1;
  return `s${Date.now().toString(36)}-${sheetSeq}`;
}

async function imageToCanvas(file: File, maxWidth: number): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap | HTMLImageElement | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Unsupported or corrupt image'));
      };
      img.src = url;
    });
  }
  const iw = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  const ih = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  if (!iw || !ih) throw new Error('Image has no pixels');
  const scale = Math.min(1, maxWidth / iw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(iw * scale));
  canvas.height = Math.max(1, Math.round(ih * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
  return canvas;
}

export interface LoadSheetsOptions {
  maxWidth?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

/** Convert uploaded files (images + PDFs) into a flat list of sheet canvases. */
export async function loadFilesAsSheets(files: File[], opts: LoadSheetsOptions = {}): Promise<SourceSheet[]> {
  const maxWidth = opts.maxWidth ?? 1700;
  const sheets: SourceSheet[] = [];
  // Count total pages first for accurate progress (PDFs need parsing).
  const jobs: { file: File; kind: 'image' | 'pdf' }[] = [];
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) jobs.push({ file: f, kind: 'pdf' });
    else if (f.type.startsWith('image/')) jobs.push({ file: f, kind: 'image' });
    else throw new Error(`Unsupported file type: ${f.name}`);
  }
  let done = 0;
  let total = jobs.length;
  opts.onProgress?.(0, Math.max(total, 1), '');

  for (const job of jobs) {
    if (job.kind === 'image') {
      const canvas = await imageToCanvas(job.file, maxWidth);
      sheets.push({ id: nextSheetId(), fileName: job.file.name, page: 1, canvas });
      done += 1;
      opts.onProgress?.(done, Math.max(total, 1), job.file.name);
      await yieldFrame();
    } else {
      const { openPdfFile, renderPage, closePdf } = await import('@/lib/pw/pdfjs');
      const pdf = await openPdfFile(job.file);
      total += pdf.numPages - 1;
      for (let p = 1; p <= pdf.numPages; p++) {
        // Render at a scale that lands near maxWidth pixels of width.
        const base = (await pdf.getPage(p)).getViewport({ scale: 1 });
        const scale = Math.min(3, Math.max(1, maxWidth / base.width));
        const rendered = await renderPage(pdf, p, scale);
        sheets.push({ id: nextSheetId(), fileName: `${job.file.name} — p${p}`, page: p, canvas: rendered.canvas });
        done += 1;
        opts.onProgress?.(done, Math.max(total, 1), `${job.file.name} (${p}/${pdf.numPages})`);
        await yieldFrame();
      }
      await closePdf(pdf);
    }
  }
  if (!sheets.length) throw new Error('No readable pages were found in the selected files.');
  return sheets;
}

function yieldFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------- preprocessing ----------------

export interface GrayImage {
  w: number;
  h: number;
  data: Float32Array; // 0..255
}

export function toGray(canvas: HTMLCanvasElement): GrayImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const data = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
  }
  return { w, h, data };
}

/** 3×3 median denoise — removes scanner speckle without smearing bubbles. */
export function medianDenoise(g: GrayImage): GrayImage {
  const { w, h, data } = g;
  const out = new Float32Array(w * h);
  const win = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1);
    const y2 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x2 = Math.min(w - 1, x + 1);
      let n = 0;
      for (let yy = y0; yy <= y2; yy++) {
        const row = yy * w;
        win[n++] = data[row + x0];
        win[n++] = data[row + x];
        win[n++] = data[row + x2];
      }
      // insertion sort of 9 values
      for (let i = 1; i < n; i++) {
        const v = win[i];
        let j = i - 1;
        while (j >= 0 && win[j] > v) {
          win[j + 1] = win[j];
          j--;
        }
        win[j + 1] = v;
      }
      out[y * w + x] = win[4];
    }
  }
  return { w, h, data: out };
}

/** Percentile contrast stretch (2%..98%) — normalizes scanner exposure. */
export function normalizeContrast(g: GrayImage): GrayImage {
  const { data } = g;
  const bins = 256;
  const hist = new Uint32Array(bins);
  const step = Math.max(1, Math.floor(data.length / 400000));
  let sampled = 0;
  for (let i = 0; i < data.length; i += step) {
    hist[Math.min(bins - 1, Math.max(0, data[i] | 0))]++;
    sampled++;
  }
  const loCut = sampled * 0.02;
  const hiCut = sampled * 0.98;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= loCut) {
      lo = b;
      break;
    }
  }
  acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= hiCut) {
      hi = b;
      break;
    }
  }
  if (hi <= lo) return g;
  const span = hi - lo;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.min(255, Math.max(0, ((data[i] - lo) / span) * 255));
  }
  return { w: g.w, h: g.h, data: out };
}
