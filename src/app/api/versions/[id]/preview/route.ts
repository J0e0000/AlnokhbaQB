// GET /api/versions/:id/preview → published exam HTML (embed mode, iframe srcDoc)

import { NextResponse } from 'next/server';
import { renderExamHtml } from '@/lib/qb/render-exam';
import { serverError } from '../../../_lib/shared';
import { loadVersion } from '../../../_lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const loaded = await loadVersion(id);
    if (!loaded) {
      return NextResponse.json({ error: 'نسخة الامتحان غير موجودة' }, { status: 404 });
    }
    const html = renderExamHtml(loaded.document, { mode: 'embed' });
    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
