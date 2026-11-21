'use client';

// ============================================================
// ALNOKHBA QB — in-browser OCR (tesseract.js / WASM)
// Runs 100% on the user's device: no API keys, no server engine,
// works on Vercel and for Arabic out of the box. Language data
// (traineddata) is fetched once from a CDN and cached by the
// browser; the worker is created lazily and reused per language.
// ============================================================

import { createWorker, type Worker } from 'tesseract.js';

export type ClientOcrLang = 'ara' | 'eng' | 'ara+eng';

let workerPromise: Promise<Worker> | null = null;
let workerLang: string | null = null;
let progressSink: ((status: string, progress: number) => void) | null = null;

async function getWorker(lang: ClientOcrLang): Promise<Worker> {
  if (workerPromise && workerLang === lang) return workerPromise;
  if (workerPromise) {
    try {
      const old = await workerPromise;
      await old.terminate();
    } catch {
      /* already dead */
    }
    workerPromise = null;
  }
  workerLang = lang;
  workerPromise = createWorker(lang, 1, {
    logger: (m) => {
      if (m.status && progressSink) progressSink(m.status, m.progress ?? 0);
    },
    errorHandler: () => undefined, // surfaced via recognize() rejection
  });
  return workerPromise;
}

const STATUS_AR: Record<string, string> = {
  'loading tesseract core': 'تحميل محرك القراءة…',
  'initializing tesseract': 'تهيئة محرك القراءة…',
  'loading language traineddata': 'تحميل بيانات اللغة…',
  'initializing api': 'تهيئة المحلل…',
  'recognizing text': 'قراءة النص من الصورة…',
};

/** Recognize an image (data URL / blob / canvas) fully in the browser. */
export async function ocrImageInBrowser(
  image: string | Blob | HTMLCanvasElement,
  lang: ClientOcrLang,
  onProgress?: (pct: number, stageAr: string) => void,
): Promise<string> {
  const worker = await getWorker(lang);
  progressSink = (status, progress) => {
    onProgress?.(Math.round(progress * 100), STATUS_AR[status] ?? 'جارٍ المعالجة…');
  };
  try {
    const { data } = await worker.recognize(image);
    return (data.text ?? '').trim();
  } finally {
    progressSink = null;
  }
}

/** Free the WASM worker (call when leaving the page is not required — kept for manual reset). */
export async function disposeBrowserOcr(): Promise<void> {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch {
    /* noop */
  }
  workerPromise = null;
  workerLang = null;
}
