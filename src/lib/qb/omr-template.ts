// ============================================================
// ALNOKHBA QB — Canonical OMR Template Builder
// THE contract between sheet generation and the recognition
// engine. Every bubble center is expressed in millimeters and
// both sides (TS generator + Python reader) consume this exact
// structure. Deterministic: same version → same template.
// ============================================================

import { createHash } from 'crypto';
import type {
  OMRTemplate,
  OMRQuestionSpec,
  QBDocument,
  QBDirection,
} from './types';

export const OMR_DEFAULT_THRESHOLDS = {
  filled: 0.45,
  empty: 0.17,
  ambiguousMargin: 0.1,
  minAbsoluteFill: 0.08,
};

// Fixed geometry (mm) — mirrored in render-omr.ts and the Python engine.
export const OMR_GEOMETRY = {
  frame: { x: 6, y: 6, w: 198, h: 285 },
  markers: [
    { id: 'TL' as const, x: 14, y: 14, sizeMm: 7 },
    { id: 'TR' as const, x: 196, y: 14, sizeMm: 7 },
    { id: 'BL' as const, x: 14, y: 283, sizeMm: 7 },
    { id: 'BR' as const, x: 196, y: 283, sizeMm: 5 }, // intentionally smaller → orientation cue
  ],
  qr: { x: 24, y: 24, sizeMm: 18 },
  studentId: {
    labelX: 16,
    digitPitchX: 8,
    firstDigitX: 26,
    firstValueY: 54,
    valuePitchY: 4.6,
    values: 10,
    bubbleRMm: 1.6,
    digitsTopY: 47,
  },
  grid: {
    rowPitchMm: 6.6,
    rows: 25,
    optionPitchX: 8,
    radiusMm: 2.0,
    columnWidthMm: 49.5,
    columnsX: [6, 55.5, 105, 154.5], // left edges, ltr order
    headerYMm: 104, // column letters row (sheet 0)
    firstRowYMain: 112, // first bubble row center (sheet 0)
    firstRowYCont: 56, // first bubble row center (sheet 1+)
    contHeaderY: 48,
  },
} as const;

