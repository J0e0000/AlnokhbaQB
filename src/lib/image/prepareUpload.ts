// ============================================================
// ALNOKHBA QB — client-side upload preparation
//
// Vercel serverless functions reject request bodies over 4.5 MB
// (413 FUNCTION_PAYLOAD_TOO_LARGE, HTML body). Phone photos posted
// as raw base64 JSON blow through that instantly. This helper
// decodes with the correct EXIF orientation, downscales the long
// side to ≤2200 px (never upscales — small images pass through at
// their original size), and re-encodes JPEG down a quality ladder
// (0.85 → 0.75 → 0.65) targeting ≤3.0 MB raw, so the base64 JSON
// body stays under ~4.1 MB. PDF page rendering is NOT affected —
// it already renders at 1800 px.
// ============================================================

const MAX_LONG_SIDE = 2200;
const TARGET_BYTES = 3.0 * 1024 * 1024;
const QUALITY_LADDER = [0.85, 0.75, 0.65] as const;

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  quality: number;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Prepare an image File/Blob for a JSON (base64) upload.
 * Throws when the browser cannot decode the file (corrupt image).
 */
export async function prepareUpload(file: File | Blob): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const longSide = Math.max(bitmap.width, bitmap.height);
    const scale = longSide > MAX_LONG_SIDE ? MAX_LONG_SIDE / longSide : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    let lastBlob: Blob | null = null;
    let usedQuality = QUALITY_LADDER[QUALITY_LADDER.length - 1];
    for (const quality of QUALITY_LADDER) {
      const blob = await canvasToBlob(canvas, quality);
      lastBlob = blob;
      usedQuality = quality;
      if (blob.size <= TARGET_BYTES) break;
    }
    if (!lastBlob) throw new Error('could not encode image');
    const dataUrl = await blobToDataUrl(lastBlob);
    return { dataUrl, width, height, bytes: lastBlob.size, quality: usedQuality };
  } finally {
    bitmap.close();
  }
}

/**
 * Read a fetch Response's error message defensively: JSON first; if the
 * body is not JSON (e.g. Vercel's HTML 413 FUNCTION_PAYLOAD_TOO_LARGE
 * page) fall back to a friendly Arabic message instead of crashing on
 * a JSON parse error.
 */
export async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  if (res.status === 413) {
    return 'الصورة كبيرة جدًا — تم رفض الطلب من الخادم (الحد 4.5 ميجابايت بعد الضغط). أعد المحاولة بصورة أوضح أو أصغر.';
  }
  try {
    const data = (await res.json()) as { error?: string; details?: string };
    if (data?.details && data?.error) return `${data.error} — ${data.details}`;
    return data?.error ?? fallback;
  } catch {
    return fallback;
  }
}
