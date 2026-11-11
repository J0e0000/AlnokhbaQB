// ============================================================
// ALNOKHBA QB — Canonical Document Model (schema v2)
// Single source of truth driving: editor canvas, preview, PDF,
// OMR sheet generation and OMR recognition.
// All geometry is in MILLIMETERS relative to the physical page.
// ============================================================

export const QB_SCHEMA_VERSION = 2 as const;

export type QBDirection = 'rtl' | 'ltr';

export interface QBPageSize {
  widthMm: number; // 210 for A4
  heightMm: number; // 297 for A4
}

export interface QBMargins {
  topMm: number;
  rightMm: number;
  bottomMm: number;
  leftMm: number;
}

export interface QBBranding {
  institution: string;
  examTitle: string;
  subtitle?: string;
  academicYear?: string;
  duration?: string;
  logoDataUrl?: string;
  showBorders: boolean;
  borderStyle: 'none' | 'single' | 'double';
  borderColor: string;
  /** accent bar color at the top of every page (port of original design.color) */
  accentColor?: string;
  /** paper font scale for question text: 's' | 'm' | 'l' (original design.font) */
  fontScale?: 's' | 'm' | 'l';
  /** footer line at the bottom of the last page (original design.footer) */
  footer?: string;
}

// ---- Elements (canvas objects; absolute mm coordinates on the page) ----

export type QBElementType =
  | 'text'
  | 'header'
  | 'image'
  | 'logo'
  | 'question'
  | 'shape'
  | 'line'
  | 'page-number'
  | 'name-fields';

export interface QBTextStyle {
  fontFamily: 'Tajawal' | 'Amiri';
  fontSize: number; // pt
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'right' | 'center' | 'left' | 'justify';
  color: string; // hex
  lineHeight: number; // multiplier
  direction?: QBDirection;
}

export interface QBBaseElement {
  id: string;
  page: number; // page index (0-based)
  x: number; // mm, from page left
  y: number; // mm, from page top
  widthMm: number;
  heightMm: number;
  rotation: number; // degrees
  locked?: boolean;
  visible?: boolean;
}

export interface QBTextElement extends QBBaseElement {
  type: 'text';
  style: QBTextStyle;
  content: { text: string };
}

export interface QBHeaderElement extends QBBaseElement {
  type: 'header';
  style: QBTextStyle;
  content: { text: string; level: 1 | 2 | 3; showMeta: boolean };
}

export interface QBImageElement extends QBBaseElement {
  type: 'image';
  style: QBTextStyle;
  content: { dataUrl: string; fit: 'contain' | 'cover' };
}

export interface QBLogoElement extends QBBaseElement {
  type: 'logo';
  style: QBTextStyle;
  content: { dataUrl: string };
}

export interface QBQuestionElement extends QBBaseElement {
  type: 'question';
  style: QBTextStyle;
  content: {
    questionId: string;
    showNumber: boolean;
    optionLayout: 'inline' | 'grid2' | 'vertical';
    showOptionLetter: boolean;
    showMarks: boolean;
  };
}

export interface QBShapeElement extends QBBaseElement {
  type: 'shape';
  style: QBTextStyle;
  content: {
    shape: 'rect' | 'ellipse';
    fill: string; // 'transparent' allowed
    stroke: string;
    strokeWidth: number; // mm
  };
}

export interface QBLineElement extends QBBaseElement {
  type: 'line';
  style: QBTextStyle;
  content: { stroke: string; strokeWidth: number; dash?: 'solid' | 'dashed' };
}

export interface QBPageNumberElement extends QBBaseElement {
  type: 'page-number';
  style: QBTextStyle;
  content: Record<string, never>;
}

export interface QBNameFieldsElement extends QBBaseElement {
  type: 'name-fields';
  style: QBTextStyle;
  content: { fields: string[]; showStudentId: boolean };
}

export type QBElement =
  | QBTextElement
  | QBHeaderElement
  | QBImageElement
  | QBLogoElement
  | QBQuestionElement
  | QBShapeElement
  | QBLineElement
  | QBPageNumberElement
  | QBNameFieldsElement;

// ---- Questions ----

export interface QBQuestionOption {
  id: string; // 'A' | 'B' | 'C' | 'D' | ...
  text: string;
}

export interface QBQuestion {
  id: string;
  number: number; // 1-based display order
  type: 'mcq';
  prompt: string;
  imageDataUrl?: string;
  options: QBQuestionOption[]; // 2..6 options
  marks: number;
}

// ---- Document ----

