// PATCH  /api/questions/:id → edit a bank question
// DELETE /api/questions/:id → remove it (exams keep their frozen copies)

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  normalizeCorrectAnswer,
  questionInputSchema,
  statusFor,
  trueFalseOptions,
} from '@/lib/qb/bank';
import { readJsonBody, serverError, zodMessage } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const existing = await db.question.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 });
    }
    const body = await readJsonBody(req);
    const parsed = questionInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: `بيانات السؤال غير صالحة: ${zodMessage(parsed.error)}` }, { status: 400 });
    }
    const input = parsed.data;
    const options = input.type === 'truefalse' ? trueFalseOptions() : input.options;
    const correctAnswer = normalizeCorrectAnswer(input.correctAnswer, options);

    const row = await db.question.update({
      where: { id },
      data: {
        subject: input.subject?.trim() || null,
        chapter: input.chapter?.trim() || null,
        topic: input.topic?.trim() || null,
        type: input.type,
        prompt: input.prompt.trim(),
        optionsJson: JSON.stringify(options),
        correctAnswer,
        explanation: input.explanation?.trim() || null,
        difficulty: input.difficulty,
        marks: input.marks,
        tagsJson: JSON.stringify(input.tags.map((t) => t.trim()).filter(Boolean)),
        status: statusFor({ ...input, correctAnswer }),
      },
    });
    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await db.question.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 });
  }
}
