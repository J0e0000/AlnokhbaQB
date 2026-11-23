// ============================================================
// ALNOKHBA QB — Fixed reusable answer sheet (exam-level template)
//
// One sheet for every student of an exam: no student identity is
// printed anywhere. The sheet carries
//   • four corner markers (BR intentionally smaller → orientation cue)
//   • a QR that names ONLY the exam + template + page index
//   • a handwritten student-ID strip (one box per digit)
//   • a version bubble row (A/B/C/D …) the student fills in
//   • a numbered answer grid (question numbers only, no question text)
//
// The same template is printed for every version, so copies can be
// distributed in any order. The version bubble decides which answer
// key the server applies; the handwritten ID is only an assist and is
// always confirmed against the roster before it becomes a result.
// ============================================================

import { createHash } from 'crypto';
import type { OMRTemplate, OMRQuestionSpec, QBDirection } from './types';

export const FIXED_SHEET_VERSION = 2;

/** Printed geometry in millimetres. Mirrored in render-fixed-sheet.ts + the
 *  Python reader (`engine/fixed.py`) — keep the three in sync. */
export const FIXED_GEOMETRY = {
  frame: { x: 6, y: 6, w: 198, h: 285 },
  markers: [
    // Big, haloed squares in the extreme corners: they must stay the only
    // dark blobs near a corner so the detector never mistakes a bubble for one.
    { id: 'TL' as const, x: 13, y: 13, sizeMm: 8 },
    { id: 'TR' as const, x: 197, y: 13, sizeMm: 8 },
    { id: 'BL' as const, x: 13, y: 284, sizeMm: 8 },
    { id: 'BR' as const, x: 197, y: 284, sizeMm: 6 }, // smaller → orientation cue
  ],
  qr: { x: 20, y: 22, sizeMm: 18 },
  idStrip: {
    firstBoxX: 48,
    boxY: 15,
    boxW: 9,
    boxH: 12,
    gapX: 2,
    maxDigits: 10,
    minDigits: 4,
    digitHeightMm: 8,
  },
  // Deterministic identity: one bubble column per digit, 0-9 top→bottom.
  // This is what the engine trusts; the handwritten strip above is the
  // assist that only fills gaps the grid leaves empty.
  idGrid: {
    firstX: 48,
    firstY: 38,
    pitchX: 8,
    pitchY: 4.2,
    radiusMm: 1.5,
    labelXMm: 44,
    digitOrder: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    maxDigits: 10,
    minDigits: 4,
  },
  version: { firstX: 116, pitchX: 12, y: 40, bubbleRMm: 2.4, maxVersions: 6 },
  grid: {
    columnLeftsMm: [6, 55.5, 105, 154.5],
    columnWidthMm: 49.5,
    optionXsMm: [12, 20, 28, 36], // up to 4 options per question
    numberXMm: 46,
    radiusMm: 2.0,
    rows: 24,
    rowPitchMm: 7.0,
    headerY: 76,
    firstRowY: 84,
  },
} as const;

export interface FixedSheetBox {
  index: number; // 0-based digit position, printed left→right
  x: number;
  y: number;
  w: number;
  h: number;
  /** same rectangle normalised to the page (0..1) — resolution independent */
  norm: { x: number; y: number; w: number; h: number };
}

export interface FixedSheetIdBoxes {
  digits: number;
  boxes: FixedSheetBox[];
  digitHeightMm: number;
}

export interface FixedSheetIdGridColumn {
  index: number;
  xMm: number;
  yTopMm: number;
  /** digit printed at each bubble, top → bottom */
  digitOrder: number[];
}

export interface FixedSheetIdGrid {
  digits: number;
  columns: FixedSheetIdGridColumn[];
  pitchYMm: number;
  radiusMm: number;
}

export interface FixedSheetVersionMarks {
  /** printed bubble letters; index i = version number i+1 */
  letters: string[];
  xsMm: number[];
  yMm: number;
  bubbleRMm: number;
}

export interface FixedSheetTemplate extends Omit<OMRTemplate, 'templateVersion' | 'examVersionId'> {
  templateVersion: 2;
  mode: 'fixed';
  /** exam-level sheet: no version binding */
  examVersionId: string;
  idBoxes: FixedSheetIdBoxes;
  idGrid: FixedSheetIdGrid;
  versionMarks: FixedSheetVersionMarks;
}

