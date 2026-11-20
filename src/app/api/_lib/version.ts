// ============================================================
// ALNOKHBA QB — version loading helpers for API routes
// ============================================================

import type { Exam, ExamVersion } from '@prisma/client';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sanitizeAnswerKey, sanitizeDocument } from '@/lib/qb/schema';
import type { OMRTemplate, QBAnswerKey, QBDocument } from '@/lib/qb/types';

export interface LoadedVersion {
  row: ExamVersion;
  document: QBDocument;
  answerKey: QBAnswerKey;
  omrTemplate: OMRTemplate | null;
}

/** Load a version snapshot with sanitized document + key + parsed OMR template. */
export async function loadVersion(id: string): Promise<LoadedVersion | null> {
  const row = await db.examVersion.findUnique({ where: { id }, include: { exam: true } });
  if (!row) return null;
  const document = sanitizeDocument(JSON.parse(row.documentJson));
  let answerKey: QBAnswerKey = {};
  try {
    answerKey = sanitizeAnswerKey(JSON.parse(row.answerKeyJson));
  } catch {
    answerKey = {};
  }
  let omrTemplate: OMRTemplate | null = null;
  if (row.omrTemplateJson) {
    try {
      omrTemplate = JSON.parse(row.omrTemplateJson) as OMRTemplate;
    } catch {
      omrTemplate = null;
    }
  }
  return { row, document, answerKey, omrTemplate };
}

/** Binary PDF response with inline disposition. */
export function pdfResponse(pdf: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Duplicate the OMR sheets N times inside a rendered OMR HTML document.
 * Robust against the exact markup produced by renderOmrHtml(): the whole
 * <body> content (one .sheet div per template sheet) is repeated N times.
 */
export function duplicateOmrSheets(html: string, copies: number): string {
  const bodyMatch = /<body>([\s\S]*?)<\/body>/.exec(html);
  if (!bodyMatch) return html;
  const bodyContent = bodyMatch[1];
  const repeated = Array.from({ length: Math.max(1, copies) }, () => bodyContent).join('\n');
  return html.replace(/<body>[\s\S]*?<\/body>/, `<body>\n${repeated}\n</body>`);
}

/** Parse + clamp an integer query param. */
export function intParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const n = parseInt(value ?? '', 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve a version by version id OR by exam id. When an exam id is given the
 * current published version wins; otherwise the latest version is used. This
 * lets legacy clients pass an examId "hint" instead of an exact version id.
 */
export async function loadVersionHint(hint: string): Promise<LoadedVersion | null> {
  const direct = await loadVersion(hint);
  if (direct) return direct;
  const exam = await db.exam.findUnique({ where: { id: hint } });
  if (!exam) return null;
  if (exam.currentVersion > 0) {
    const current = await loadVersionByRow(
      await db.examVersion.findUnique({
        where: { examId_version: { examId: exam.id, version: exam.currentVersion } },
        include: { exam: true },
      })
    );
    if (current) return current;
  }
  const latest = await db.examVersion.findFirst({
    where: { examId: exam.id },
    orderBy: { version: 'desc' },
    include: { exam: true },
  });
  return loadVersionByRow(latest);
}

/** Assemble a LoadedVersion from a raw (already-loaded) ExamVersion row. */
async function loadVersionByRow(
  row: (ExamVersion & { exam: Exam }) | null
): Promise<LoadedVersion | null> {
  if (!row) return null;
  const document = sanitizeDocument(JSON.parse(row.documentJson));
  let answerKey: QBAnswerKey = {};
  try {
    answerKey = sanitizeAnswerKey(JSON.parse(row.answerKeyJson));
  } catch {
    answerKey = {};
  }
  let omrTemplate: OMRTemplate | null = null;
  if (row.omrTemplateJson) {
    try {
      omrTemplate = JSON.parse(row.omrTemplateJson) as OMRTemplate;
    } catch {
      omrTemplate = null;
    }
  }
  return { row, document, answerKey, omrTemplate };
}
