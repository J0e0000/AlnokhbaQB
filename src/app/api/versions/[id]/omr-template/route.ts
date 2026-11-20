// GET /api/versions/:id/omr-template → canonical OMRTemplate JSON

import { NextResponse } from 'next/server';
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
