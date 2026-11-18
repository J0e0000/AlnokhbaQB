// FormScan templates — list + create. Authenticated via the QB session.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { orgFilter } from '@/lib/auth';
import { requireSession } from '../_lib/auth-guard';
import { serverError } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const rows = await db.formTemplate.findMany({
      where: { name: { not: '' } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: { id: true, name: true, updatedAt: true },
    });
    return NextResponse.json(rows);
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    const body = (await req.json().catch(() => null)) as
      | { name?: string; areas?: unknown; markers?: unknown; threshold?: unknown; lenient?: unknown; key?: unknown; weights?: unknown; negative?: unknown; refWidth?: unknown; refHeight?: unknown }
      | null;
    if (!body || !Array.isArray(body.areas)) {
      return NextResponse.json({ error: 'قالب غير صالح — الحقل areas مطلوب' }, { status: 400 });
    }
    const name = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 120) || 'Untitled form';
    // Size guard: templates are small JSON documents.
    const dataJson = JSON.stringify(body);
    if (dataJson.length > 400_000) {
      return NextResponse.json({ error: 'القالب كبير جدًا' }, { status: 413 });
    }
    const row = await db.formTemplate.create({
      data: { name, dataJson },
    });
    void orgFilter(g.session);
    return NextResponse.json({ id: row.id, name: row.name, updatedAt: row.updatedAt }, { status: 201 });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
