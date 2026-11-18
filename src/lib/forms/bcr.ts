// Barcode/QR region reading: jsQR first (with rotation + binarization
// retries), then ZXing for 1D symbologies (Code128, Code39, EAN, ITF, UPC).

import jsQR from 'jsqr';

export interface BarcodeReading {
  text: string;
  format: string;
}

function otsuThreshold(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let b = 0; b < 256; b++) sum += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let b = 0; b < 256; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = b;
    }
  }
  return thr;
}

function cropRegion(
  canvas: HTMLCanvasElement,
  nx: number,
  ny: number,
  nw: number,
  nh: number,
  pad = 0.1
): HTMLCanvasElement {
  const x = Math.max(0, Math.round((nx - nw * pad) * canvas.width));
  const y = Math.max(0, Math.round((ny - nh * pad) * canvas.height));
  const w = Math.min(canvas.width - x, Math.round(nw * (1 + pad * 2) * canvas.width));
  const h = Math.min(canvas.height - y, Math.round(nh * (1 + pad * 2) * canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.max(8, w);
  out.height = Math.max(8, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, x, y, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function toGrayU8(canvas: HTMLCanvasElement): { gray: Uint8Array; data: ImageData } {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) | 0;
  }
  return { gray, data: img };
}

function binarizeCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const { gray } = toGrayU8(canvas);
  const thr = otsuThreshold(gray);
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return canvas;
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] > thr ? 255 : 0;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function rotate90(canvas: HTMLCanvasElement, quarters: number): HTMLCanvasElement {
  let cur = canvas;
  for (let r = 0; r < quarters; r++) {
    const out = document.createElement('canvas');
    out.width = cur.height;
    out.height = cur.width;
    const ctx = out.getContext('2d');
    if (!ctx) return cur;
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(cur, -cur.width / 2, -cur.height / 2);
    cur = out;
  }
  return cur;
}

function upscale(canvas: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * factor);
  out.height = Math.round(canvas.height * factor);
  const ctx = out.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function tryJsQR(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return res?.data ?? null;
}

let zxingReader: import('@zxing/library').MultiFormatReader | null = null;
async function tryZxing(canvas: HTMLCanvasElement): Promise<{ text: string; format: string } | null> {
  try {
    const zx = await import('@zxing/library');
    if (!zxingReader) {
      const reader = new zx.MultiFormatReader();
      const hints = new Map();
      hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
        zx.BarcodeFormat.CODE_128,
        zx.BarcodeFormat.CODE_39,
        zx.BarcodeFormat.EAN_13,
        zx.BarcodeFormat.EAN_8,
        zx.BarcodeFormat.ITF,
        zx.BarcodeFormat.UPC_A,
        zx.BarcodeFormat.UPC_E,
        zx.BarcodeFormat.CODABAR,
      ]);
      hints.set(zx.DecodeHintType.TRY_HARDER, true);
      reader.setHints(hints);
      zxingReader = reader;
    }
    const { gray } = toGrayU8(canvas);
    // The port's RGBLuminanceSource treats a length == w*h buffer as
    // precomputed grayscale luminance.
    const source = new zx.RGBLuminanceSource(new Uint8ClampedArray(gray), canvas.width, canvas.height);
    const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(source));
    const res = zxingReader.decode(bitmap);
    return { text: res.getText(), format: String(res.getBarcodeFormat()) };
  } catch {
    return null;
  }
}

/** Decode a QR/1D barcode from a normalized region of a sheet canvas. */
export async function readBarcodeRegion(
  canvas: HTMLCanvasElement,
  nx: number,
  ny: number,
  nw: number,
  nh: number
): Promise<BarcodeReading | null> {
  let region = cropRegion(canvas, nx, ny, nw, nh);
  if (region.width < 60 || region.height < 60) {
    region = upscale(region, Math.max(2, 120 / Math.min(region.width, region.height)));
  }

  const variants: HTMLCanvasElement[] = [
    region,
    binarizeCanvas(region),
    upscale(region, 2),
    rotate90(binarizeCanvas(region), 1),
    rotate90(binarizeCanvas(region), 2),
    rotate90(binarizeCanvas(region), 3),
  ];

  // QR first
  for (const v of variants) {
    const text = tryJsQR(v);
    if (text) return { text, format: 'QR' };
  }
  // Then 1D formats
  for (const v of [region, binarizeCanvas(region), upscale(region, 2)]) {
    const res = await tryZxing(v);
    if (res) return res;
  }
  return null;
}
