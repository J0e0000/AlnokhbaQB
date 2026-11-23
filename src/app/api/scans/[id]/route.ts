// GET   /api/scans/:id → full scan detail (answers, grade, diagnostics + image URLs)
// PATCH /api/scans/:id { reviewStatus?, studentCode?, overrides? } → teacher review:
//   - reviewStatus APPROVED/REJECTED  → queue decision recorded on the sheet
//   - studentCode "204021"            → link (or re-link) the sheet to a Student
//   - overrides { "3": "B" }          → applyOverrides → regrade → status=REVIEWED
// All three are optional and composable (e.g. approve with identity fix only).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { applyOverrides, gradeScan } from '@/lib/qb/grading';
import { sanitizeAnswerKey, sanitizeDocument } from '@/lib/qb/schema';
import type { QBAnswerKey, QBDocument, QBScannedAnswer } from '@/lib/qb/types';
import { readJsonBody, serverError } from '../../_lib/shared';
import { sheetImageUrl } from '../../_lib/scan-images';
import { loadVersion } from '../../_lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function parseScanJson(scan: {
  answersJson: string;
  gradeJson: string;
  overridesJson: string;
  diagnosticsJson: string;
}): { answers: QBScannedAnswer[]; studentIdRaw: unknown; grade: Record<string, unknown>; overrides: Record<string, string>; diagnostics: Record<string, unknown> } {
  let answers: QBScannedAnswer[] = [];
  let studentIdRaw: unknown = null;
  try {
    const parsed = JSON.parse(scan.answersJson) as { answers?: QBScannedAnswer[]; studentId?: unknown };
    answers = Array.isArray(parsed.answers) ? parsed.answers : [];
    studentIdRaw = parsed.studentId ?? null;
  } catch {
    answers = [];
  }
  const safe = <T>(json: string, fallback: T): T => {
    try {
      return JSON.parse(json) as T;
    } catch {
      return fallback;
    }
  };
  return {
    answers,
    studentIdRaw,
    grade: safe<Record<string, unknown>>(scan.gradeJson, {}),
    overrides: safe<Record<string, string>>(scan.overridesJson, {}),
    diagnostics: safe<Record<string, unknown>>(scan.diagnosticsJson, {}),
  };
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const scan = await db.scan.findUnique({ where: { id } });
    if (!scan) {
      return NextResponse.json({ error: 'الورقة الممسوحة غير موجودة' }, { status: 404 });
    }
    const { answers, studentIdRaw, grade, overrides, diagnostics } = parseScanJson(scan);
    return NextResponse.json({
      id: scan.id,
      examId: scan.examId,
      examVersionId: scan.examVersionId,
      studentCode: scan.studentCode,
      studentId: scan.studentId,
      status: scan.status,
      overallConfidence: scan.overallConfidence,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
      answers,
      studentIdRaw,
      grade,
      overrides,
      diagnostics: {
        ...diagnostics,
        debugImage: sheetImageUrl(scan.id, diagnostics, 'debug'),
        correctedImage: sheetImageUrl(scan.id, diagnostics, 'corrected'),
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const scan = await db.scan.findUnique({ where: { id } });
    if (!scan) {
      return NextResponse.json({ error: 'الورقة الممسوحة غير موجودة' }, { status: 404 });
    }

    const body = await readJsonBody(req);
    const overrides = body?.overrides;
    const reviewStatus = typeof body?.reviewStatus === 'string' ? body.reviewStatus : undefined;
    const studentCode = typeof body?.studentCode === 'string' ? body.studentCode.trim() : undefined;

    if (reviewStatus && !['APPROVED', 'REJECTED', 'PENDING'].includes(reviewStatus)) {
      return NextResponse.json(
        { error: 'حالة المراجعة يجب أن تكون APPROVED أو REJECTED أو PENDING' },
        { status: 400 }
      );
    }
    if (studentCode !== undefined && !/^\d{1,12}$/.test(studentCode)) {
      return NextResponse.json(
        { error: 'رقم الطالب يجب أن يكون أرقامًا فقط (حتى 12 رقمًا)' },
        { status: 400 }
      );
    }
    if (
      !reviewStatus &&
      studentCode === undefined &&
      (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides as Record<string, unknown>).length === 0)
    ) {
      return NextResponse.json(
        { error: 'أرسل reviewStatus أو studentCode أو overrides — لا يوجد شيء لتحديثه' },
        { status: 400 }
      );
    }

    // identity link — sheet code → Student record (may not exist yet; the code
    // is still stored so results can be matched later when the student is added)
    let studentId: string | null | undefined;
    if (studentCode !== undefined) {
      const student = await db.student.findUnique({ where: { code: studentCode } });
      studentId = student ? student.id : null;
    }

    // answer fixes — needs the linked exam version to regrade
    let regraded: { answersJson: string; gradeJson: string; overridesJson: string } | null = null;
    if (overrides && typeof overrides === 'object' && !Array.isArray(overrides) && Object.keys(overrides as Record<string, unknown>).length > 0) {
      if (!scan.examVersionId) {
        return NextResponse.json(
          { error: 'لا يمكن إعادة تصحيح ورقة غير مرتبطة بنسخة امتحان' },
          { status: 400 }
        );
      }
      const loaded = await loadVersion(scan.examVersionId);
      if (!loaded) {
        return NextResponse.json(
          { error: 'نسخة الامتحان المرتبطة بهذه الورقة غير موجودة' },
          { status: 404 }
        );
      }
      const entries = Object.entries(overrides as Record<string, unknown>);
      if (entries.length > 500) {
        return NextResponse.json({ error: 'عدد التصحيحات كبير جدًا' }, { status: 400 });
      }
      const cleanOverrides: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (!/^\d+$/.test(k) || typeof v !== 'string' || !/^[A-Za-z0-9]{1,4}$/.test(v)) {
          return NextResponse.json(
            { error: `تصحيح غير صالح: ${k} → يجب أن يكون رقم سؤال وحرف خيار (مثل "3": "B")` },
            { status: 400 }
          );
        }
        cleanOverrides[k] = v;
      }

      const { answers, studentIdRaw } = parseScanJson(scan);
      const document: QBDocument = sanitizeDocument(JSON.parse(loaded.row.documentJson));
      let answerKey: QBAnswerKey;
      try {
        answerKey = sanitizeAnswerKey(JSON.parse(loaded.row.answerKeyJson));
      } catch {
        answerKey = {};
      }

      const adjusted = applyOverrides(answers, cleanOverrides);
      const grade = gradeScan({
        document,
        answerKey,
        answers: adjusted,
        overrides: cleanOverrides,
      });
      regraded = {
        answersJson: JSON.stringify({ answers: adjusted, studentId: studentIdRaw }),
        gradeJson: JSON.stringify(grade),
        overridesJson: JSON.stringify(cleanOverrides),
      };
    }

    const updated = await db.scan.update({
      where: { id: scan.id },
      data: {
        ...(regraded ?? {}),
        ...(reviewStatus ? { reviewStatus } : {}),
        ...(studentCode !== undefined ? { studentCode, studentId: studentId ?? null } : {}),
        // an approved sheet without answer fixes still leaves the queue
        ...(reviewStatus === 'APPROVED' && !regraded && scan.status === 'PROCESSED'
          ? { status: 'REVIEWED' }
          : {}),
      },
    });

    let grade: Record<string, unknown> | null = null;
    if (regraded) {
      try {
        grade = JSON.parse(regraded.gradeJson) as Record<string, unknown>;
      } catch {
        grade = null;
      }
    }

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      reviewStatus: updated.reviewStatus,
      studentCode: updated.studentCode,
      studentId: updated.studentId,
      grade,
      overrides: regraded?.overridesJson ? JSON.parse(regraded.overridesJson) : undefined,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
