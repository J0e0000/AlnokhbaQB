// Synthetic filled sheets for end-to-end testing: renders the generated PDF,
// fills random bubbles per sheet, then applies mild rotation/noise/shadow
// degradations — mimicking a phone photo of a printed sheet.

import { rotateCanvas } from './align';
import type { FormTemplate } from './types';

export interface DemoSheet {
  file: File;
  /** Ground-truth answers (questionNumber → label) for verification. */
  truth: Record<number, string>;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function makeDemoSheets(
  template: FormTemplate,
  pdfBytes: ArrayBuffer,
  count: number,
  onProgress?: (done: number, total: number) => void
): Promise<DemoSheet[]> {
  const { renderAllPages, closePdf } = await import('@/lib/pw/pdfjs');
  const out: DemoSheet[] = [];

  // Render page 1 once at demo scan resolution, then reuse as the base.
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const asFile = new File([blob], 'demo-master.pdf', { type: 'application/pdf' });
  const { pdf, pages } = await renderAllPages(asFile, 2.5, undefined);
  void pdf;
  const base = pages[0].canvas;
  await closePdf(pdf);

  const rng = mulberry(Date.now() & 0xffff);

  for (let s = 0; s < count; s++) {
    // 1. clone the blank sheet
    const work = document.createElement('canvas');
    work.width = base.width;
    work.height = base.height;
    const ctx = work.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(base, 0, 0);

    // 2. fill random bubbles
    const truth: Record<number, string> = {};
    let q = 0;
    for (const area of template.areas) {
      if (area.type !== 'omr') continue;
      const labels = area.labels ?? ['A', 'B', 'C', 'D'];
      const qs = area.questions ?? 1;
      const across = area.orientation === 'across';
      const rowsN = across ? labels.length : qs;
      const colsN = across ? qs : labels.length;
      const cellW = (area.w * work.width) / colsN;
      const cellH = (area.h * work.height) / rowsN;
      for (let qi = 0; qi < qs; qi++) {
        q++;
        const choice = Math.floor(rng() * labels.length);
        truth[q] = labels[choice];
        const oi = across ? choice : qi;
        const oj = across ? qi : choice;
        const cx = (area.x + ((oj + 0.5) * cellW) / work.width) * work.width;
        const cy = (area.y + ((oi + 0.5) * cellH) / work.height) * work.height;
        const rx = cellW * rand(0.3, 0.36);
        const ry = cellH * rand(0.3, 0.36);
        ctx.save();
        ctx.translate(cx + rand(-0.8, 0.8), cy + rand(-0.8, 0.8));
        ctx.rotate(rand(-0.06, 0.06));
        ctx.fillStyle = `rgba(38, 36, 34, ${rand(0.82, 0.95).toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 3. degradations: rotation (±1.5°), slight brightness gradient, speckle noise
    let outCanvas = work;
    const angle = rand(-1.5, 1.5);
    if (Math.abs(angle) > 0.25) outCanvas = rotateCanvas(work, angle);

    const octx = outCanvas.getContext('2d');
    if (octx) {
      // soft shadow gradient (like uneven lighting)
      const grad = octx.createLinearGradient(0, 0, outCanvas.width, outCanvas.height);
      grad.addColorStop(0, 'rgba(0,0,0,0.05)');
      grad.addColorStop(0.5, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.04)');
      octx.fillStyle = grad;
      octx.fillRect(0, 0, outCanvas.width, outCanvas.height);
      // speckle
      const n = Math.round(outCanvas.width * outCanvas.height * 0.0012);
      for (let i = 0; i < n; i++) {
        const x = Math.random() * outCanvas.width;
        const y = Math.random() * outCanvas.height;
        octx.fillStyle = Math.random() > 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.1)';
        octx.fillRect(x, y, 1.2, 1.2);
      }
    }

    const blobOut = await new Promise<Blob>((resolve, reject) =>
      outCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.9)
    );
    const file = new File([blobOut], `demo-sheet-${String(s + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' });
    out.push({ file, truth });
    onProgress?.(s + 1, count);
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}
