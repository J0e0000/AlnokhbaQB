// GET /api/scans/:id/images/[image] → serve debug|corrected JPEG from db/scans/
// Security: ONLY the exact two image names are allowed, ids must be CUID-shaped,
// and the resolved path must stay inside db/scans — no traversal, ever.

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { scansDir } from '@/lib/omr/scans-dir';
import { requireSession } from '../../../../_lib/auth-guard';
import { serverError } from '../../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; image: string }> };

// /tmp/alnokhba-scans on Vercel (read-only FS), db/scans locally — both via
// the shared resolver so writer and reader NEVER drift apart.
const SCANS_DIR = scansDir();
const ALLOWED = new Set(['debug', 'corrected']);

export async function GET(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const { id, image } = await ctx.params;

    // strict allowlists — no '..', no separators, exact names only
    if (!ALLOWED.has(image)) {
      return NextResponse.json({ error: 'نوع الصورة غير صالح' }, { status: 400 });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id) || id.includes('..')) {
      return NextResponse.json({ error: 'معرّف غير صالح' }, { status: 400 });
    }

    // org scoping: the image belongs to a scan → its exam decides access
    const scan = await db.scan.findUnique({ where: { id }, select: { examId: true } });
    if (!scan) {
      return NextResponse.json({ error: 'الصورة غير موجودة' }, { status: 404 });
    }
    if (g.session.role !== 'super_admin') {
      if (!scan.examId) {
        return NextResponse.json({ error: 'الصورة غير موجودة' }, { status: 404 });
      }
      const exam = await db.exam.findUnique({
        where: { id: scan.examId },
        select: { organizationId: true },
      });
      if (exam?.organizationId !== g.session.orgId) {
        return NextResponse.json({ error: 'الصورة غير موجودة' }, { status: 404 });
      }
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
