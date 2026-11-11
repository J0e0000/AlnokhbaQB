// GET /api/exams/:id/versions → published version history

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSession } from '../../../_lib/auth-guard';
import { serverError } from '../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const { id } = await ctx.params;
    const exam = await db.exam.findUnique({ where: { id } });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }
    if (g.session.role !== 'super_admin' && exam.organizationId !== g.session.orgId) {
      return NextResponse.json(
        { error: 'غير موجود أو لا تملك صلاحية الوصول' },
        { status: 404 }
      );
    }
    const versions = await db.examVersion.findMany({
      where: { examId: id },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, title: true, publishedAt: true },
    });
    return NextResponse.json(versions);
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
