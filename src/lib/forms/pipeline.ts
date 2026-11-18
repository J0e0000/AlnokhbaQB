// readSheet: alignment → per-area reading → fields/flags/marks. This is the
// single entry point the UI calls per sheet; it is pure w.r.t. the inputs.

import type { FormTemplate, SheetResult, SheetFlag, CellValue } from './types';
import { omrQuestionOffsets } from './types';
import { toGray, medianDenoise, normalizeContrast, type GrayImage, type SourceSheet } from './image';
import { detectMarkers, markerTransform, warpCanvas, alignmentConfidence, estimateDeskewAngle, rotateCanvas } from './align';
import { readOmrArea, omrFlags, type OmrQuestion } from './omr';
import { readBarcodeRegion } from './bcr';
import { ocrRegion } from './ocr';

export interface ReadOptions {
  denoise?: boolean;
  /** Read even when marker alignment fails (deskew only, no warp). */
  allowUnaligned?: boolean;
}

export interface ReadSheetOutcome extends SheetResult {
  /** Aligned (or original) canvas kept for the review overlay. */
  reviewCanvas: HTMLCanvasElement;
  omr?: OmrQuestion[];
}

export async function readSheet(
  sheet: SourceSheet,
  template: FormTemplate,
  opts: ReadOptions = {}
): Promise<ReadSheetOutcome> {
  const flags = new Set<SheetFlag>();
  let gray: GrayImage = normalizeContrast(opts.denoise ? medianDenoise(toGray(sheet.canvas)) : toGray(sheet.canvas));
  let workCanvas = sheet.canvas;
  let alignMethod: SheetResult['alignMethod'] = 'none';
  let alignConfidence = 1;
  let aligned = true;

  const useMarkers = template.markers.length >= 3 && template.refWidth > 0 && template.refHeight > 0;

  if (useMarkers) {
    const matches = detectMarkers(gray, template.markers);
    if (matches.length >= 3) {
      const t = markerTransform(matches, template.markers, template.refWidth, template.refHeight);
      alignConfidence = alignmentConfidence(matches, 0.09, Math.max(gray.w, gray.h));
      if (alignConfidence < 0.25) {
        // Markers found but their geometry looks badly off — fail loudly.
        flags.add('alignment-failed');
        aligned = false;
        alignMethod = 'failed';
        if (!opts.allowUnaligned) {
          return failedResult(sheet, template, flags, alignMethod, alignConfidence, sheet.canvas, 'alignment-failed');
        }
      } else {
        workCanvas = warpCanvas(sheet.canvas, t, template.refWidth, template.refHeight);
        gray = normalizeContrast(toGray(workCanvas));
        alignMethod = t.kind === 'homography' ? 'homography' : 'affine';
      }
    } else {
      flags.add('alignment-failed');
      aligned = false;
      alignMethod = 'failed';
      if (!opts.allowUnaligned) {
        return failedResult(sheet, template, flags, alignMethod, 0, sheet.canvas, 'alignment-failed');
      }
      // fall through: try deskew on the unwarped sheet
      const angle = estimateDeskewAngle(gray);
      if (Math.abs(angle) > 0.5) {
        workCanvas = rotateCanvas(sheet.canvas, -angle);
        gray = normalizeContrast(toGray(workCanvas));
        alignMethod = 'deskew';
      }
    }
  } else {
    // No markers in the template → deskew fallback.
    const angle = estimateDeskewAngle(gray);
    if (Math.abs(angle) > 0.5) {
      workCanvas = rotateCanvas(sheet.canvas, -angle);
      gray = normalizeContrast(toGray(workCanvas));
      alignMethod = 'deskew';
      alignConfidence = 0.6;
    }
  }

  const fields: Record<string, CellValue> = {
    file_name: { kind: 'ocr', status: 'text', text: sheet.fileName, confidence: 1 },
  };
  const fieldOrder: string[] = ['file_name'];
  const marks: SheetResult['marks'] = [];
  const allOmr: OmrQuestion[] = [];
  const offsets = omrQuestionOffsets(template.areas);

  for (let i = 0; i < template.areas.length; i++) {
    const area = template.areas[i];
    const n = i + 1;
    if (area.type === 'omr') {
      const reading = readOmrArea(gray, area, n, offsets[i] ?? 0, template.threshold, template.lenient);
      allOmr.push(...reading.questions);
      marks.push(...reading.marks);
      const omrFlagsSet = omrFlags(reading.questions);
      omrFlagsSet.forEach((f) => flags.add(f));
      for (const q of reading.questions) {
        const field = `OMR-${n}-${q.question}`;
        fieldOrder.push(field);
        fields[field] = {
          kind: 'omr',
          question: q.question,
          area: n,
          status: q.status,
          labels: q.labels,
          confidence: q.confidence,
        };
      }
    } else if (area.type === 'bcr') {
      fieldOrder.push(`BCR-${n}`);
      let value: CellValue;
      try {
        const reading = await readBarcodeRegion(workCanvas, area.x, area.y, area.w, area.h);
        if (reading) {
          value = { kind: 'bcr', status: 'text', text: reading.text, confidence: 0.95 };
        } else {
          value = { kind: 'bcr', status: 'unreadable', confidence: 0 };
          flags.add('unreadable-bcr');
        }
      } catch {
        value = { kind: 'bcr', status: 'unreadable', confidence: 0 };
        flags.add('unreadable-bcr');
      }
      fields[`BCR-${n}`] = value;
    } else {
      fieldOrder.push(`OCR-${n}`);
      let value: CellValue;
      try {
        const reading = await ocrRegion(workCanvas, area.x, area.y, area.w, area.h, {
          lang: area.lang,
          whitelist: area.whitelist,
          handwriting: area.handwriting,
        });
        const text = (reading.text ?? '').trim();
        value = {
          kind: 'ocr',
          status: text ? 'text' : 'unreadable',
          text,
          confidence: text ? reading.confidence : 0,
        };
        if (!text) flags.add('unreadable-ocr');
      } catch {
        value = { kind: 'ocr', status: 'unreadable', text: '', confidence: 0 };
        flags.add('unreadable-ocr');
      }
      fields[`OCR-${n}`] = value;
    }
  }

  return {
    sheetId: sheet.id,
    fileName: sheet.fileName,
    aligned,
    alignMethod,
    alignConfidence,
    fields,
    fieldOrder,
    flags: [...flags],
    marks,
    reviewCanvas: workCanvas,
    omr: allOmr,
  };
}

