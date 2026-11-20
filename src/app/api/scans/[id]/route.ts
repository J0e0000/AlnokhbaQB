// GET   /api/scans/:id → full scan detail (answers, grade, diagnostics + image URLs)
// PATCH /api/scans/:id { overrides: { "3": "B" } } → applyOverrides → regrade → status=REVIEWED

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { applyOverrides, gradeScan } from '@/lib/qb/grading';
import { sanitizeAnswerKey, sanitizeDocument } from '@/lib/qb/schema';
import type { QBAnswerKey, QBDocument, QBScannedAnswer } from '@/lib/qb/types';
import { readJsonBody, serverError } from '../../_lib/shared';
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

function imageUrlFor(scanId: string, diagnostics: Record<string, unknown>, key: 'debugImagePath' | 'correctedImagePath') {
  const p = diagnostics[key];
  if (typeof p !== 'string' || !p) return null;
  const kind = key === 'debugImagePath' ? 'debug' : 'corrected';
  return `/api/scans/${scanId}/images/${kind}`;
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
    const { id } = await ctx.params;
    const scan = await db.scan.findUnique({ where: { id } });
    if (!scan) {
      return NextResponse.json({ error: 'الورقة الممسوحة غير موجودة' }, { status: 404 });
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
    const overrides = body?.overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return NextResponse.json(
        { error: 'يجب إرسال التصحيحات بصيغة overrides: { "رقم السؤال": "الخيار" }' },
        { status: 400 }
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
      },
    });

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      grade,
      overrides: cleanOverrides,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
