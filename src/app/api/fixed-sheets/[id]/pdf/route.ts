// GET /api/fixed-sheets/:id/pdf?copies=N → print-ready PDF of the fixed sheet.
// `copies` repeats the sheet block so a class set prints in one go; the QR is
// identical on every copy by design (it names the exam, never a student).

import { NextResponse } from 'next/server';

import { db } from '@/lib/db';
import type { FixedSheetTemplate } from '@/lib/qb/fixed-sheet';
import { renderFixedSheetHtml } from '@/lib/qb/render-fixed-sheet';
import { renderPdf } from '@/lib/pdf/pool';
import { serverError } from '../../../_lib/shared';
import { duplicateOmrSheets, intParam, pdfResponse } from '../../../_lib/version';

export const maxDuration = 60;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const copies = intParam(url.searchParams.get('copies'), 1, 1, 200);
    const row = await db.fixedSheet.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ error: 'الورقة الموحّدة غير موجودة' }, { status: 404 });
    }
    const template = JSON.parse(row.dataJson) as FixedSheetTemplate;
    const html = duplicateOmrSheets(renderFixedSheetHtml(template), copies);
    const pdf = await renderPdf(html, {
      widthMm: template.page.widthMm,
      heightMm: template.page.heightMm,
    });
    return pdfResponse(pdf, `fixed-sheet-${template.templateId}.pdf`);
  } catch (err) {
    return NextResponse.json(
      { ...serverError(err), hint: 'تحقق من مسار Chrome (CHROME_PATH)' },
      { status: 500 }
    );
  }
}
