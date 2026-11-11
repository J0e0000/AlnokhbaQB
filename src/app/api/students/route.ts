// GET  /api/students → student list
// POST /api/students { code, name, classroom? } → create (unique code)

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { audit, orgFilter } from '@/lib/auth';
import { requireSession } from '../_lib/auth-guard';
import { readJsonBody, serverError } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const students = await db.student.findMany({
      where: { organizationId: orgFilter(g.session) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return NextResponse.json(students);
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    const body = await readJsonBody(req);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!code || !name) {
      return NextResponse.json(
        { error: 'رقم الطالب (code) والاسم (name) مطلوبان' },
        { status: 400 }
      );
    }
    if (code.length > 20 || name.length > 200) {
      return NextResponse.json({ error: 'القيم طويلة جدًا' }, { status: 400 });
    }
    const classroom =
      typeof body?.classroom === 'string' && body.classroom.trim()
        ? body.classroom.trim()
        : null;

    try {
      const student = await db.student.create({
        data: { organizationId: g.session.orgId ?? null, code, name, classroom },
      });
      await audit({
        session: g.session,
        action: 'student.create',
        entity: 'student',
        entityId: student.id,
        meta: { name: student.name },
        req,
      });
      return NextResponse.json(student, { status: 201 });
    } catch (err) {
      if (
        typeof (err as { code?: string }).code === 'string' &&
        (err as { code?: string }).code === 'P2002'
      ) {
        return NextResponse.json(
          { error: 'رقم الطالب مسجل مسبقًا (code must be unique)' },
          { status: 409 }
        );
      }
      throw err;
    }
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
