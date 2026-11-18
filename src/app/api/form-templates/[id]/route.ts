// FormScan template — read / update / delete by id.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSession } from '../../_lib/auth-guard';
import { serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const { id } = await ctx.params;
    const row = await db.formTemplate.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'القالب غير موجود' }, { status: 404 });
    let data: unknown;
    try {
      data = JSON.parse(row.dataJson);
    } catch {
      return NextResponse.json({ error: 'بيانات القالب تالفة' }, { status: 500 });
    }
    return NextResponse.json({ id: row.id, name: row.name, updatedAt: row.updatedAt, data });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.areas)) {
      return NextResponse.json({ error: 'قالب غير صالح' }, { status: 400 });
    }
    const name = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 120) || 'Untitled form';
    const dataJson = JSON.stringify(body);
    if (dataJson.length > 400_000) {
      return NextResponse.json({ error: 'القالب كبير جدًا' }, { status: 413 });
    }
    const row = await db.formTemplate.update({ where: { id }, data: { name, dataJson } });
    return NextResponse.json({ id: row.id, name: row.name, updatedAt: row.updatedAt });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    const { id } = await ctx.params;
    await db.formTemplate.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