export function omrChecksum(examVersionId: string, templateId: string, sheet: number): string {
  return createHash('sha256')
    .update(`${examVersionId}|${templateId}|${sheet}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}

export function buildQrPayload(
  examVersionId: string,
  templateId: string,
  sheet: number,
  sheets: number
): string {
  return `ANQB|1|${examVersionId}|${templateId}|${sheet}|${sheets}|${omrChecksum(examVersionId, templateId, sheet)}`;
}

export function parseQrPayload(
  payload: string
): { examVersionId: string; templateId: string; sheet: number; sheets: number } | null {
  try {
    const parts = payload.trim().split('|');
    if (parts.length !== 7 || parts[0] !== 'ANQB') return null;
    const [, ver, examVersionId, templateId, sheetS, sheetsS, check] = parts;
    if (ver !== '1') return null;
    const sheet = parseInt(sheetS, 10);
    const sheets = parseInt(sheetsS, 10);
    if (!Number.isInteger(sheet) || !Number.isInteger(sheets)) return null;
    const expected = omrChecksum(examVersionId, templateId, sheet);
    if (check.toUpperCase() !== expected) return null;
    return { examVersionId, templateId, sheet, sheets };
  } catch {
    return null;
  }
}

/**
 * Build the canonical OMR template from a canonical document + exam version.
 * Question numbers are 1-based and follow document.questions order.
 * On RTL sheets, column 0 (Q1..) is the RIGHTMOST printed column.
 */
export function buildOmrTemplate(params: {
  examId: string;
  examVersionId: string;
  document: QBDocument;
  versionNumber: number;
  thresholds?: Partial<typeof OMR_DEFAULT_THRESHOLDS>;
}): OMRTemplate {
  const { examId, examVersionId, document, versionNumber } = params;
  const templateId = `T-${examVersionId}`;
  const omr = document.omr;

  const totalQuestions = document.questions.length;
  const optionsCount = Math.max(
    2,
    Math.min(6, omr.optionsPerQuestion || 4)
  );
  const optionLetters = Array.from({ length: optionsCount }, (_, i) =>
    String.fromCharCode(65 + i)
  ); // A, B, C, D...

  const perSheet = omr.columns * OMR_GEOMETRY.grid.rows;
  const sheets = Math.max(1, Math.ceil(Math.max(totalQuestions, 1) / perSheet));
  const direction: QBDirection = document.direction ?? 'rtl';

  // Bubble X centers per option (ltr order A..). For RTL sheets the option
  // group is mirrored so that 'A' is nearest the question number (right side).
  const optionXs = Array.from(
    { length: optionsCount },
    (_, i) => 12 + i * OMR_GEOMETRY.grid.optionPitchX
  ); // relative to column left edge, ltr
  const numberX = 12 + optionsCount * OMR_GEOMETRY.grid.optionPitchX + 4;

  const questions: OMRQuestionSpec[] = [];
  for (let qIdx = 0; qIdx < totalQuestions; qIdx++) {
    const qNumber = qIdx + 1;
    const sheet = Math.floor(qIdx / perSheet);
    const idxInSheet = qIdx % perSheet;
    const colLtr = Math.floor(idxInSheet / OMR_GEOMETRY.grid.rows);
    const row = idxInSheet % OMR_GEOMETRY.grid.rows;

    // For RTL: printed column order is right→left, so printed column index
    // (0 = rightmost) maps to ltr column index (columns - 1 - printedIdx).
    const printedCol = direction === 'rtl' ? omr.columns - 1 - colLtr : colLtr;
    const colLeft = OMR_GEOMETRY.grid.columnsX[printedCol] ?? 0;
    const firstRowY =
      sheet === 0 ? OMR_GEOMETRY.grid.firstRowYMain : OMR_GEOMETRY.grid.firstRowYCont;
    const rowY = firstRowY + row * OMR_GEOMETRY.grid.rowPitchMm;

    const options: Record<string, { x: number; y: number }> = {};
    optionLetters.forEach((letter, oi) => {
      // For RTL, option A is closest to the number box (right side of group).
      const oiPrinted = direction === 'rtl' ? optionsCount - 1 - oi : oi;
      options[letter] = {
        x: colLeft + optionXs[oiPrinted],
        y: rowY,
      };
    });

    questions.push({
      number: qNumber,
      sheet,
      column: printedCol,
      options,
      radiusMm: OMR_GEOMETRY.grid.radiusMm,
    });
  }

  const studentId = omr.includeStudentId
    ? {
        digits: omr.studentIdDigits,
        digitColumnXs: Array.from(
          { length: omr.studentIdDigits },
          (_, i) => OMR_GEOMETRY.studentId.firstDigitX + i * OMR_GEOMETRY.studentId.digitPitchX
        ),
        valueYs: Array.from(
          { length: OMR_GEOMETRY.studentId.values },
          (_, v) =>
            OMR_GEOMETRY.studentId.firstValueY + v * OMR_GEOMETRY.studentId.valuePitchY
        ),
        bubbleRMm: OMR_GEOMETRY.studentId.bubbleRMm,
      }
    : null;

  return {
    templateVersion: 1,
    templateId,
    examId,
    examVersionId,
    examTitle: document.branding.examTitle,
    versionNumber,
    totalQuestions,
    marksPerQuestion: document.questions[0]?.marks ?? 1,
    direction,
    page: { widthMm: document.pageSize.widthMm, heightMm: document.pageSize.heightMm },
    referenceDpi: 300,
    sheets,
    grid: {
      firstRowYMm: {
        main: OMR_GEOMETRY.grid.firstRowYMain,
        continuation: OMR_GEOMETRY.grid.firstRowYCont,
      },
      rowPitchMm: OMR_GEOMETRY.grid.rowPitchMm,
      rows: OMR_GEOMETRY.grid.rows,
      optionXsMm: optionXs,
      numberXMm: numberX,
      columnLeftsMm: [...OMR_GEOMETRY.grid.columnsX],
      columnWidthMm: OMR_GEOMETRY.grid.columnWidthMm,
      radiusMm: OMR_GEOMETRY.grid.radiusMm,
    },
    frame: { ...OMR_GEOMETRY.frame },
    markers: OMR_GEOMETRY.markers.map((m) => ({ ...m })),
    qr: {
      x: OMR_GEOMETRY.qr.x,
      y: OMR_GEOMETRY.qr.y,
      sizeMm: OMR_GEOMETRY.qr.sizeMm,
      payloadBySheet: Array.from({ length: sheets }, (_, s) =>
        buildQrPayload(examVersionId, templateId, s, sheets)
      ),
    },
    studentId,
    questions,
    thresholds: {
      ...OMR_DEFAULT_THRESHOLDS,
      ...(params.thresholds ?? {}),
    },
  };
}

/** Filter the template's questions for one sheet (used by engine + renderer). */
export function questionsForSheet(template: OMRTemplate, sheet: number): OMRQuestionSpec[] {
  return template.questions.filter((q) => q.sheet === sheet);
}
