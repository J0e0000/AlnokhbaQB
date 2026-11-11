// ============================================================
// ALNOKHBA QB — Zod validation + security sanitizer.
// All user-supplied document JSON MUST pass through here before
// being stored or rendered (XSS / malicious SVG / unsafe images).
// ============================================================

import { z } from 'zod';
import type { QBDocument, QBElement, QBQuestion } from './types';
import { QB_SCHEMA_VERSION } from './types';

const MM = z.number().finite().min(0).max(2000);
const PT = z.number().finite().min(1).max(200);

// Allow-listed, size-capped image data URLs only. No remote URLs, no SVG.
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const safeDataUrl = z
  .string()
  .max(MAX_IMAGE_BYTES + 256, 'Image too large (max 3MB)')
  .refine((s) => s === '' || DATA_URL_RE.test(s.trim()), {
    message: 'Images must be base64 data URLs (png/jpeg/webp/gif). Remote URLs and SVG are not allowed.',
  })
  .transform((s) => s.trim());

const hexColor = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|transparent)$/, 'Invalid color')
  .default('#000000');

const textStyleSchema = z.object({
  fontFamily: z.enum(['Tajawal', 'Amiri']).default('Tajawal'),
  fontSize: PT.default(11),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  underline: z.boolean().default(false),
  align: z.enum(['right', 'center', 'left', 'justify']).default('right'),
  color: hexColor,
  lineHeight: z.number().finite().min(0.8).max(3).default(1.5),
  direction: z.enum(['rtl', 'ltr']).optional(),
});

const baseElementSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  page: z.number().int().min(0).max(99),
  x: MM,
  y: MM,
  widthMm: z.number().finite().min(1).max(2000),
  heightMm: z.number().finite().min(1).max(2000),
  rotation: z.number().finite().min(-360).max(360).default(0),
  locked: z.boolean().optional(),
  visible: z.boolean().optional(),
});

const textElementSchema = baseElementSchema.extend({
  type: z.literal('text'),
  style: textStyleSchema,
  content: z.object({
    text: z.string().max(20000),
  }),
});

const headerElementSchema = baseElementSchema.extend({
  type: z.literal('header'),
  style: textStyleSchema,
  content: z.object({
    text: z.string().max(2000),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
    showMeta: z.boolean().default(true),
  }),
});

const imageElementSchema = baseElementSchema.extend({
  type: z.literal('image'),
  style: textStyleSchema,
  content: z.object({
    dataUrl: safeDataUrl,
    fit: z.enum(['contain', 'cover']).default('contain'),
  }),
});

const logoElementSchema = baseElementSchema.extend({
  type: z.literal('logo'),
  style: textStyleSchema,
  content: z.object({ dataUrl: safeDataUrl }),
});

const questionElementSchema = baseElementSchema.extend({
  type: z.literal('question'),
  style: textStyleSchema,
  content: z.object({
    questionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    showNumber: z.boolean().default(true),
    optionLayout: z.enum(['inline', 'grid2', 'vertical']).default('inline'),
    showOptionLetter: z.boolean().default(true),
    showMarks: z.boolean().default(false),
  }),
});

const shapeElementSchema = baseElementSchema.extend({
  type: z.literal('shape'),
  style: textStyleSchema,
  content: z.object({
    shape: z.enum(['rect', 'ellipse']).default('rect'),
    fill: hexColor.default('transparent'),
    stroke: hexColor.default('#000000'),
    strokeWidth: z.number().finite().min(0).max(10).default(0.3),
  }),
});

const lineElementSchema = baseElementSchema.extend({
  type: z.literal('line'),
  style: textStyleSchema,
  content: z.object({
    stroke: hexColor.default('#000000'),
    strokeWidth: z.number().finite().min(0).max(10).default(0.3),
    dash: z.enum(['solid', 'dashed']).default('solid'),
  }),
});

const pageNumberElementSchema = baseElementSchema.extend({
  type: z.literal('page-number'),
  style: textStyleSchema,
  content: z.object({}).passthrough().default({}),
});

const nameFieldsElementSchema = baseElementSchema.extend({
  type: z.literal('name-fields'),
  style: textStyleSchema,
  content: z.object({
    fields: z.array(z.string().max(120)).max(8).default([]),
    showStudentId: z.boolean().default(true),
  }),
});

const elementSchema = z.discriminatedUnion('type', [
  textElementSchema,
  headerElementSchema,
  imageElementSchema,
  logoElementSchema,
  questionElementSchema,
  shapeElementSchema,
  lineElementSchema,
  pageNumberElementSchema,
  nameFieldsElementSchema,
]);

const questionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  number: z.number().int().min(1).max(500),
  type: z.literal('mcq').default('mcq'),
  prompt: z.string().max(20000),
  imageDataUrl: safeDataUrl.optional(),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(4).regex(/^[A-Za-z0-9]+$/),
        text: z.string().max(5000),
      })
    )
    .min(2)
    .max(6),
  marks: z.number().finite().min(0).max(1000).default(1),
});

