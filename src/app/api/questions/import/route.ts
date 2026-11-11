// POST /api/questions/import { items: [...] } → bulk import (deduped, validated)
// Accepts the same shape as /api/questions/export (json) and simplified CSV-mapped rows.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { audit } from '@/lib/auth';
import { requireSession } from '../../_lib/auth-guard';
import { serverError, readJsonBody } from '../../_lib/shared';
import { QUESTION_TYPES, DIFFICULTIES } from '@/lib/qb/bank';
import { normalizeForDuplicate } from '@/lib/qb/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const itemSchema = z.object({
  subject: z.string().max(200).nullish(),
  chapter: z.string().max(200).nullish(),
  topic: z.string().max(200).nullish(),
  type: z.enum(QUESTION_TYPES).catch('mcq'),
  prompt: z.string().min(1).max(5000),
  options: z
    .array(z.object({ id: z.string().min(1).max(4), text: z.string().max(2000) }))
    .max(6)
    .default([]),
  correctAnswer: z.string().max(4).nullish(),
  explanation: z.string().max(5000).nullish(),
  difficulty: z.enum(DIFFICULTIES).catch('medium'),
  marks: z.coerce.number().int().min(1).max(100).catch(1),
  tags: z.array(z.string().max(60)).max(12).default([]),
});

const bodySchema = z.object({ items: z.array(itemSchema).min(1).max(500) });

export async function POST(req: Request) {
  const g = await requireSession('teacher', req);
  if ('error' in g) return g.error;

  const body = await readJsonBody(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'صيغة غير صالحة — أرسل { items: [...] } بنفس صيغة التصدير (٥٠٠ سؤال كحد أقصى)' },
      { status: 400 }
    );
  }

  try {
    const existing = await db.question.findMany({
      where: g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId },
      select: { prompt: true },
      take: 5000,
    });
    const seen = new Set(existing.map((q) => normalizeForDuplicate(q.prompt)));

    let imported = 0;
    let duplicates = 0;
    const errors: string[] = [];

    for (const [i, item] of parsed.data.items.entries()) {
      try {
        const norm = normalizeForDuplicate(item.prompt);
        if (norm && seen.has(norm)) {
          duplicates += 1;
          continue;
        }
        await db.question.create({
          data: {
            organizationId: g.session.orgId ?? null,
            subject: item.subject ?? null,
            chapter: item.chapter ?? null,
            topic: item.topic ?? null,
            type: item.type,
            prompt: item.prompt,
            optionsJson: JSON.stringify(item.options),
            correctAnswer: item.correctAnswer ?? null,
            explanation: item.explanation ?? null,
            difficulty: item.difficulty,
            marks: item.marks,
            tagsJson: JSON.stringify(item.tags),
            source: 'import',
            status: 'approved',
          },
        });
        seen.add(norm);
        imported += 1;
      } catch (e) {
        errors.push(`عنصر ${i + 1}: ${e instanceof Error ? e.message : 'فشل'}`);
      }
    }

    await audit({
      session: g.session,
      action: 'question.import',
      entity: 'question',
      meta: { imported, duplicates, errors: errors.length },
      req,
    });

    return NextResponse.json({ imported, duplicates, errors });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
