// Taxonomy terms (subject/grade/unit/lesson/topic tree, per organisation)
// GET    /api/taxonomy?kind=subject
// POST   /api/taxonomy { kind, name, parentKey? }          (teacher)
// DELETE /api/taxonomy?id=                                  (teacher)

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSession } from '../_lib/auth-guard';
import { serverError, zodMessage, readJsonBody } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = ['subject', 'grade', 'unit', 'lesson', 'topic'] as const;

const postSchema = z.object({
  kind: z.enum(KINDS),
  name: z.string().min(1).max(200),
  parentKey: z.string().max(200).nullable().optional(),
});

export async function GET(req: Request) {
  const g = await requireSession('viewer', req);
  if ('error' in g) return g.error;
  const kind = new URL(req.url).searchParams.get('kind');

  try {
    const terms = await db.taxonomyTerm.findMany({
      where: {
        organizationId: g.session.role === 'super_admin' ? undefined : g.session.orgId,
        ...(kind && (KINDS as readonly string[]).includes(kind) ? { kind } : {}),
      },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return NextResponse.json({ terms });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  const g = await requireSession('teacher', req);
  if ('error' in g) return g.error;
  const body = await readJsonBody(req);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

  try {
    const existing = await db.taxonomyTerm.findFirst({
      where: {
        organizationId: g.session.role === 'super_admin' ? undefined : g.session.orgId,
        kind: parsed.data.kind,
        name: parsed.data.name,
      },
    });
    if (existing) return NextResponse.json(existing);
    const term = await db.taxonomyTerm.create({
      data: {
        organizationId: g.session.role === 'super_admin' ? g.session.orgId : g.session.orgId,
        kind: parsed.data.kind,
        name: parsed.data.name,
        parentKey: parsed.data.parentKey ?? null,
      },
    });
    return NextResponse.json(term, { status: 201 });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const g = await requireSession('teacher', req);
  if ('error' in g) return g.error;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'المعرف مطلوب' }, { status: 400 });

  try {
    const term = await db.taxonomyTerm.findFirst({
      where: { id, ...(g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId }) },
    });
    if (!term) return NextResponse.json({ error: 'غير موجود' }, { status: 404 });
    await db.taxonomyTerm.delete({ where: { id: term.id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
