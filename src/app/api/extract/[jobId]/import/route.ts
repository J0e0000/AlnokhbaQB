// POST /api/extract/[jobId]/import
// body: { ids: string[], defaults?: { subject?, chapter?, topic? } }
// Creates bank Questions from the selected candidates (deduped),
// links them back, and completes the job.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { audit } from '@/lib/auth';
import { requireSession } from '../../../_lib/auth-guard';
import { serverError } from '../../../_lib/shared';
import { normalizeForDuplicate } from '@/lib/qb/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(300),
  defaults: z
    .object({
      subject: z.string().max(200).nullable().optional(),
      chapter: z.string().max(200).nullable().optional(),
      topic: z.string().max(200).nullable().optional(),
    })
    .optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const g = await requireSession('teacher', req);
  if ('error' in g) return g.error;
  const { jobId } = await ctx.params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'حدد سؤالًا واحدًا على الأقل للاستيراد' }, { status: 400 });
  }

  try {
    const job = await db.extractionJob.findFirst({
      where: {
        id: jobId,
        ...(g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId }),
      },
    });
    if (!job) return NextResponse.json({ error: 'مهمة الاستخراج غير موجودة' }, { status: 404 });

    const rows = await db.extractedQuestion.findMany({
      where: { jobId: job.id, id: { in: parsed.data.ids }, status: { not: 'rejected' } },
      orderBy: { order: 'asc' },
    });

    const defaults = parsed.data.defaults ?? {};
    let imported = 0;
    let duplicates = 0;
    const errors: string[] = [];

    // normalized prompts already in the bank (same org) for dedup
    const existing = await db.question.findMany({
      where: g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId },
      select: { prompt: true },
      take: 5000,
    });
    const seen = new Set(existing.map((q) => normalizeForDuplicate(q.prompt)));

    for (const row of rows) {
      const norm = normalizeForDuplicate(row.prompt);
      if (norm && seen.has(norm)) {
        duplicates += 1;
        await db.extractedQuestion.update({
          where: { id: row.id },
          data: { status: 'rejected' },
        });
        continue;
      }
      try {
        const q = await db.question.create({
          data: {
            organizationId: g.session.orgId ?? null,
            subject: defaults.subject ?? null,
            chapter: defaults.chapter ?? null,
            topic: defaults.topic ?? null,
            type: row.type,
            prompt: row.prompt,
            optionsJson: row.optionsJson,
            correctAnswer: row.correctAnswer,
            explanation: row.explanation,
            difficulty: row.difficulty,
            marks: row.marks,
            tagsJson: row.tagsJson,
            source: 'ocr',
            status: 'approved',
          },
        });
        seen.add(norm);
        await db.extractedQuestion.update({
          where: { id: row.id },
          data: { status: 'accepted', questionId: q.id },
        });
        imported += 1;
      } catch (e) {
        errors.push(row.prompt.slice(0, 60));
        console.error('[extract/import] row failed', e);
      }
    }

    const remaining = await db.extractedQuestion.count({
      where: { jobId: job.id, status: { in: ['pending', 'accepted'] } },
    });
    await db.extractionJob.update({
      where: { id: job.id },
      data: { status: remaining === 0 ? 'completed' : 'review', updatedAt: new Date() },
    });

    await audit({
      session: g.session,
      action: 'question.import',
      entity: 'extractionJob',
      entityId: job.id,
      meta: { imported, duplicates },
      req,
    });

    return NextResponse.json({ imported, duplicates, errors });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
