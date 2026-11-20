// GET /api/versions/:id/pdf?type=exam|omr&copies=N
//   type=exam → canonical exam PDF (vector text)
//   type=omr  → OMR answer-sheet PDF; copies=N duplicates the sheet set N times

import { NextResponse } from 'next/server';
import { renderOmrHtml } from '@/lib/qb/render-omr';
import { renderExamHtml } from '@/lib/qb/render-exam';
import { renderPdf } from '@/lib/pdf/pool';
import { serverError } from '../../../_lib/shared';
import { duplicateOmrSheets, intParam, loadVersion, pdfResponse } from '../../../_lib/version';

export const maxDuration = 60;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const type = url.searchParams.get('type') === 'omr' ? 'omr' : 'exam';
    const copies = intParam(url.searchParams.get('copies'), 1, 1, 50);

    const loaded = await loadVersion(id);
    if (!loaded) {
      return NextResponse.json({ error: 'نسخة الامتحان غير موجودة' }, { status: 404 });
    }
    const { row, document, omrTemplate } = loaded;

    if (type === 'exam') {
      const html = renderExamHtml(document);
      const pdf = await renderPdf(html, {
        widthMm: document.pageSize.widthMm,
        heightMm: document.pageSize.heightMm,
      });
      return pdfResponse(pdf, `exam-v${row.version}.pdf`);
    }

    // type=omr
    if (!omrTemplate) {
      return NextResponse.json(
        { error: 'لا توجد ورقة إجابة OMR لهذه النسخة (OMR غير مفعّل)' },
        { status: 404 }
      );
    }
    let html = renderOmrHtml(omrTemplate);
    if (copies > 1) {
      html = duplicateOmrSheets(html, copies);
    }
    const pdf = await renderPdf(html, {
      widthMm: omrTemplate.page.widthMm,
      heightMm: omrTemplate.page.heightMm,
    });
    const suffix = copies > 1 ? `-x${copies}` : '';
    return pdfResponse(pdf, `omr-v${row.version}${suffix}.pdf`);
  } catch (err) {
    return NextResponse.json(
      { ...serverError(err), hint: 'تحقق من مسار Chrome (CHROME_PATH) وأن الخادم يستطيع تشغيله' },
      { status: 500 }
    );
  }
}
