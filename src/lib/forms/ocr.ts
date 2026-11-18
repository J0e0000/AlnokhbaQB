// OCR regions: printed text via Tesseract.js in the browser (lazy CDN load),
// handwriting via a server-side vision model. A server OCR fallback covers
// environments where the Tesseract CDN is unreachable.

export interface OcrOptions {
  lang?: string; // tesseract language code, e.g. 'eng', 'ara'
  whitelist?: string;
  handwriting?: boolean;
}

function cropRegion(
  canvas: HTMLCanvasElement,
  nx: number,
  ny: number,
  nw: number,
  nh: number,
  pad = 0.02
): HTMLCanvasElement {
  const x = Math.max(0, Math.round((nx - nw * pad) * canvas.width));
  const y = Math.max(0, Math.round((ny - nh * pad) * canvas.height));
  const w = Math.min(canvas.width - x, Math.round(nw * (1 + pad * 2) * canvas.width));
  const h = Math.min(canvas.height - y, Math.round(nh * (1 + pad * 2) * canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.max(4, w);
  out.height = Math.max(4, h);
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, x, y, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function enhanceForOcr(canvas: HTMLCanvasElement): HTMLCanvasElement {
  // Upscale small crops toward ~1000px width, then normalize contrast by
  // simple percentile stretch on luminance.
  let out = canvas;
  if (out.width < 1000) {
    const f = Math.min(3, 1000 / out.width);
    const up = document.createElement('canvas');
    up.width = Math.round(out.width * f);
    up.height = Math.round(out.height * f);
    const ctx = up.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, up.width, up.height);
      ctx.drawImage(out, 0, 0, up.width, up.height);
      out = up;
    }
  }
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) return out;
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const px = img.data;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  if (hi > lo + 10) {
    const span = hi - lo;
    for (let i = 0; i < px.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const v = Math.min(255, Math.max(0, ((l - lo) / span) * 255));
        px[i + c] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return out;
}

// ---------------- Tesseract.js (browser, lazy) ----------------

type TesseractGlobal = {
  createWorker: (
    lang: string,
    oem?: number,
    options?: Record<string, unknown>
  ) => Promise<TesseractWorker>;
};

interface TesseractWorker {
  recognize: (image: CanvasImageSource | string, options?: unknown, parameters?: Record<string, string>) => Promise<{
    data: { text: string; confidence: number };
  }>;
  terminate: () => Promise<void>;
}

declare global {
  interface Window {
    Tesseract?: TesseractGlobal;
  }
}

const CDN_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const workers = new Map<string, Promise<TesseractWorker>>();

async function loadTesseractScript(): Promise<TesseractGlobal> {
  if (window.Tesseract) return window.Tesseract;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CDN_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('tesseract-cdn-unavailable'));
    document.head.appendChild(s);
  });
  if (!window.Tesseract) throw new Error('tesseract-cdn-unavailable');
  return window.Tesseract;
}

async function getWorker(lang: string): Promise<TesseractWorker> {
  const existing = workers.get(lang);
  if (existing) return existing;
  const created = (async () => {
    const T = await loadTesseractScript();
    return T.createWorker(lang, 1, { logger: () => undefined });
  })();
  workers.set(lang, created);
  try {
    return await created;
  } catch (e) {
    workers.delete(lang);
    throw e;
  }
}

async function tesseractRecognize(canvas: HTMLCanvasElement, lang: string, whitelist?: string): Promise<string> {
  const worker = await getWorker(lang);
  const params: Record<string, string> = {};
  if (whitelist) params.tessedit_char_whitelist = whitelist;
  const { data } = await worker.recognize(canvas, {}, params);
  return (data.text ?? '').trim();
}

// ---------------- server fallbacks ----------------

async function serverOcr(canvas: HTMLCanvasElement, lang: string): Promise<string> {
  const dataUrl = canvas.toDataURL('image/png');
  const res = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: dataUrl, lang }),
  });
  if (!res.ok) throw new Error(`server-ocr-failed-${res.status}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}

async function serverTranscribe(canvas: HTMLCanvasElement): Promise<string> {
  const dataUrl = canvas.toDataURL('image/png');
  const res = await fetch('/api/ai/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!res.ok) throw new Error(`ai-transcribe-failed-${res.status}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}

export interface OcrResult {
  text: string;
  engine: 'tesseract' | 'server-ocr' | 'ai-vision';
  confidence: number;
}

/** Read a normalized region as text. Handwriting regions go to the vision API. */
export async function ocrRegion(
  canvas: HTMLCanvasElement,
  nx: number,
  ny: number,
  nw: number,
  nh: number,
  opts: OcrOptions = {}
): Promise<OcrResult> {
  const crop = enhanceForOcr(cropRegion(canvas, nx, ny, nw, nh));
  const lang = opts.lang || 'eng';

  if (opts.handwriting) {
    // Vision-model transcription (server-side; the key never reaches the client).
    const text = await serverTranscribe(crop);
    return { text, engine: 'ai-vision', confidence: text ? 0.8 : 0 };
  }

  try {
    const text = await tesseractRecognize(crop, lang, opts.whitelist);
    if (text) return { text, engine: 'tesseract', confidence: 0.75 };
    // Empty recognition → fall through to the server once before giving up.
    const serverText = await serverOcr(crop, lang);
    return { text: serverText, engine: 'server-ocr', confidence: serverText ? 0.7 : 0 };
  } catch {
    // CDN unreachable or worker failure → server OCR fallback
    const serverText = await serverOcr(crop, lang);
    return { text: serverText, engine: 'server-ocr', confidence: serverText ? 0.7 : 0 };
  }
}
