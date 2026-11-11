// GET /api/versions/:id/omr-template → canonical OMRTemplate JSON

import { NextResponse } from 'next/server';
import { serverError } from '../../../_lib/shared';
import { requireSession } from '../../../_lib/auth-guard';
import { loadVersion } from '../../../_lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const { id } = await ctx.params;
    const loaded = await loadVersion(id);
    if (!loaded) {
      return NextResponse.json({ error: 'نسخة الامتحان غير موجودة' }, { status: 404 });
    }
    if (
      g.session.role !== 'super_admin' &&
      loaded.row.exam.organizationId !== g.session.orgId
    ) {
      return NextResponse.json(
        { error: 'غير موجود أو لا تملك صلاحية الوصول' },
        { status: 404 }
      );
    }
    if (!loaded.omrTemplate) {
      return NextResponse.json(
        { error: 'لا توجد ورقة إجابة OMR لهذه النسخة (OMR غير مفعّل)' },
        { status: 404 }
      );
    }
    return NextResponse.json(loaded.omrTemplate);
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
