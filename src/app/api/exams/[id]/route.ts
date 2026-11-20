// GET    /api/exams/:id → exam + draft document + answerKey + versions
// PATCH  /api/exams/:id { title?, subject?, gradeLevel?, document?, answerKey?, omrEnabled? } → saves DRAFT only
// DELETE /api/exams/:id → archive (status=ARCHIVED) — history is never destroyed

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sanitizeAnswerKey, sanitizeDocument } from '@/lib/qb/schema';
import type { QBDocument } from '@/lib/qb/types';
import { readJsonBody, serverError, zodMessage } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function isZodError(err: unknown): boolean {
  return Array.isArray((err as { issues?: unknown })?.issues);
}

function parseDraftDocument(exam: { documentJson: string }): QBDocument | null {
  try {
    return sanitizeDocument(JSON.parse(exam.documentJson));
  } catch {
    return null;
  }
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await db.exam.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }
    const document = parseDraftDocument(exam);
    let answerKey: Record<string, string> = {};
    try {
      answerKey = JSON.parse(exam.answerKeyJson) as Record<string, string>;
    } catch {
      answerKey = {};
    }
    const { versions, ...examRow } = exam;
    return NextResponse.json({
      exam: examRow,
      document,
      answerKey,
      versions: versions.map((v) => ({ id: v.id, version: v.version, publishedAt: v.publishedAt })),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await db.exam.findUnique({ where: { id } });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }
    if (exam.status === 'ARCHIVED') {
      return NextResponse.json(
        { error: 'لا يمكن تعديل امتحان مؤرشف' },
        { status: 409 }
      );
    }

    const body = await readJsonBody(req);
    if (!body) {
      return NextResponse.json({ error: 'جسم الطلب غير صالح (JSON)' }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    let explicitTitle: string | null = null;
    if (typeof body.title === 'string' && body.title.trim()) {
      explicitTitle = body.title.trim();
      data.title = explicitTitle;
    }
    if (typeof body.subject === 'string' || body.subject === null) {
      data.subject = body.subject === null ? null : body.subject.trim();
    }
    if (typeof body.gradeLevel === 'string' || body.gradeLevel === null) {
      data.gradeLevel = body.gradeLevel === null ? null : body.gradeLevel.trim();
    }

    if (body.document !== undefined) {
      const doc = sanitizeDocument(body.document);
      data.documentJson = JSON.stringify(doc);
      // keep list/labels in sync with the canonical document
      if (!explicitTitle && doc.branding.examTitle) data.title = doc.branding.examTitle;
      data.direction = doc.direction;
      // the document's omr.enabled is canonical for the exam-level flag
      if (body.omrEnabled === undefined) data.omrEnabled = doc.omr.enabled;
    }
    if (body.answerKey !== undefined) {
      data.answerKeyJson = JSON.stringify(sanitizeAnswerKey(body.answerKey));
    }
    if (typeof body.omrEnabled === 'boolean') {
      data.omrEnabled = body.omrEnabled;
    }

    // ---- online exam config (PHASE 3, additive) ----
    if (typeof body.onlineEnabled === 'boolean') data.onlineEnabled = body.onlineEnabled;
    if (typeof body.randomizeOrder === 'boolean') data.randomizeOrder = body.randomizeOrder;
    if (body.securityPolicy === 'strict' || body.securityPolicy === 'warning') {
      data.securityPolicy = body.securityPolicy;
    }
    if (typeof body.durationMin === 'number' && Number.isFinite(body.durationMin)) {
      data.durationMin = Math.min(600, Math.max(1, Math.floor(body.durationMin)));
    }
    if (typeof body.attemptsAllowed === 'number' && Number.isFinite(body.attemptsAllowed)) {
      data.attemptsAllowed = Math.min(10, Math.max(1, Math.floor(body.attemptsAllowed)));
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'لا توجد حقول صالحة للتحديث (title/subject/document/answerKey/omrEnabled/online*)' },
        { status: 400 }
      );
    }

    const updated = await db.exam.update({ where: { id }, data });
    return NextResponse.json({
      exam: updated,
      document: parseDraftDocument(updated),
    });
  } catch (err) {
    if (isZodError(err)) {
      return NextResponse.json({ error: `مستند غير صالح: ${zodMessage(err)}` }, { status: 400 });
    }
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await db.exam.findUnique({ where: { id } });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }
    const updated = await db.exam.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
    return NextResponse.json({ exam: updated, archived: true });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
