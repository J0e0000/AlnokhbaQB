// GET /api/versions/:id → full published snapshot { document, answerKey, omrTemplate }

import { NextResponse } from 'next/server';
import { serverError } from '../../_lib/shared';
import { loadVersion } from '../../_lib/version';

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
    const { row, document, answerKey, omrTemplate } = loaded;
    return NextResponse.json({
      id: row.id,
      examId: row.examId,
      version: row.version,
      title: row.title,
      publishedAt: row.publishedAt,
      document,
      answerKey,
      omrTemplate,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
