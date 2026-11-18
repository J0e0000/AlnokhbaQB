// Compress: re-render pages as JPEG at lower scale/quality and rebuild.
// Lossy but very effective; the trade-off (text becomes image) is shown in the UI.

import { PDFDocument } from 'pdf-lib';
import { baseName, formatBytes } from '../blob';
import { rasterizePdf } from './raster';
import { saveDoc } from './organize';
import type { OptionValues, OutFile, RunCtx } from '../types';

const PRESETS: Record<string, { scale: number; quality: number }> = {
  light: { scale: 1.5, quality: 0.75 },
  recommended: { scale: 1.25, quality: 0.6 },
  extreme: { scale: 1.0, quality: 0.45 },
};

export async function runCompress(files: File[], opts: OptionValues, ctx: RunCtx): Promise<OutFile[]> {
  const preset = PRESETS[String(opts.level ?? 'recommended')] ?? PRESETS.recommended;
  const originalSize = files[0].size;
  ctx.onProgress('Rendering pages…', 5);
  const pages = await rasterizePdf(files[0], {
    scale: preset.scale,
    format: 'image/jpeg',
    quality: preset.quality,
    onProgress: (done, total, message) =>
      ctx.onProgress(message, Math.round((done / total) * 85)),
  });
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const image = await doc.embedJpg(await p.blob.arrayBuffer());
    const page = doc.addPage([p.widthPt, p.heightPt]);
    page.drawImage(image, { x: 0, y: 0, width: p.widthPt, height: p.heightPt });
  }
  const out = await saveDoc(doc, `${baseName(files[0].name)}_compressed.pdf`);
  const newSize = out.blob.size;
  const saved = originalSize > 0 ? Math.max(0, Math.round((1 - newSize / originalSize) * 100)) : 0;
  out.info = `${formatBytes(originalSize)} → ${formatBytes(newSize)}${
    saved > 0 ? ` (${saved}% smaller)` : ' (no savings — try a stronger level)'
  }`;
  ctx.onProgress('Done', 100);
  return [out];
}
