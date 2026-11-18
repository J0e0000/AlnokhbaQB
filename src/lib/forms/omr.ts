// OMR bubble-grid reading: per-cell darkness against a per-grid median
// baseline (the typical empty-bubble level), with blank/multiple/lenient logic.

import type { FormArea, MarkOverlay } from './types';
import type { GrayImage } from './image';

export interface OmrQuestion {
  /** Global question number (1-based, continuous across areas). */
  question: number;
  area: number;
  status: 'single' | 'blank' | 'multiple';
  labels: string[];
  confidence: number;
  /** True when lenient mode resolved what used to be a multiple. */
  lenientResolved?: boolean;
}

export interface OmrAreaReading {
  questions: OmrQuestion[];
  marks: MarkOverlay[];
  /** Per-cell darkness (debug/review). */
  darkness: number[];
  median: number;
}

function meanDarkness(g: GrayImage, x0: number, y0: number, x1: number, y1: number): number {
  const { w, h, data } = g;
  const cx0 = Math.max(0, Math.min(w - 1, Math.round(x0)));
  const cy0 = Math.max(0, Math.min(h - 1, Math.round(y0)));
  const cx1 = Math.max(cx0 + 1, Math.min(w, Math.round(x1)));
  const cy1 = Math.max(cy0 + 1, Math.min(h, Math.round(y1)));
  let sum = 0;
  let n = 0;
  for (let y = cy0; y < cy1; y++) {
    const row = y * w;
    for (let x = cx0; x < cx1; x++) {
      sum += data[row + x];
      n++;
    }
  }
  return n ? 1 - sum / n / 255 : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function readOmrArea(
  g: GrayImage,
  area: FormArea,
  areaIndex: number,
  baseQuestion: number,
  threshold: number,
  lenient: boolean
): OmrAreaReading {
  const labels = (area.labels ?? ['A', 'B', 'C', 'D']).filter(Boolean);
  const questions = Math.max(1, area.questions ?? 1);
  const across = area.orientation === 'across';
  // Rows × columns of the grid: "down" → a question per row, options across;
  // "across" → a question per column, options down.
  const rows = across ? labels.length : questions;
  const cols = across ? questions : labels.length;
  // normalized area → pixel space of the (warped) sheet
  const px = area.x * g.w;
  const py = area.y * g.h;
  const pw = area.w * g.w;
  const ph = area.h * g.h;
  const cellWpx = pw / cols;
  const cellHpx = ph / rows;

  const darkness: number[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      // Inner 50% of the cell (25% inset per side) so printed bubble outlines
      // and pencil chatter at the edges don't count.
      const cx = px + j * cellWpx;
      const cy = py + i * cellHpx;
      darkness.push(
        meanDarkness(g, cx + cellWpx * 0.25, cy + cellHpx * 0.25, cx + cellWpx * 0.75, cy + cellHpx * 0.75)
      );
    }
  }
  const med = median(darkness);
  const marks: MarkOverlay[] = [];
  const out: OmrQuestion[] = [];
  // normalized cell size (overlay geometry is normalized to the sheet)
  const cellW = area.w / cols;
  const cellH = area.h / rows;

  const addMark = (q: number, o: number, label: string, state: MarkOverlay['state'], confidence: number) => {
    const i = across ? o : q;
    const j = across ? q : o;
    marks.push({
      x: area.x + (j + 0.5) * cellW,
      y: area.y + (i + 0.5) * cellH,
      // radius is relative to sheet width
      r: Math.min(cellW, cellH) * 0.4,
      labels: [label],
      state,
      question: baseQuestion + q + 1,
    });
  };

  for (let q = 0; q < questions; q++) {
    // Map (question, option) → grid cell (i, j).
    const hits: { o: number; d: number }[] = [];
    labels.forEach((_label, o) => {
      const i = across ? o : q;
      const j = across ? q : o;
      const d = darkness[i * cols + j];
      if (d - med > threshold) hits.push({ o, d });
    });

    const gq = baseQuestion + q + 1;
    let status: OmrQuestion['status'] = 'blank';
    let chosen: string[] = [];
    let confidence = 0;
    let lenientResolved = false;

    if (hits.length === 1) {
      status = 'single';
      chosen = [labels[hits[0].o]];
      confidence = Math.min(1, Math.max(0, (hits[0].d - med - threshold) / 0.2));
      addMark(q, hits[0].o, chosen[0], 'marked', confidence);
    } else if (hits.length > 1) {
      // Lenient mode: a clearly darkest cell (margin ≥ 0.08 over the second) wins.
      const ranked = [...hits].sort((a, b) => b.d - a.d);
      const margin = ranked[0].d - ranked[1].d;
      if (lenient && margin >= 0.08) {
        status = 'single';
        chosen = [labels[ranked[0].o]];
        confidence = Math.min(1, Math.max(0, (ranked[0].d - med - threshold) / 0.2));
        lenientResolved = true;
        addMark(q, ranked[0].o, chosen[0], 'marked', confidence);
      } else {
        status = 'multiple';
        chosen = hits.map((h) => labels[h.o]);
        confidence = 0;
        for (const h of hits) addMark(q, h.o, labels[h.o], 'multiple', 0);
      }
    }
    out.push({ question: gq, area: areaIndex, status, labels: chosen, confidence, lenientResolved });
  }

  return { questions: out, marks, darkness, median: med };
}

export function omrFlags(questions: OmrQuestion[]): Set<'blank' | 'multiple' | 'low-confidence'> {
  const flags = new Set<'blank' | 'multiple' | 'low-confidence'>();
  for (const q of questions) {
    if (q.status === 'blank') flags.add('blank');
    else if (q.status === 'multiple') flags.add('multiple');
    else if (q.confidence < 0.15) flags.add('low-confidence');
  }
  return flags;
}
