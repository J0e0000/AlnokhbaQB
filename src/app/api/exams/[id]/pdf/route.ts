// GET /api/exams/:id/pdf → draft exam PDF (vector text, WYSIWYG with preview)

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sanitizeDocument } from '@/lib/qb/schema';
import { renderExamHtml } from '@/lib/qb/render-exam';
import { renderPdf } from '@/lib/pdf/pool';
import { requireSession } from '../../../_lib/auth-guard';
import { serverError } from '../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// serverless headroom: chromium extraction + first launch + render can exceed the 10s default
export const maxDuration = 60;

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
    const html = renderExamHtml(doc);
    const pdf = await renderPdf(html, {
      widthMm: doc.pageSize.widthMm,
      heightMm: doc.pageSize.heightMm,
    });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="exam-draft-${exam.id}.pdf"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ...serverError(err), hint: 'تحقق من مسار Chrome (CHROME_PATH) وأن الخادم يستطيع تشغيله' },
      { status: 500 }
    );
  }
}
