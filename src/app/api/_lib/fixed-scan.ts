// ============================================================
// ALNOKHBA QB — fixed reusable sheet: scan → identity → version → grade
//
// The sheet carries no student identity. The QR names the exam/template/page
// only, the handwritten ID strip is an ASSIST, and the version bubble decides
// which answer key applies. Nothing is guessed: an unreadable version, an
// unreadable ID or a duplicated page is flagged for review instead of being
// resolved by scan order.
// ============================================================

import { createHash } from 'crypto';
import type { ExamVersion, Student } from '@prisma/client';
import { NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { gradeScan } from '@/lib/qb/grading';
import { parseFixedSheetQr, type FixedSheetTemplate } from '@/lib/qb/fixed-sheet';
import type {
  OMRThresholds,
  QBAnswerKey,
  QBDocument,
  QBScanGrade,
  QBScannedAnswer,
} from '@/lib/qb/types';
import {
  isTransportError,
  processScan,
  type OmrHandwrittenId,
  type OmrIdGrid,
  type OmrProcessSuccess,
} from '@/lib/omr/client';
import { resolveScanTables } from './scan-tables';
import { decodeImage, imagesPayload, meanConfidence } from './scan-persist';
import { stripDataUrl } from './shared';

/** ID confidence below this never links a student automatically. */
export const ID_AUTO_LINK_CONFIDENCE = 0.7;

export interface LoadedFixedSheet {
  id: string;
  examId: string;
  revision: number;
  templateId: string;
  name: string;
  template: FixedSheetTemplate;
}

export async function loadFixedSheet(templateId: string): Promise<LoadedFixedSheet | null> {
  const row = await db.fixedSheet.findUnique({ where: { templateId } });
  if (!row) return null;
  try {
    const template = JSON.parse(row.dataJson) as FixedSheetTemplate;
    if (!template?.questions?.length) return null;
    return {
      id: row.id,
      examId: row.examId,
      revision: row.revision,
      templateId: row.templateId,
      name: row.name,
      template,
    };
  } catch {
    return null;
  }
}

export function imageFingerprint(base64: string): string {
  return createHash('sha256').update(base64).digest('hex');
}

const VERSION_LETTERS = 'ABCDEF';

export interface FixedScanOptions {
  imageBase64: string;
  /** first engine pass: QR identity only (needsTemplate) */
  first: OmrProcessSuccess;
  thresholds: OMRThresholds;
  batchId?: string | null;
  idempotencyKey?: string | null;
}

export async function handleFixedScan(opts: FixedScanOptions): Promise<NextResponse> {
  const { imageBase64, first, thresholds } = opts;

  const qr = first.qr?.payload ? parseFixedSheetQr(first.qr.payload) : null;
  const templateId = qr?.templateId ?? first.qr?.templateId ?? null;
  if (!templateId) {
    return NextResponse.json(
      { error: 'رمز QR على الورقة غير صالح (fixed sheet)', stage: 'noMatchingVersion' },
      { status: 404 }
    );
  }

  const sheet = await loadFixedSheet(templateId);
  if (!sheet) {
    return NextResponse.json(
      {
        error: 'الورقة الموحّدة غير مسجّلة — أعد توليدها من شاشة الامتحان',
        stage: 'noMatchingTemplate',
        templateId,
      },
      { status: 404 }
    );
  }
  if (qr && qr.examId !== sheet.examId) {
    return NextResponse.json(
      { error: 'الورقة تنتمي لامتحان آخر', stage: 'templateMismatch' },
      { status: 409 }
    );
  }

  const fingerprint = imageFingerprint(imageBase64);
  const existing = await db.scan.findFirst({
    where: { imageHash: fingerprint, examId: sheet.examId, status: { not: 'FAILED' } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    // Re-upload of the same file: return the stored result instead of
    // creating a second one (idempotent retries after a network hiccup).
    return NextResponse.json({
      scanId: existing.id,
      duplicate: true,
      status: existing.status,
      needsReview: existing.reviewStatus === 'PENDING',
      studentCode: existing.studentCode,
      studentId: existing.studentId,
      grade: safeJson(existing.gradeJson),
      answers: safeJson(existing.answersJson)?.answers ?? [],
      diagnostics: safeJson(existing.diagnosticsJson) ?? {},
      mode: 'fixed',
      message: 'هذه الورقة مُسجّلة مسبقًا — لم تُنشأ نتيجة جديدة',
    });
  }

  const second = await processScan({
    imageBase64,
    template: sheet.template,
    thresholds,
    debug: true,
  });
  if (isTransportError(second)) {
    return NextResponse.json(
      { error: second.error, stage: second.stage, details: second.details ?? null },
      { status: 503 }
    );
  }
  if (!second.ok) {
    const failed = await db.scan.create({
      data: {
        examId: sheet.examId,
        imageHash: fingerprint,
        batchId: opts.batchId ?? null,
        pageIndex: qr?.sheet ?? null,
        status: 'FAILED',
        reviewStatus: 'PENDING',
        answersJson: JSON.stringify({ answers: second.answers ?? [] }),
        diagnosticsJson: JSON.stringify({
          error: second.error,
          engineStage: second.stage,
          templateId: sheet.templateId,
          fixedSheetId: sheet.id,
        }),
      },
    });
    return NextResponse.json(
      {
        scanId: failed.id,
        error: second.error,
        stage: second.stage,
        status: 'FAILED',
        diagnostics: second.diagnostics ?? null,
      },
      { status: 409 }
    );
  }

  const answers: QBScannedAnswer[] = second.answers ?? [];
  const flags: string[] = [];

  // ---- version (never guessed)
  const versionRead = second.version ?? null;
  const versionNumber =
    versionRead?.status === 'selected' && versionRead.value ? versionRead.value : null;
  if (!versionNumber) {
    if (!versionRead || versionRead.status === 'unanswered') flags.push('versionBlank');
    else if (versionRead.status === 'multiple') flags.push('versionMultiple');
    else flags.push('versionUnclear');
  }

  let versionRow: ExamVersion | null = null;
  if (versionNumber) {
    versionRow = await db.examVersion.findUnique({
      where: { examId_version: { examId: sheet.examId, version: versionNumber } },
    });
    if (!versionRow) flags.push('versionNotPublished');
  }

  // ---- identity: the shaded grid is authoritative, the handwritten strip
  // only fills columns the grid left blank. Nothing is inferred from order.
  const idRead = second.handwrittenId ?? null;
  const idGrid = second.idGrid ?? null;
  const merged = mergeIdentity(idGrid, idRead);
  const idDigits = merged.digits;
  const idComplete = merged.complete && idDigits.length > 0;
  const idConfidence = merged.confidence;
  let student: Student | null = null;
  let idConfirmed = false;
  if (idComplete && idConfidence >= ID_AUTO_LINK_CONFIDENCE) {
    student = await db.student.findUnique({ where: { code: idDigits } });
    idConfirmed = Boolean(student);
    if (!student) flags.push('idNotInRoster');
  } else if (idRead) {
    flags.push(idComplete ? 'idLowConfidence' : 'idUnreadable');
  } else {
    flags.push('idMissing');
  }

  // ---- grade with the version's key (server-side, authoritative)
  let grade: QBScanGrade | null = null;
  let versionDoc: QBDocument | null = null;
  if (versionRow) {
    versionDoc = safeJson(versionRow.documentJson) as QBDocument | null;
    const answerKey = (safeJson(versionRow.answerKeyJson) ?? {}) as QBAnswerKey;
    if (versionDoc?.questions?.length) {
      grade = gradeScan({ document: versionDoc, answerKey, answers, overrides: {} });
    }
  }

  if (student) {
    const prior = await db.scan.findFirst({
      where: {
        examId: sheet.examId,
        studentId: student.id,
        status: { not: 'FAILED' },
      },
    });
    if (prior) flags.push('duplicateStudentPage');
  }
  if (second.needsReview) flags.push('noAnswersRead');

  const critical = flags.filter((f) =>
    ['versionBlank', 'versionMultiple', 'versionUnclear', 'versionNotPublished', 'noAnswersRead'].includes(f)
  );
  const needsReview = critical.length > 0 || !idConfirmed;
  const scanStatus = needsReview ? 'REVIEW' : 'PROCESSED';

  const tables = await resolveScanTables(second.tables);

  const scan = await db.scan.create({
    data: {
      examId: sheet.examId,
      examVersionId: versionRow?.id ?? null,
      studentId: student?.id ?? null,
      studentCode: idComplete ? idDigits : null,
      imageHash: fingerprint,
      idempotencyKey: opts.idempotencyKey ?? null,
      batchId: opts.batchId ?? null,
      pageIndex: qr?.sheet ?? null,
      answersJson: JSON.stringify({
        answers,
        handwrittenId: idRead ? { ...idRead, stripImage: undefined } : null,
        version: versionRead,
      }),
      gradeJson: JSON.stringify(grade ?? {}),
      overridesJson: '{}',
      status: scanStatus,
      reviewStatus: needsReview ? 'PENDING' : 'NONE',
      overallConfidence: meanConfidence(answers),
      diagnosticsJson: '{}',
    },
  });

  const debugPath = second.debugImage
    ? decodeImage(stripDataUrl(second.debugImage).base64, scan.id, 'debug')
    : null;
  const correctedPath = second.correctedImage
    ? decodeImage(stripDataUrl(second.correctedImage).base64, scan.id, 'corrected')
    : null;

  const diagnostics = {
    ...(second.diagnostics ?? {}),
    mode: 'fixed',
    fixedSheetId: sheet.id,
    templateId: sheet.templateId,
    revision: sheet.revision,
    identity: {
      digits: merged.digits,
      complete: idComplete,
      confidence: idConfidence,
      source: merged.source,
      positions: merged.positions,
      backend: idRead?.backend ?? null,
      perDigit: idRead?.perDigit ?? [],
      columns: idGrid?.columns ?? [],
      stripImage: idRead?.stripImage ?? null,
      confirmed: idConfirmed,
    },
    versionRead,
    flags,
    ...imagesPayload(scan.id, debugPath, correctedPath),
    tables,
  };
  await db.scan.update({
    where: { id: scan.id },
    data: { diagnosticsJson: JSON.stringify(diagnostics) },
  });

  return NextResponse.json({
    scanId: scan.id,
    mode: 'fixed',
    answers,
    grade,
    diagnostics,
    status: scanStatus,
    needsReview,
    flags,
    overallConfidence: meanConfidence(answers),
    studentCode: idComplete ? idDigits : null,
    studentId: student?.id ?? null,
    identity: {
      digits: merged.digits,
      confidence: idConfidence,
      complete: idComplete,
      confirmed: idConfirmed,
      source: merged.source,
      positions: merged.positions,
      stripImage: idRead?.stripImage ?? null,
      perDigit: idRead?.perDigit ?? [],
      columns: idGrid?.columns ?? [],
      student: student ? { id: student.id, code: student.code, name: student.name } : null,
    },
    versionRead: {
      value: versionNumber,
      letter: versionNumber ? VERSION_LETTERS[versionNumber - 1] ?? null : null,
      status: versionRead?.status ?? 'unanswered',
      confidence: versionRead?.confidence ?? 0,
    },
    tables,
    template: {
      templateId: sheet.templateId,
      examId: sheet.examId,
      revision: sheet.revision,
      sheets: sheet.template.sheets,
      sheet: qr?.sheet ?? 0,
    },
  });
}

/** Per-position merge: grid mark → OCR digit (confident only) → '?'. */
export function mergeIdentity(
  grid: OmrIdGrid | null,
  ocr: OmrHandwrittenId | null
): {
  digits: string;
  complete: boolean;
  confidence: number;
  source: 'grid' | 'ocr' | 'mixed' | 'none';
  positions: Array<{ index: number; digit: string | null; from: 'grid' | 'ocr' | null; confidence: number }>;
} {
  const count = Math.max(grid?.columns?.length ?? 0, ocr?.perDigit?.length ?? 0);
  const positions: Array<{ index: number; digit: string | null; from: 'grid' | 'ocr' | null; confidence: number }> = [];
  for (let i = 0; i < count; i++) {
    const col = grid?.columns?.find((c) => c.index === i) ?? grid?.columns?.[i];
    const ocrDigit = ocr?.perDigit?.find((d) => d.index === i) ?? ocr?.perDigit?.[i];
    if (col && col.value !== null && col.status === 'selected') {
      positions.push({ index: i, digit: String(col.value), from: 'grid', confidence: 1 });
    } else if (ocrDigit?.value && (ocrDigit.confidence ?? 0) >= 0.5) {
      positions.push({
        index: i,
        digit: ocrDigit.value,
        from: 'ocr',
        confidence: ocrDigit.confidence,
      });
    } else {
      positions.push({ index: i, digit: null, from: null, confidence: 0 });
    }
  }
  const digits = positions.map((p) => p.digit ?? '?').join('');
  const complete = count > 0 && positions.every((p) => p.digit !== null);
  const confidence = count
    ? Math.round((positions.reduce((a, p) => a + p.confidence, 0) / count) * 1000) / 1000
    : 0;
  const fromGrid = positions.filter((p) => p.from === 'grid').length;
  const fromOcr = positions.filter((p) => p.from === 'ocr').length;
  const source = fromGrid && fromOcr ? 'mixed' : fromGrid ? 'grid' : fromOcr ? 'ocr' : 'none';
  return { digits, complete, confidence, source, positions };
}

function safeJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
