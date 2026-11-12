// GET   /api/scans/:id → full scan detail (answers, grade, diagnostics + image URLs)
// PATCH /api/scans/:id { overrides?, studentCode?, reviewStatus? }
//   → applyOverrides → regrade / link student identity / review decision.
//   Every correction is audited; reviewStatus: APPROVED | REJECTED.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { audit, type SessionUser } from '@/lib/auth';
import { applyOverrides, gradeScan } from '@/lib/qb/grading';
import { sanitizeAnswerKey, sanitizeDocument } from '@/lib/qb/schema';
import type { QBAnswerKey, QBDocument, QBScannedAnswer } from '@/lib/qb/types';
import { requireSession } from '../../_lib/auth-guard';
import { readJsonBody, serverError } from '../../_lib/shared';
import { loadVersion } from '../../_lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Org ownership of a scan: via its exam (unlinked scans are visible to super only). */
async function canAccessScan(session: SessionUser, examId: string | null): Promise<boolean> {
  if (session.role === 'super_admin') return true;
  if (!examId) return false;
  const exam = await db.exam.findUnique({
    where: { id: examId },
    select: { organizationId: true },
  });
  return exam?.organizationId === session.orgId;
}

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

function imageUrlFor(scanId: string, diagnostics: Record<string, unknown>, key: 'debugImagePath' | 'correctedImagePath') {
  const p = diagnostics[key];
  if (typeof p !== 'string' || !p) return null;
  const kind = key === 'debugImagePath' ? 'debug' : 'corrected';
  return `/api/scans/${scanId}/images/${kind}`;
}

export async function GET(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const { id } = await ctx.params;
    const scan = await db.scan.findUnique({ where: { id } });
    if (!scan) {
      return NextResponse.json({ error: 'الورقة الممسوحة غير موجودة' }, { status: 404 });
    }
    if (!(await canAccessScan(g.session, scan.examId))) {
      return NextResponse.json(
        { error: 'غير موجود أو لا تملك صلاحية الوصول' },
        { status: 404 }
      );
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
        debugImage: imageUrlFor(scan.id, diagnostics, 'debugImagePath'),
        correctedImage: imageUrlFor(scan.id, diagnostics, 'correctedImagePath'),
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    const { id } = await ctx.params;
    const scan = await db.scan.findUnique({ where: { id } });
    if (!scan) {
      return NextResponse.json({ error: 'الورقة الممسوحة غير موجودة' }, { status: 404 });
    }
    if (!(await canAccessScan(g.session, scan.examId))) {
      return NextResponse.json(
        { error: 'غير موجود أو لا تملك صلاحية الوصول' },
        { status: 404 }
      );
    }
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

    const body = await readJsonBody(req);

    // ---- identity correction: link this scan to a student manually
    let studentCodeUpdate: { studentCode: string; studentId: string | null } | undefined;
    if (body && 'studentCode' in body) {
      const sc = body.studentCode;
      if (sc !== null && (typeof sc !== 'string' || !/^\d{1,12}$/.test(sc.trim()))) {
        return NextResponse.json(
          { error: 'رقم الطالب يجب أن يكون أرقامًا فقط (حتى 12 رقمًا)' },
          { status: 400 }
        );
      }
      if (sc === null) {
        studentCodeUpdate = { studentCode: '', studentId: null }; // unlink (normalized below)
      } else {
        const trimmed = (sc as string).trim();
        const student = await db.student.findUnique({ where: { code: trimmed } });
        if (!student) {
          return NextResponse.json(
            { error: `لا يوجد طالب بالرقم ${trimmed} — لا يمكن ربط الورقة بهوية غير موجودة` },
            { status: 404 }
          );
        }
        studentCodeUpdate = { studentCode: trimmed, studentId: student.id };
      }
    }

    // ---- review decision
    const reviewStatusRaw = body?.reviewStatus;
    let reviewStatusUpdate: string | undefined;
    if (typeof reviewStatusRaw === 'string') {
      if (!['APPROVED', 'REJECTED', 'PENDING', 'NONE'].includes(reviewStatusRaw)) {
        return NextResponse.json(
          { error: 'حالة المراجعة غير صالحة (APPROVED | REJECTED | PENDING | NONE)' },
          { status: 400 }
        );
      }
      reviewStatusUpdate = reviewStatusRaw;
    }

    const overrides = body?.overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      // no overrides — identity/review-only update path
      if (!studentCodeUpdate && !reviewStatusUpdate) {
        return NextResponse.json(
          { error: 'أرسل overrides أو studentCode أو reviewStatus' },
          { status: 400 }
        );
      }
      const updated = await db.scan.update({
        where: { id: scan.id },
        data: {
          ...(studentCodeUpdate
            ? {
                studentCode: studentCodeUpdate.studentCode === '' ? null : studentCodeUpdate.studentCode,
                studentId: studentCodeUpdate.studentId,
              }
            : {}),
          ...(reviewStatusUpdate ? { reviewStatus: reviewStatusUpdate } : {}),
          ...(reviewStatusUpdate === 'APPROVED' ? { status: 'REVIEWED' } : {}),
        },
      });
      await audit({
        session: g.session,
        action: 'scan.review',
        entity: 'scan',
        entityId: scan.id,
        meta: {
          studentLinked: studentCodeUpdate?.studentCode ?? null,
          reviewStatus: reviewStatusUpdate ?? null,
        },
        req,
      });
      return NextResponse.json({
        id: updated.id,
        status: updated.status,
        reviewStatus: updated.reviewStatus,
        studentCode: updated.studentCode,
        studentId: updated.studentId,
      });
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

    // parse stored state
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

    const updated = await db.scan.update({
      where: { id: scan.id },
      data: {
        answersJson: JSON.stringify({ answers: adjusted, studentId: studentIdRaw }),
        gradeJson: JSON.stringify(grade),
        overridesJson: JSON.stringify(cleanOverrides),
        status: 'REVIEWED',
        // explicit teacher review of answers clears the pending flag
        ...(reviewStatusUpdate ? { reviewStatus: reviewStatusUpdate } : { reviewStatus: 'APPROVED' }),
        ...(studentCodeUpdate
          ? {
              studentCode: studentCodeUpdate.studentCode === '' ? null : studentCodeUpdate.studentCode,
              studentId: studentCodeUpdate.studentId,
            }
          : {}),
      },
    });

    await audit({
      session: g.session,
      action: 'scan.review',
      entity: 'scan',
      entityId: scan.id,
      meta: { overrides: Object.keys(cleanOverrides).length },
      req,
    });

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      reviewStatus: updated.reviewStatus,
      studentCode: updated.studentCode,
      studentId: updated.studentId,
      grade,
      overrides: cleanOverrides,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
