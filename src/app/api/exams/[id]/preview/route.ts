// GET /api/exams/:id/preview → draft exam HTML (embed mode, for iframe srcDoc)

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sanitizeDocument } from '@/lib/qb/schema';
import { renderExamHtml } from '@/lib/qb/render-exam';
import { serverError } from '../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await db.exam.findUnique({ where: { id } });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }
    let doc;
    try {
      doc = sanitizeDocument(JSON.parse(exam.documentJson));
    } catch (err) {
      return NextResponse.json(
        {
          error: 'مستند الامتحان (المسودة) غير صالح',
          details: err instanceof Error ? err.message : String(err),
        },
        { status: 400 }
      );
    }
    const html = renderExamHtml(doc, { mode: 'embed' });
    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