export interface QBDocument {
  schemaVersion: typeof QB_SCHEMA_VERSION;
  pageSize: QBPageSize;
  margins: QBMargins;
  direction: QBDirection;
  branding: QBBranding;
  pageCount: number;
  questions: QBQuestion[];
  elements: QBElement[]; // flat list; `page` field assigns to a page
  /** grading policy (port of original settings.neg) — persisted per version snapshot */
  grading?: {
    /** points deducted per WRONG answer (0 disables; original used 0.25) */
    negativeMarking?: number;
  };
  omr: {
    enabled: boolean;
    questionsPerPage: number;
    columns: number;
    optionsPerQuestion: number;
    includeStudentId: boolean;
    studentIdDigits: number;
    includeQr: boolean;
  };
}

// ---- OMR canonical template (THE generator ↔ reader contract) ----

export interface OMRMarker {
  id: 'TL' | 'TR' | 'BL' | 'BR';
  /** center X in mm */
  x: number;
  /** center Y in mm */
  y: number;
  sizeMm: number; // filled black square; BR is intentionally smaller (orientation cue)
}

export interface OMRQuestionSpec {
  number: number;
  /** 0-based sheet index this question's bubbles are printed on */
  sheet: number;
  column: number;
  options: Record<string, { x: number; y: number }>; // bubble CENTERS in mm
  radiusMm: number;
}

export interface OMRStudentIdSpec {
  digits: number;
  /** x center of each digit column (left→right as printed) */
  digitColumnXs: number[];
  /** y center for values 0..9 (index = value) */
  valueYs: number[];
  bubbleRMm: number;
}

export interface OMRThresholds {
  /** fill ratio above which a bubble counts as intentionally marked */
  filled: number;
  /** fill ratio below which a bubble is considered empty */
  empty: number;
  /** if (top1 - top2) < margin and both >= filled → MULTIPLE; if top1 in between → UNCLEAR */
  ambiguousMargin: number;
  /** minimum absolute darkness expected from any real writing instrument */
  minAbsoluteFill: number;
}

export interface OMRTemplate {
  templateVersion: 1;
  templateId: string; // `T-${examVersionId}`
  examId: string;
  examVersionId: string;
  examTitle: string;
  versionNumber: number;
  totalQuestions: number;
  marksPerQuestion: number;
  direction: QBDirection;
  page: { widthMm: number; heightMm: number };
  referenceDpi: number;
  /** number of physical sheets (a sheet per questionsPerPage × columns block) */
  sheets: number;
  /** per-sheet question grid geometry (identical on every sheet) */
  grid: {
    /** first row center Y for sheet 0 (after student-ID block) and for sheet 1+ */
    firstRowYMm: { main: number; continuation: number };
    rowPitchMm: number;
    rows: number;
    /** bubble X centers per option letter (ltr order A..) */
    optionXsMm: number[];
    numberXMm: number;
    /** left edge X of each column (ltr index 0 = leftmost printed) */
    columnLeftsMm: number[];
    columnWidthMm: number;
    radiusMm: number;
  };
  /** outer frame rectangle (mm) — helps sheet edge detection */
  frame: { x: number; y: number; w: number; h: number };
  markers: OMRMarker[];
  qr: { x: number; y: number; sizeMm: number; payloadBySheet: string[] };
  studentId: OMRStudentIdSpec | null;
  questions: OMRQuestionSpec[];
  thresholds: OMRThresholds;
}

// ---- Scan results (engine → app) ----

export type QBAnswerStatus =
  | 'selected'
  | 'unanswered'
  | 'multiple'
  | 'unclear'
  | 'invalid';

export interface QBScannedAnswer {
  number: number;
  ratios: Record<string, number>;
  detected: string | null;
  status: QBAnswerStatus;
  confidence: number; // 0..1
}

export interface QBScanGrade {
  score: number;
  maxScore: number;
  correct: number[];
  incorrect: number[];
  ambiguous: number[];
  unanswered: number[];
  percent: number;
  /** total points deducted by negative marking (0 when disabled) */
  negativeApplied?: number;
}

export interface QBScanDiagnostics {
  stages: Record<string, boolean>;
  templateSource: 'qr' | 'manual' | 'unknown';
  templateId?: string;
  examVersionId?: string;
  rotationDeg: number;
  perspectiveApplied: boolean;
  markersFound: number;
  qrDecoded: boolean;
  warnings: string[];
  errors: string[];
  thresholdsUsed: OMRThresholds;
}

// ---- Answer key ----
export type QBAnswerKey = Record<string, string>; // questionId -> optionId
