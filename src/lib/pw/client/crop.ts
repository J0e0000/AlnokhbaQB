// Crop: apply a crop box (or full replace of media box) to selected pages.

import { PDFDocument } from 'pdf-lib';
import { baseName } from '../blob';
import { saveDoc } from './organize';
import type { OptionValues, OutFile } from '../types';

export interface CropBoxPt {
  /** Top-left origin points relative to the scale-1 page viewport. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Apply the same crop box to pages (0-based list). pdf-lib boxes use
 * bottom-left origin, so y is flipped against the page height.
 */
export async function applyCrop(
  file: File,
  box: CropBoxPt,
  pageIndices: number[],
  mode: 'crop' | 'media'
): Promise<OutFile> {
  const doc = await PDFDocument.load(await file.arrayBuffer(), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const pages = doc.getPages();
  let applied = 0;
  pageIndices.forEach((i) => {
    const page = pages[i];
    if (!page) return;
    const { width, height } = page.getSize();
    const x = Math.max(0, Math.min(box.x, width));
    const w = Math.max(1, Math.min(box.w, width - x));
    const top = Math.max(0, Math.min(box.y, height));
    const h = Math.max(1, Math.min(box.h, height - top));
    const y = height - top - h; // flip
    if (mode === 'media') {
      page.setMediaBox(x, y, w, h);
      page.setCropBox(x, y, w, h);
    } else {
      page.setCropBox(x, y, w, h);
    }
    applied++;
  });
  if (applied === 0) throw new Error('No pages selected to crop');
  return saveDoc(
    doc,
    `${baseName(file.name)}_cropped.pdf`,
    `${applied} page${applied === 1 ? '' : 's'} cropped to ${Math.round(box.w)} × ${Math.round(box.h)} pt`
  );
}
