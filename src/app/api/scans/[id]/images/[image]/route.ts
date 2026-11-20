// GET /api/scans/:id/images/[image] → serve debug|corrected JPEG from db/scans/
// Security: ONLY the exact two image names are allowed, ids must be CUID-shaped,
// and the resolved path must stay inside db/scans — no traversal, ever.

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { serverError } from '../../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; image: string }> };

const SCANS_DIR = path.join(process.cwd(), 'db', 'scans');
const ALLOWED = new Set(['debug', 'corrected']);

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id, image } = await ctx.params;

    // strict allowlists — no '..', no separators, exact names only
    if (!ALLOWED.has(image)) {
      return NextResponse.json({ error: 'نوع الصورة غير صالح' }, { status: 400 });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id) || id.includes('..')) {
      return NextResponse.json({ error: 'معرّف غير صالح' }, { status: 400 });
    }

    const filePath = path.join(SCANS_DIR, `${id}_${image}.jpg`);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(SCANS_DIR) + path.sep)) {
      return NextResponse.json({ error: 'مسار غير صالح' }, { status: 400 });
    }
    if (!existsSync(resolved)) {
      return NextResponse.json({ error: 'الصورة غير موجودة' }, { status: 404 });
    }

    const jpeg = readFileSync(resolved);
    return new NextResponse(new Uint8Array(jpeg), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
