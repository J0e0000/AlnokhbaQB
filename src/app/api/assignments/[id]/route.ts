// GET    /api/assignments/:id  → detail + submissions + serverNow (teacher view)
// PATCH  /api/assignments/:id  → { title?, description?, dueAt?, latePolicy?, status? }
// DELETE /api/assignments/:id  → delete (submissions cascade)
// PHASE 5. Every read returns serverNow so clients can display deadlines
// without trusting their own clock; enforcement always happens server-side.

import { unlinkSync } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readJsonBody, serverError } from '../../_lib/shared';
import { parseDueDate, publicAssignment, publicSubmission } from '@/lib/qb/assignments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const a = await db.assignment.findUnique({
      where: { id },
      include: {
        exam: { select: { title: true } },
        submissions: { orderBy: { submittedAt: 'desc' }, take: 500 },
      },
    });
    if (!a) {
      return NextResponse.json({ error: 'الواجب غير موجود' }, { status: 404 });
    }
    return NextResponse.json({
      assignment: publicAssignment({ ...a, _count: { submissions: a.submissions.length } }),
      submissions: a.submissions.map(publicSubmission),
      serverNow: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJsonBody(req);
    if (!body) {
      return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
    }

    const existing = await db.assignment.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'الواجب غير موجود' }, { status: 404 });
    }

    const data: {
      title?: string;
      description?: string;
      dueAt?: Date;
      latePolicy?: string;
      status?: string;
    } = {};

    if (typeof body.title === 'string' && body.title.trim().length >= 2) {
      data.title = body.title.trim().slice(0, 200);
    }
    if (typeof body.description === 'string') {
      data.description = body.description.trim().slice(0, 4000);
    }
    if (body.dueAt !== undefined) {
      const dueAt = parseDueDate(body.dueAt);
      if (!dueAt) {
        return NextResponse.json({ error: 'موعد التسليم غير صالح' }, { status: 400 });
      }
      data.dueAt = dueAt;
    }
    if (body.latePolicy === 'allow' || body.latePolicy === 'block') {
      data.latePolicy = body.latePolicy;
    }
    if (body.status === 'open' || body.status === 'closed') {
      data.status = body.status;
    }

    const updated = await db.assignment.update({
      where: { id },
      data,
      include: { exam: { select: { title: true } }, _count: { select: { submissions: true } } },
    });
    return NextResponse.json({ assignment: publicAssignment(updated) });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const existing = await db.assignment.findUnique({
      where: { id },
      include: { submissions: { select: { filePath: true } } },
    });
    if (!existing) {
      return NextResponse.json({ error: 'الواجب غير موجود' }, { status: 404 });
    }
    await db.assignment.delete({ where: { id } });
    // best-effort disk cleanup (DB cascade removes the rows; files follow)
    for (const s of existing.submissions) {
      if (!s.filePath) continue;
      try {
        const p = path.resolve(process.cwd(), s.filePath);
        if (p.startsWith(path.join(process.cwd(), 'db', 'assignments') + path.sep)) {
          unlinkSync(p);
        }
      } catch {
        /* file already gone — fine */
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
