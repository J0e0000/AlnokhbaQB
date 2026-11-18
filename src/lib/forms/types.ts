// FormScan — general-purpose form/answer-sheet scanner (OMR + OCR + BCR).
// Original implementation; templates are stored in normalized (0-1) coordinates
// so one template works at any scan resolution.

export type AreaType = 'omr' | 'ocr' | 'bcr';

/** Questions run down rows, or across columns. */
export type OmrOrientation = 'down' | 'across';

export interface FormArea {
  id: string;
  type: AreaType;
  name: string;
  /** Normalized rectangle on the reference sheet (0..1, top-left origin). */
  x: number;
  y: number;
  w: number;
  h: number;
  // --- OMR ---
  /** Number of questions in this grid. */
  questions?: number;
  /** Option labels, e.g. ["A","B","C","D","E"] or digits or ["T","F"]. */
  labels?: string[];
  orientation?: OmrOrientation;
  // --- OCR ---
  handwriting?: boolean;
  lang?: string;
  /** Character whitelist for OCR, e.g. "0123456789" for IDs. */
  whitelist?: string;
}

/** Fiducial marker rectangle (normalized). Printed black squares near corners. */
export interface FormMarker {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FormTemplate {
  version: 1;
  name: string;
  areas: FormArea[];
  /** Expected fiducial positions (0, 3 or 4 markers). Empty → deskew fallback. */
  markers: FormMarker[];
  /** Darkness delta above the grid median that counts as a mark (default 0.12). */
  threshold: number;
  /** Resolve "multiple" to the clearly-darkest cell (margin ≥ 0.08) when possible. */
  lenient: boolean;
  /** Reference sheet pixel size (from the sample sheet the template was drawn on). */
  refWidth: number;
  refHeight: number;
  // --- grading (all optional) ---
  /** questionNumber (as string) → option label. Empty string/missing = not graded. */
  key: Record<string, string>;
  /** questionNumber → weight (default 1). */
  weights: Record<string, number>;
  /** Penalty per wrong answered question (0 = negative marking disabled). */
  negative: number;
}

export const DEFAULT_OPTION_PRESETS: { id: string; label: string; labels: string[] }[] = [
  { id: 'ABCDE', label: 'A–E', labels: ['A', 'B', 'C', 'D', 'E'] },
  { id: 'ABCD', label: 'A–D', labels: ['A', 'B', 'C', 'D'] },
  { id: 'ABC', label: 'A–C', labels: ['A', 'B', 'C'] },
  { id: 'TF', label: 'T / F', labels: ['T', 'F'] },
  { id: 'YN', label: 'Y / N', labels: ['Y', 'N'] },
  {
    id: 'D0123456789',
    label: '0–9',
    labels: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  },
];

export function makeTemplate(partial?: Partial<FormTemplate>): FormTemplate {
  return {
    version: 1,
    name: partial?.name ?? 'Untitled form',
    areas: partial?.areas ?? [],
    markers: partial?.markers ?? [],
    threshold: partial?.threshold ?? 0.12,
    lenient: partial?.lenient ?? false,
    refWidth: partial?.refWidth ?? 0,
    refHeight: partial?.refHeight ?? 0,
    key: partial?.key ?? {},
    weights: partial?.weights ?? {},
    negative: partial?.negative ?? 0,
  };
}

export function validateTemplate(t: unknown): FormTemplate | null {
  if (!t || typeof t !== 'object') return null;
  const raw = t as Partial<FormTemplate>;
  if (!Array.isArray(raw.areas)) return null;
  const areas = raw.areas.filter(
    (a) =>
      a &&
      typeof a === 'object' &&
      (a.type === 'omr' || a.type === 'ocr' || a.type === 'bcr') &&
      Number.isFinite(a.x) &&
      Number.isFinite(a.y) &&
      Number.isFinite(a.w) &&
      Number.isFinite(a.h)
  );
  return makeTemplate({ ...raw, areas: areas as FormArea[] });
}

/** Base question number (0-based offset) for every OMR area, in template order. */
export function omrQuestionOffsets(areas: FormArea[]): number[] {
  const offsets: number[] = [];
  let n = 0;
  for (const a of areas) {
    offsets.push(n);
    if (a.type === 'omr') n += Math.max(1, a.questions ?? 1);
  }
  return offsets;
}

/** Total number of OMR questions (continuous numbering across areas). */
export function totalOmrQuestions(areas: FormArea[]): number {
  return areas.reduce((sum, a) => (a.type === 'omr' ? sum + Math.max(1, a.questions ?? 1) : sum), 0);
}

export type CellStatus = 'single' | 'blank' | 'multiple' | 'text' | 'unreadable';

export interface CellValue {
  kind: AreaType;
  /** OMR global question number (1-based) — for grading + review. */
  question?: number;
  /** OMR area index (1-based). */
  area?: number;
  status: CellStatus;
  labels?: string[];
  text?: string;
  confidence?: number;
  edited?: boolean;
}

export interface MarkOverlay {
  /** Normalized center + radius (radius relative to sheet width). */
  x: number;
  y: number;
  r: number;
  labels: string[];
  state: 'marked' | 'multiple' | 'low';
  question: number;
}

export type SheetFlag =
  | 'blank'
  | 'multiple'
  | 'unreadable-bcr'
  | 'unreadable-ocr'
  | 'alignment-failed'
  | 'low-confidence';

export type AlignMethod = 'homography' | 'affine' | 'deskew' | 'none' | 'failed';

export interface SheetResult {
  sheetId: string;
  fileName: string;
  aligned: boolean;
  alignMethod: AlignMethod;
  alignConfidence: number;
  fields: Record<string, CellValue>;
  /** Ordered field names (columns), matching the fieldNames() helper. */
  fieldOrder: string[];
  flags: SheetFlag[];
  marks: MarkOverlay[];
}

/** Column names, in order: file_name, then per-area fields. */
export function fieldNames(template: FormTemplate): string[] {
  const out: string[] = ['file_name'];
  template.areas.forEach((a, i) => {
    const n = i + 1;
    if (a.type === 'bcr') out.push(`BCR-${n}`);
    else if (a.type === 'ocr') out.push(`OCR-${n}`);
    else {
      const base = omrQuestionOffsets(template.areas)[i] ?? 0;
      const count = Math.max(1, a.questions ?? 1);
      for (let q = 0; q < count; q++) out.push(`OMR-${n}-${base + q + 1}`);
    }
  });
  return out;
}

export function flagLabel(f: SheetFlag, lang: 'ar' | 'en'): string {
  const map: Record<SheetFlag, [string, string]> = {
    blank: ['إجابة فارغة', 'blank answers'],
    multiple: ['تظليل متعدد', 'multiple marks'],
    'unreadable-bcr': ['باركود غير مقروء', 'unreadable barcode'],
    'unreadable-ocr': ['نص غير مقروء', 'unreadable text'],
    'alignment-failed': ['فشل محاذاة الورقة', 'sheet alignment failed'],
    'low-confidence': ['ثقة منخفضة', 'low confidence'],
  };
  const [ar, en] = map[f];
  return lang === 'ar' ? ar : en;
}
