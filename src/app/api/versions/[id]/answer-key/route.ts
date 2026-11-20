// PATCH /api/versions/:id/answer-key { answerKey } → update the guide answer
// key of a PUBLISHED ExamVersion in place.
//
// WHY: publishing freezes document + OMR template (printed sheets/QR must stay
// valid), but the grading KEY is data, not print. Before this endpoint a
// teacher who fixed a wrong guide answer after publishing had NO way to apply
// it — scans kept grading against the stale frozen key ("I can't put a guide
// answer for the OMR exam"). The QR/template are untouched, so already-printed
// sheets remain fully scannable; only grading semantics change. Audited.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sanitizeAnswerKey } from '@/lib/qb/schema';
import { keyFingerprint } from '@/lib/qb/key-fingerprint';
import { readJsonBody, serverError, zodMessage } from '../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function isZodError(err: unknown): boolean {
  return Array.isArray((err as { issues?: unknown })?.issues);
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const version = await db.examVersion.findUnique({
      where: { id },
      select: { id: true, examId: true, version: true },
    });
    if (!version) {
      return NextResponse.json({ error: 'نسخة الامتحان غير موجودة' }, { status: 404 });
    }

    const body = await readJsonBody(req);
    if (!body || body.answerKey === undefined || body.answerKey === null || typeof body.answerKey !== 'object') {
      return NextResponse.json({ error: 'مفتاح الإجابة مطلوب (answerKey)' }, { status: 400 });
    }

    const sanitized = sanitizeAnswerKey(body.answerKey);
    const updated = await db.examVersion.update({
      where: { id },
      data: { answerKeyJson: JSON.stringify(sanitized) },
      select: { id: true, version: true },
    });


    return NextResponse.json({
      ok: true,
      id: updated.id,
      version: updated.version,
      answerKeyCount: Object.keys(sanitized).length,
      answerKeyHash: keyFingerprint(sanitized),
    });
  } catch (err) {
    if (isZodError(err)) {
      return NextResponse.json({ error: `مفتاح غير صالح: ${zodMessage(err)}` }, { status: 400 });
    }
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
