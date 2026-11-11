// ============================================================
// ALNOKHBA QB — Assignments domain helpers (PHASE 5)
// Shared by /api/assignments/* routes: zod validation, upload
// limits, filename sanitization, public shapes.
// dueAt is always a server-side instant; the client clock is
// display-only and never trusted.
// ============================================================

import { z } from 'zod';

export const ASSIGNMENT_MODES = ['graded', 'file'] as const;
export const LATE_POLICIES = ['allow', 'block'] as const;

/** zod schema for POST /api/assignments (create). */
export const assignmentCreateSchema = z.object({
  title: z.string().trim().min(2, 'العنوان قصير جدًا').max(200),
  description: z.string().trim().max(4000).optional().default(''),
  mode: z.enum(ASSIGNMENT_MODES).default('file'),
  examId: z.string().trim().min(1).nullish(), // required when mode=graded
  dueAt: z.string().min(1, 'موعد التسليم مطلوب'), // ISO instant; validated below
  latePolicy: z.enum(LATE_POLICIES).default('allow'),
});

/** Parse a dueAt string into a Date. Returns null when absent/invalid. */
export function parseDueDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ---------- file uploads (file mode) ----------

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB decoded

export const ALLOWED_UPLOAD_EXT = [
  'pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'zip',
] as const;

/** Extract + validate a file extension. Returns null when not allowed. */
export function safeExtension(fileName: string): string | null {
  const m = /\.([a-zA-Z0-9]+)$/.exec(fileName.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return (ALLOWED_UPLOAD_EXT as readonly string[]).includes(ext) ? ext : null;
}

/** Strip path separators / control chars from a client-supplied filename. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[\u0000-\u001f<>:"|?*]+/g, '').trim().slice(0, 120) || 'file';
}

// ---------- public shapes ----------

export interface PublicAssignment {
  id: string;
  title: string;
  description: string;
  mode: string;
  examId: string | null;
  examTitle: string | null;
  dueAt: string;
  latePolicy: string;
  status: string;
  submissionCount: number;
  createdAt: string;
}

export function publicAssignment(a: {
  id: string;
  title: string;
  description: string;
  mode: string;
  examId: string | null;
  dueAt: Date;
  latePolicy: string;
  status: string;
  createdAt: Date;
  exam?: { title: string } | null;
  _count?: { submissions: number };
}): PublicAssignment {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    mode: a.mode,
    examId: a.examId,
    examTitle: a.exam?.title ?? null,
    dueAt: a.dueAt.toISOString(),
    latePolicy: a.latePolicy,
    status: a.status,
    submissionCount: a._count?.submissions ?? 0,
    createdAt: a.createdAt.toISOString(),
  };
}

export interface PublicSubmission {
  id: string;
  studentName: string;
  studentCode: string | null;
  attemptId: string | null;
  hasFile: boolean;
  fileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  score: number | null;
  maxScore: number | null;
  feedback: string | null;
  late: boolean;
  status: string;
  submittedAt: string;
}

export function publicSubmission(s: {
  id: string;
  studentName: string;
  studentCode: string | null;
  attemptId: string | null;
  fileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  score: number | null;
  maxScore: number | null;
  feedback: string | null;
  late: boolean;
  status: string;
  submittedAt: Date;
}): PublicSubmission {
  return {
    id: s.id,
    studentName: s.studentName,
    studentCode: s.studentCode,
    attemptId: s.attemptId,
    hasFile: Boolean(s.fileName),
    fileName: s.fileName,
    fileType: s.fileType,
    fileSize: s.fileSize,
    score: s.score,
    maxScore: s.maxScore,
    feedback: s.feedback,
    late: s.late,
    status: s.status,
    submittedAt: s.submittedAt.toISOString(),
  };
}