export function fixedSheetChecksum(examId: string, templateId: string, sheet: number): string {
  return createHash('sha256')
    .update(`${examId}|${templateId}|${sheet}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}

export function buildFixedSheetQr(examId: string, templateId: string, sheet: number, sheets: number): string {
  return `ANQB3|${examId}|${templateId}|${sheet}|${sheets}|${fixedSheetChecksum(examId, templateId, sheet)}`;
}

export interface ParsedFixedQr {
  examId: string;
  templateId: string;
  sheet: number;
  sheets: number;
}

/** Parse + verify an ANQB3 payload. Returns null for anything else. */
export function parseFixedSheetQr(payload: string): ParsedFixedQr | null {
  const parts = (payload ?? '').trim().split('|');
  if (parts.length !== 6 || parts[0] !== 'ANQB3') return null;
  const [, examId, templateId, sheetS, sheetsS, check] = parts;
  if (!examId || !templateId) return null;
  const sheet = parseInt(sheetS, 10);
  const sheets = parseInt(sheetsS, 10);
  if (!Number.isInteger(sheet) || !Number.isInteger(sheets)) return null;
  if (sheet < 0 || sheets < 1 || sheet >= sheets) return null;
  if (check.toUpperCase() !== fixedSheetChecksum(examId, templateId, sheet)) return null;
  return { examId, templateId, sheet, sheets };
}

const norm = (x: number, y: number, w: number, h: number, pageW: number, pageH: number) => ({
  x: round4(x / pageW),
  y: round4(y / pageH),
  w: round4(w / pageW),
  h: round4(h / pageH),
});

const round4 = (v: number) => Math.round(v * 10000) / 10000;

export interface BuildFixedSheetParams {
  examId: string;
  examTitle: string;
  totalQuestions: number;
  optionsPerQuestion?: number;
  idDigits?: number;
  versions?: number;
  direction?: QBDirection;
  marksPerQuestion?: number;
  templateId?: string;
  pageSize?: { widthMm: number; heightMm: number };
}

export function fixedSheetTemplateId(examId: string, revision: number): string {
  return `F-${examId}-r${revision}`;
}

/**
 * Build the exam-level fixed sheet. Question numbers are 1-based and follow the
 * canonical order; the printed grid never depends on the version, so the same
 * PDF serves A/B/C/D.
 */
export function buildFixedSheetTemplate(p: BuildFixedSheetParams): FixedSheetTemplate {
  const pageW = p.pageSize?.widthMm ?? 210;
  const pageH = p.pageSize?.heightMm ?? 297;
  const direction: QBDirection = p.direction ?? 'rtl';
  const templateId = p.templateId ?? fixedSheetTemplateId(p.examId, 1);
  const optionsCount = Math.max(2, Math.min(4, p.optionsPerQuestion ?? 4));
  const optionLetters = Array.from({ length: optionsCount }, (_, i) => String.fromCharCode(65 + i));
  const totalQuestions = Math.max(1, p.totalQuestions);
  const idDigits = Math.min(
    FIXED_GEOMETRY.idStrip.maxDigits,
    Math.max(FIXED_GEOMETRY.idStrip.minDigits, p.idDigits ?? 6)
  );
  const versions = Math.min(FIXED_GEOMETRY.version.maxVersions, Math.max(2, p.versions ?? 4));

  const g = FIXED_GEOMETRY.grid;
  const perSheet = g.columnLeftsMm.length * g.rows;
  const sheets = Math.max(1, Math.ceil(totalQuestions / perSheet));

  const questions: OMRQuestionSpec[] = [];
  for (let qIdx = 0; qIdx < totalQuestions; qIdx++) {
    const sheet = Math.floor(qIdx / perSheet);
    const idxInSheet = qIdx % perSheet;
    const colLtr = Math.floor(idxInSheet / g.rows);
    const row = idxInSheet % g.rows;
    const printedCol = direction === 'rtl' ? g.columnLeftsMm.length - 1 - colLtr : colLtr;
    const colLeft = g.columnLeftsMm[printedCol];
    const rowY = g.firstRowY + row * g.rowPitchMm;
    const options: Record<string, { x: number; y: number }> = {};
    optionLetters.forEach((letter, oi) => {
      const oiPrinted = direction === 'rtl' ? optionsCount - 1 - oi : oi;
      options[letter] = { x: colLeft + g.optionXsMm[oiPrinted], y: rowY };
    });
    questions.push({
      number: qIdx + 1,
      sheet,
      column: printedCol,
      options,
      radiusMm: g.radiusMm,
    });
  }

  const boxes: FixedSheetBox[] = Array.from({ length: idDigits }, (_, i) => {
    const x = FIXED_GEOMETRY.idStrip.firstBoxX + i * (FIXED_GEOMETRY.idStrip.boxW + FIXED_GEOMETRY.idStrip.gapX);
    const { boxY: y, boxW: w, boxH: h } = FIXED_GEOMETRY.idStrip;
    return { index: i, x, y, w, h, norm: norm(x, y, w, h, pageW, pageH) };
  });

  const versionLetters = Array.from({ length: versions }, (_, i) => String.fromCharCode(65 + i));
  const versionXs = versionLetters.map((_, i) => FIXED_GEOMETRY.version.firstX + i * FIXED_GEOMETRY.version.pitchX);

  return {
    templateVersion: 2,
    mode: 'fixed',
    templateId,
    examId: p.examId,
    examVersionId: '',
    examTitle: p.examTitle,
    versionNumber: 0,
    totalQuestions,
    marksPerQuestion: p.marksPerQuestion ?? 1,
    direction,
    page: { widthMm: pageW, heightMm: pageH },
    referenceDpi: 300,
    sheets,
    grid: {
      firstRowYMm: { main: g.firstRowY, continuation: g.firstRowY },
      rowPitchMm: g.rowPitchMm,
      rows: g.rows,
      optionXsMm: [...g.optionXsMm.slice(0, optionsCount)],
      numberXMm: g.numberXMm,
      columnLeftsMm: [...g.columnLeftsMm],
      columnWidthMm: g.columnWidthMm,
      radiusMm: g.radiusMm,
    },
    frame: { ...FIXED_GEOMETRY.frame },
    markers: FIXED_GEOMETRY.markers.map((m) => ({ ...m })),
    qr: {
      x: FIXED_GEOMETRY.qr.x,
      y: FIXED_GEOMETRY.qr.y,
      sizeMm: FIXED_GEOMETRY.qr.sizeMm,
      payloadBySheet: Array.from({ length: sheets }, (_, s) => buildFixedSheetQr(p.examId, templateId, s, sheets)),
    },
    studentId: null,
    idBoxes: {
      digits: idDigits,
      boxes,
      digitHeightMm: FIXED_GEOMETRY.idStrip.digitHeightMm,
    },
    idGrid: {
      digits: idDigits,
      columns: Array.from({ length: idDigits }, (_, i) => ({
        index: i,
        xMm: FIXED_GEOMETRY.idGrid.firstX + i * FIXED_GEOMETRY.idGrid.pitchX,
        yTopMm: FIXED_GEOMETRY.idGrid.firstY,
        digitOrder: [...FIXED_GEOMETRY.idGrid.digitOrder],
      })),
      pitchYMm: FIXED_GEOMETRY.idGrid.pitchY,
      radiusMm: FIXED_GEOMETRY.idGrid.radiusMm,
    },
    versionMarks: {
      letters: versionLetters,
      xsMm: versionXs,
      yMm: FIXED_GEOMETRY.version.y,
      bubbleRMm: FIXED_GEOMETRY.version.bubbleRMm,
    },
    questions,
    thresholds: {
      filled: 0.45,
      empty: 0.17,
      ambiguousMargin: 0.1,
      minAbsoluteFill: 0.08,
    },
  };
}

/** Structural check used by API routes before storing a revision. */
export function validateFixedSheetTemplate(raw: unknown): raw is FixedSheetTemplate {
  const t = raw as Partial<FixedSheetTemplate> | null;
  if (!t || typeof t !== 'object') return false;
  if (t.templateVersion !== 2 || t.mode !== 'fixed') return false;
  if (!t.templateId || !t.examId) return false;
  if (!Array.isArray(t.questions) || t.questions.length === 0) return false;
  if (!t.idBoxes || !Array.isArray(t.idBoxes.boxes) || t.idBoxes.boxes.length === 0) return false;
  if (!t.idGrid || !Array.isArray(t.idGrid.columns) || t.idGrid.columns.length === 0) return false;
  if (t.idGrid.columns.length !== t.idBoxes.boxes.length) return false;
  if (!t.versionMarks || !Array.isArray(t.versionMarks.xsMm) || t.versionMarks.xsMm.length < 2) return false;
  if (!t.qr || !Array.isArray(t.qr.payloadBySheet) || t.qr.payloadBySheet.length === 0) return false;
  if (t.qr.payloadBySheet.some((p) => !parseFixedSheetQr(p))) return false;
  return true;
}
