// POST /api/questions/duplicate-check { prompt, excludeId? }
// → { duplicates: [{ id, prompt, subject, chapter }] } — Arabic-aware normalization

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession } from '../../_lib/auth-guard';
import { serverError, readJsonBody } from '../../_lib/shared';
import { normalizeForDuplicate } from '@/lib/qb/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  prompt: z.string().min(4).max(5000),
  excludeId: z.string().max(64).nullish(),
});

export async function POST(req: Request) {
  const g = await requireSession('viewer', req);
  if ('error' in g) return g.error;

  const body = await readJsonBody(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ duplicates: [] });

  try {
    const norm = normalizeForDuplicate(parsed.data.prompt);
    if (!norm || norm.length < 6) return NextResponse.json({ duplicates: [] });

    const candidates = await db.question.findMany({
      where: {
        ...(g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId }),
        ...(parsed.data.excludeId ? { id: { not: parsed.data.excludeId } } : {}),
      },
      select: { id: true, prompt: true, subject: true, chapter: true },
      take: 3000,
    });

    const duplicates = candidates
      .filter((c) => normalizeForDuplicate(c.prompt) === norm)
      .slice(0, 5);

    return NextResponse.json({ duplicates });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
