// GET /api/versions/:id/omr-png?sheet=0 → PNG raster @300dpi (scan-testing fixture)

import { NextResponse } from 'next/server';
import { renderOmrHtml } from '@/lib/qb/render-omr';
import { renderPng } from '@/lib/pdf/pool';
import { serverError } from '../../../_lib/shared';
import { intParam, loadVersion } from '../../../_lib/version';

export const maxDuration = 60;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const dpi = intParam(url.searchParams.get('dpi'), 300, 72, 600);

    const loaded = await loadVersion(id);
    if (!loaded) {
      return NextResponse.json({ error: 'نسخة الامتحان غير موجودة' }, { status: 404 });
    }
    const { omrTemplate } = loaded;
    if (!omrTemplate) {
      return NextResponse.json(
        { error: 'لا توجد ورقة إجابة OMR لهذه النسخة (OMR غير مفعّل)' },
        { status: 404 }
      );
    }
    const sheet = intParam(url.searchParams.get('sheet'), 0, 0, Math.max(0, omrTemplate.sheets - 1));

    const html = renderOmrHtml(omrTemplate);
    const png = await renderPng(html, {
      widthMm: omrTemplate.page.widthMm,
      heightMm: omrTemplate.page.heightMm,
      dpi,
      clipPage: sheet,
    });
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `inline; filename="omr-v${omrTemplate.versionNumber}-sheet${sheet}.png"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ...serverError(err), hint: 'تحقق من مسار Chrome (CHROME_PATH) وأن الخادم يستطيع تشغيله' },
      { status: 500 }
    );
  }
}