/** A sheet that could not be read at all (alignment failure without override). */
function failedResult(
  sheet: SourceSheet,
  template: FormTemplate,
  flags: Set<SheetFlag>,
  method: SheetResult['alignMethod'],
  confidence: number,
  canvas: HTMLCanvasElement,
  reason: 'alignment-failed'
): ReadSheetOutcome {
  const fields: Record<string, CellValue> = {
    file_name: { kind: 'ocr', status: 'text', text: sheet.fileName, confidence: 1 },
  };
  const fieldOrder: string[] = ['file_name'];
  const offsets = omrQuestionOffsets(template.areas);
  template.areas.forEach((a, i) => {
    const n = i + 1;
    if (a.type === 'omr') {
      const count = Math.max(1, a.questions ?? 1);
      for (let q = 0; q < count; q++) {
        const field = `OMR-${n}-${(offsets[i] ?? 0) + q + 1}`;
        fieldOrder.push(field);
        fields[field] = { kind: 'omr', question: (offsets[i] ?? 0) + q + 1, area: n, status: 'blank', confidence: 0 };
      }
    } else if (a.type === 'bcr') {
      fieldOrder.push(`BCR-${n}`);
      fields[`BCR-${n}`] = { kind: 'bcr', status: 'unreadable', confidence: 0 };
    } else {
      fieldOrder.push(`OCR-${n}`);
      fields[`OCR-${n}`] = { kind: 'ocr', status: 'unreadable', text: '', confidence: 0 };
    }
  });
  flags.add(reason);
  return {
    sheetId: sheet.id,
    fileName: sheet.fileName,
    aligned: false,
    alignMethod: method,
    alignConfidence: confidence,
    fields,
    fieldOrder,
    flags: [...flags],
    marks: [],
    reviewCanvas: canvas,
  };
}