export const qbDocumentSchema = z.object({
  schemaVersion: z.literal(QB_SCHEMA_VERSION),
  pageSize: z
    .object({
      widthMm: z.number().finite().min(50).max(500),
      heightMm: z.number().finite().min(50).max(500),
    })
    .default({ widthMm: 210, heightMm: 297 }),
  margins: z
    .object({
      topMm: MM.default(12),
      rightMm: MM.default(12),
      bottomMm: MM.default(12),
      leftMm: MM.default(12),
    })
    .default({ topMm: 12, rightMm: 12, bottomMm: 12, leftMm: 12 }),
  direction: z.enum(['rtl', 'ltr']).default('rtl'),
  branding: z.object({
    institution: z.string().max(300).default('مدرسة النخبة'),
    examTitle: z.string().max(300).default('امتحان جديد'),
    subtitle: z.string().max(300).optional(),
    academicYear: z.string().max(100).optional(),
    duration: z.string().max(100).optional(),
    logoDataUrl: safeDataUrl.optional(),
    showBorders: z.boolean().default(true),
    borderStyle: z.enum(['none', 'single', 'double']).default('single'),
    borderColor: hexColor.default('#1e293b'),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid accent color')
      .optional(),
    fontScale: z.enum(['s', 'm', 'l']).optional(),
    footer: z.string().max(300).optional(),
  }),
  pageCount: z.number().int().min(1).max(50).default(1),
  questions: z.array(questionSchema).max(500).default([]),
  elements: z.array(elementSchema).max(2000).default([]),
  grading: z
    .object({
      negativeMarking: z.number().finite().min(0).max(1).optional(),
    })
    .optional(),
  omr: z
    .object({
      enabled: z.boolean().default(false),
      questionsPerPage: z.number().int().min(10).max(140).default(25),
      columns: z.number().int().min(2).max(5).default(4),
      optionsPerQuestion: z.number().int().min(2).max(6).default(4),
      includeStudentId: z.boolean().default(true),
      studentIdDigits: z.number().int().min(4).max(10).default(6),
      includeQr: z.boolean().default(true),
    })
    .default({
      enabled: false,
      questionsPerPage: 25,
      columns: 4,
      optionsPerQuestion: 4,
      includeStudentId: true,
      studentIdDigits: 6,
      includeQr: true,
    }),
});

export type SanitizedDocument = z.infer<typeof qbDocumentSchema>;

export const answerKeySchema = z.record(
  z.string().max(64),
  z.string().max(4)
);

/** Validate + normalize a canonical document coming from the client. Throws on invalid input. */
export function sanitizeDocument(input: unknown): QBDocument {
  const parsed = qbDocumentSchema.parse(input);
  // strip any question elements pointing at non-existent questions
  const qIds = new Set(parsed.questions.map((q) => q.id));
  const elements = parsed.elements.filter(
    (el) => el.type !== 'question' || qIds.has((el as { content: { questionId: string } }).content.questionId)
  );
  return { ...parsed, elements } as unknown as QBDocument;
}

/** Sanitize an answer key. */
export function sanitizeAnswerKey(input: unknown): Record<string, string> {
  return answerKeySchema.parse(input);
}

/** Build a fresh starter document for a new exam. */
export function starterDocument(title: string, institution: string): QBDocument {
  return {
    schemaVersion: QB_SCHEMA_VERSION,
    pageSize: { widthMm: 210, heightMm: 297 },
    margins: { topMm: 12, rightMm: 12, bottomMm: 12, leftMm: 12 },
    direction: 'rtl',
    branding: {
      institution,
      examTitle: title,
      showBorders: true,
      borderStyle: 'single',
      borderColor: '#1e293b',
    },
    pageCount: 1,
    questions: [],
    elements: [
      {
        id: 'el-header',
        type: 'header',
        page: 0,
        x: 15,
        y: 12,
        widthMm: 180,
        heightMm: 22,
        rotation: 0,
        style: {
          fontFamily: 'Tajawal',
          fontSize: 16,
          bold: true,
          italic: false,
          underline: false,
          align: 'center',
          color: '#1e293b',
          lineHeight: 1.3,
        },
        content: { text: title, level: 1, showMeta: true },
      },
      {
        id: 'el-name',
        type: 'name-fields',
        page: 0,
        x: 15,
        y: 36,
        widthMm: 180,
        heightMm: 20,
        rotation: 0,
        style: {
          fontFamily: 'Tajawal',
          fontSize: 11,
          bold: false,
          italic: false,
          underline: false,
          align: 'right',
          color: '#0f172a',
          lineHeight: 1.6,
        },
        content: { fields: ['اسم الطالب', 'الفصل'], showStudentId: true },
      },
    ],
    omr: {
      enabled: false,
      questionsPerPage: 25,
      columns: 4,
      optionsPerQuestion: 4,
      includeStudentId: true,
      studentIdDigits: 6,
      includeQr: true,
    },
  };
}
