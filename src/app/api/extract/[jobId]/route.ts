// GET   /api/extract/[jobId]  → job + candidate questions (review data)
// PATCH /api/extract/[jobId]  → update one candidate (edit fields / accept / reject)

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession } from '../../_lib/auth-guard';
import { serverError, zodMessage } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: z.string().min(1).max(5000).optional(),
  options: z
    .array(z.object({ id: z.string().min(1).max(4), text: z.string().max(2000) }))
    .min(0)
    .max(6)
    .optional(),
  correctAnswer: z.string().max(4).nullable().optional(),
  explanation: z.string().max(5000).nullable().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  marks: z.coerce.number().int().min(1).max(100).optional(),
  type: z.enum(['mcq', 'truefalse', 'short']).optional(),
  status: z.enum(['pending', 'accepted', 'rejected']).optional(),
});

async function loadOwnedJob(jobId: string, session: { role: string; orgId: string | null }) {
  return db.extractionJob.findFirst({
    where: {
      id: jobId,
      ...(session.role === 'super_admin' ? {} : { organizationId: session.orgId }),
    },
    include: {
      document: { select: { id: true, filename: true, pageCount: true, storedPath: true } },
    },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const g = await requireSession('viewer', req);
  if ('error' in g) return g.error;
  const { jobId } = await ctx.params;

  try {
    const job = await loadOwnedJob(jobId, g.session);
    if (!job) return NextResponse.json({ error: 'مهمة الاستخراج غير موجودة' }, { status: 404 });

    const rows = await db.extractedQuestion.findMany({
      where: { jobId: job.id },
      orderBy: [{ page: 'asc' }, { order: 'asc' }],
    });

    return NextResponse.json({
      job: {
        id: job.id,
        status: job.status,
        language: job.language,
        questionCount: job.questionCount,
        error: job.error,
        createdAt: job.createdAt,
        document: job.document,
      },
      questions: rows.map((r) => ({
        id: r.id,
        order: r.order,
        page: r.page,
        type: r.type,
        prompt: r.prompt,
        options: JSON.parse(r.optionsJson || '[]'),
        correctAnswer: r.correctAnswer,
        explanation: r.explanation,
        difficulty: r.difficulty,
        marks: r.marks,
        tags: JSON.parse(r.tagsJson || '[]'),
        confidence: r.confidence,
        status: r.status,
        questionId: r.questionId,
      })),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const g = await requireSession('teacher', req);
  if ('error' in g) return g.error;
  const { jobId } = await ctx.params;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { id, ...fields } = parsed.data;

  try {
    const job = await loadOwnedJob(jobId, g.session);
    if (!job) return NextResponse.json({ error: 'مهمة الاستخراج غير موجودة' }, { status: 404 });

    const row = await db.extractedQuestion.findFirst({ where: { id, jobId: job.id } });
    if (!row) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 });

    const updated = await db.extractedQuestion.update({
      where: { id: row.id },
      data: {
        prompt: fields.prompt ?? undefined,
        optionsJson: fields.options ? JSON.stringify(fields.options) : undefined,
        correctAnswer: fields.correctAnswer !== undefined ? fields.correctAnswer : undefined,
        explanation: fields.explanation !== undefined ? fields.explanation : undefined,
        difficulty: fields.difficulty ?? undefined,
        marks: fields.marks ?? undefined,
        type: fields.type ?? undefined,
        status: fields.status ?? (fields.prompt || fields.options || fields.correctAnswer !== undefined ? 'accepted' : undefined),
      },
    });

    return NextResponse.json({
      question: {
        id: updated.id,
        prompt: updated.prompt,
        options: JSON.parse(updated.optionsJson || '[]'),
        correctAnswer: updated.correctAnswer,
        explanation: updated.explanation,
        difficulty: updated.difficulty,
        marks: updated.marks,
        confidence: updated.confidence,
        status: updated.status,
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
