// GET /api/fixed-sheets/:id/png?sheet=0&dpi=300&copies=1
// Raster of the exam-level fixed sheet — used as a scan fixture and for a
// quick visual check of the printed geometry.

import { NextResponse } from 'next/server';

import { db } from '@/lib/db';
import type { FixedSheetTemplate } from '@/lib/qb/fixed-sheet';
import { renderFixedSheetHtml } from '@/lib/qb/render-fixed-sheet';
import { renderPng } from '@/lib/pdf/pool';
import { serverError } from '../../../_lib/shared';
import { intParam } from '../../../_lib/version';

export const maxDuration = 60;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const dpi = intParam(url.searchParams.get('dpi'), 300, 72, 600);
    const row = await db.fixedSheet.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ error: 'الورقة الموحّدة غير موجودة' }, { status: 404 });
    }
    const template = JSON.parse(row.dataJson) as FixedSheetTemplate;
    const sheet = intParam(
      url.searchParams.get('sheet'),
      0,
      0,
      Math.max(0, template.sheets - 1)
    );
    const png = await renderPng(renderFixedSheetHtml(template), {
      widthMm: template.page.widthMm,
      heightMm: template.page.heightMm,
      dpi,
      clipPage: sheet,
    });
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `inline; filename="fixed-${template.templateId}-p${sheet}.png"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ...serverError(err), hint: 'تحقق من مسار Chrome (CHROME_PATH)' },
      { status: 500 }
    );
  }
}
