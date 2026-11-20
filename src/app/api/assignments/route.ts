// GET  /api/assignments        → list (with exam title + submission counts + serverNow)
// POST /api/assignments        → create { title, description?, mode, examId?, dueAt, latePolicy? }
// PHASE 5. dueAt is parsed to a server-side Date; graded mode requires a
// PUBLISHED + onlineEnabled exam (same gate as /api/attempts).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readJsonBody, serverError, zodMessage } from '../_lib/shared';
import {
  assignmentCreateSchema,
  parseDueDate,
  publicAssignment,
} from '@/lib/qb/assignments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await db.assignment.findMany({
      orderBy: { createdAt: 'desc' },
      include: { exam: { select: { title: true } }, _count: { select: { submissions: true } } },
      take: 200,
    });
    return NextResponse.json({
      assignments: rows.map(publicAssignment),
      serverNow: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonBody(req);
    const parsed = assignmentCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { title, description, mode, examId, latePolicy } = parsed.data;

    const dueAt = parseDueDate(parsed.data.dueAt);
    if (!dueAt) {
      return NextResponse.json({ error: 'موعد التسليم غير صالح' }, { status: 400 });
    }

    let examIdFinal: string | null = null;
    if (mode === 'graded') {
      if (!examId) {
        return NextResponse.json(
          { error: 'الواجب المصحح آليًا يتطلب اختيار امتحان أونلاين' },
          { status: 400 }
        );
      }
      const exam = await db.exam.findUnique({ where: { id: examId } });
      if (!exam || exam.status !== 'PUBLISHED' || !exam.onlineEnabled) {
        return NextResponse.json(
          { error: 'اختر امتحانًا منشورًا ومفعّلًا أونلاين' },
          { status: 400 }
        );
      }
      examIdFinal = examId;
    }

    const created = await db.assignment.create({
      data: {
        title,
        description,
        mode,
        examId: examIdFinal,
        dueAt,
        latePolicy,
        status: 'open',
      },
      include: { exam: { select: { title: true } }, _count: { select: { submissions: true } } },
    });
    return NextResponse.json({ assignment: publicAssignment(created) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
