// Stamp tools: page numbers and text watermark. Pure pdf-lib, in-browser.

import { StandardFonts, rgb, degrees } from 'pdf-lib';
import { baseName } from '../blob';
import { saveDoc, loadDoc } from './organize';
import type { OptionValues, OutFile, RunCtx } from '../types';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const int = parseInt(v.slice(0, 6) || '333333', 16);
  return { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 };
}

const MARGIN = 28;

/** Stamp page numbers at one of six positions with an optional start number. */
export async function runPageNumbers(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  const doc = await loadDoc(files[0]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = Math.min(72, Math.max(6, Number(opts.size ?? 11)));
  const start = Math.max(0, Math.floor(Number(opts.start ?? 1)));
  const pos = String(opts.position ?? 'bc');
  const color = hexToRgb(String(opts.color ?? '#333333'));
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const label = String(start + i);
    const { width, height } = page.getSize();
    const tw = font.widthOfTextAtSize(label, size);
    const x = pos[1] === 'c' ? (width - tw) / 2 : pos[1] === 'r' ? width - MARGIN - tw : MARGIN;
    const y = pos[0] === 'b' ? MARGIN : height - MARGIN - size;
    page.drawText(label, { x, y, size, font, color: rgb(color.r, color.g, color.b) });
  });
  ctx.onProgress(`Stamped ${pages.length} pages…`, 100);
  return [await saveDoc(doc, `${baseName(files[0].name)}_numbered.pdf`, `${pages.length} pages, starting at ${start}`)];
}

/** Diagonal text watermark with opacity, size, rotation and position. */
export async function runWatermark(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  const text = String(opts.text ?? '').trim();
  if (!text) throw new Error('Enter the watermark text');
  const doc = await loadDoc(files[0]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = Math.min(200, Math.max(8, Number(opts.size ?? 60)));
  const opacity = Math.min(1, Math.max(0.05, Number(opts.opacity ?? 25) / 100));
  const rot = Number(opts.rotation ?? 45);
  const position = String(opts.position ?? 'center');
  const color = hexToRgb(String(opts.color ?? '#993333'));
  const pages = doc.getPages();
  pages.forEach((page) => {
    const { width, height } = page.getSize();
    const tw = font.widthOfTextAtSize(text, size);
    let x: number, y: number, angle: number;
    if (position === 'center') {
      angle = rot;
      const a = (angle * Math.PI) / 180;
      x = width / 2 - (Math.cos(a) * tw) / 2;
      y = height / 2 - (Math.sin(a) * tw) / 2;
    } else {
      // corner positions, upright
      angle = 0;
      const m = 40;
      const left = position.endsWith('l');
      const top = position.startsWith('t');
      x = left ? m : width - m - tw;
      y = top ? height - m - size : m;
    }
    page.drawText(text, {
      x,
      y,
      size,
      font,
      rotate: degrees(angle),
      color: rgb(color.r, color.g, color.b),
      opacity,
    });
  });
  ctx.onProgress(`Watermarked ${pages.length} pages…`, 100);
  return [await saveDoc(doc, `${baseName(files[0].name)}_watermarked.pdf`, `${pages.length} pages watermarked`)];
}
