// Exam sittings registry (كود الجلوس) — one-time numeric codes per seat.
// GET    /api/exams/:id/sittings        → sittings list + summary
// POST   /api/exams/:id/sittings { seatFrom?, seatTo?, digits? } → generate
//        seats (existing seats keep their code unless regenerate)
// PATCH  /api/exams/:id/sittings { id, studentName?, studentCode?, status? }
// DELETE /api/exams/:id/sittings?scope=all|unused|invalid → clear registry
//
// Codes are digits-only (fillable in the OMR ID bubbles) and unique across the
// whole database so a code can never collide with another exam's sitting.

import { randomInt } from 'crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readJsonBody, serverError, zodMessage } from '../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const NOT_OWNED = { error: 'غير موجود أو لا تملك صلاحية الوصول' } as const;

const MAX_SEATS = 500;
const MAX_DIGITS = 7;
const MIN_DIGITS = 4;

/** Generate one unused numeric code with a given digit count. */
function randomCode(digits: number): string {
  const lo = 10 ** (digits - 1);
  return String(randomInt(lo, lo * 10));
}

/** The exam must exist; access control is the proxy gate (shared password). */
async function ownedExam(examId: string) {
  return db.exam.findUnique({
    where: { id: examId },
    select: { id: true, title: true },
  });
}

/** Digit count: explicit digits win; otherwise a sane default (6). */
function clampDigits(digits: unknown): number {
  const n = Math.round(Number(digits));
  if (!Number.isFinite(n)) return 6;
  return Math.max(MIN_DIGITS, Math.min(MAX_DIGITS, n));
}

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await ownedExam(id);
    if (!exam) return NextResponse.json(NOT_OWNED, { status: 404 });

    const sittings = await db.examSitting.findMany({
      where: { examId: id },
      orderBy: { seatNumber: 'asc' },
    });
    return NextResponse.json({
      examId: id,
      examTitle: exam.title,
      sittings,
      summary: {
        total: sittings.length,
        used: sittings.filter((s) => s.status === 'used').length,
        unused: sittings.filter((s) => s.status === 'unused').length,
        invalidated: sittings.filter((s) => s.status === 'invalidated').length,
        assigned: sittings.filter((s) => s.studentName || s.studentCode).length,
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await ownedExam(id);
    if (!exam) return NextResponse.json(NOT_OWNED, { status: 404 });

    const body = (await readJsonBody(req)) ?? {};
    const seatFrom = Math.max(1, Math.round(Number(body?.seatFrom) || 1));
    const seatToRaw = Math.round(Number(body?.seatTo) || seatFrom + 39);
    const seatTo = Math.max(seatFrom, seatToRaw);
    if (seatTo - seatFrom + 1 > MAX_SEATS) {
      return NextResponse.json(
        { error: `الحد الأقصى ${MAX_SEATS} مقعد في المرة الواحدة` },
        { status: 400 }
      );
    }
    const digits = clampDigits(body?.digits);
    const regenerate = body?.regenerate === true;

    // seats that already have a sitting keep their code unless regenerate
    const existing = await db.examSitting.findMany({
      where: { examId: id, seatNumber: { gte: seatFrom, lte: seatTo } },
      select: { seatNumber: true, status: true },
    });
    const keep = new Set(
      regenerate
        ? existing.filter((s) => s.status === 'used').map((s) => s.seatNumber)
        : existing.map((s) => s.seatNumber)
    );
    if (regenerate) {
      // wipe unused sittings inside the range so they can be re-issued
      await db.examSitting.deleteMany({
        where: {
          examId: id,
          seatNumber: { gte: seatFrom, lte: seatTo },
          status: { not: 'used' },
        },
      });
    }

    const existingCodes = new Set(
      (
        await db.examSitting.findMany({ select: { code: true } })
      ).map((s) => s.code)
    );

    const seatsToCreate: number[] = [];
    for (let seat = seatFrom; seat <= seatTo; seat++) {
      if (!keep.has(seat)) seatsToCreate.push(seat);
    }

    const lo = 10 ** (digits - 1);
    const hi = lo * 10;
    const maxCodes = hi - lo;
    if (seatsToCreate.length > maxCodes) {
      return NextResponse.json(
        {
          error: `عدد المقاعد أكبر من عدد الأكواد الممكنة بـ ${digits} خانات — زد عدد الخانات`,
        },
        { status: 400 }
      );
    }

    let created = 0;
    for (const seat of seatsToCreate) {
      let code = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        const candidate = randomCode(digits);
        if (existingCodes.has(candidate)) continue;
        existingCodes.add(candidate);
        code = candidate;
        break;
      }
      if (!code) {
        return NextResponse.json(
          { error: 'تعذر توليد أكواد فريدة — أعد المحاولة أو زد عدد الخانات' },
          { status: 409 }
        );
      }
      try {
        await db.examSitting.create({
          data: { examId: id, code, seatNumber: seat },
        });
        created++;
      } catch {
        // rare unique race → skip this seat, keep the batch going
      }
    }

    const sittings = await db.examSitting.findMany({
      where: { examId: id },
      orderBy: { seatNumber: 'asc' },
    });

    return NextResponse.json({
      examId: id,
      created,
      kept: keep.size,
      digits,
      sittings,
    });
  } catch (err) {
    const msg = zodMessage(err);
    if (msg) return NextResponse.json({ error: msg }, { status: 400 });
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

/** Assign a real student to a sitting, or invalidate/free one sitting. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await ownedExam(id);
    if (!exam) return NextResponse.json(NOT_OWNED, { status: 404 });

    const body = (await readJsonBody(req)) ?? {};
    const sittingId = typeof body?.id === 'string' ? body.id : '';
    if (!sittingId) {
      return NextResponse.json({ error: 'معرّف الجلوس مطلوب' }, { status: 400 });
    }
    const sitting = await db.examSitting.findUnique({ where: { id: sittingId } });
    if (!sitting || sitting.examId !== id) {
      return NextResponse.json({ error: 'الجلوس غير موجود' }, { status: 404 });
    }

    const data: {
      studentName?: string | null;
      studentCode?: string | null;
      status?: string;
    } = {};
    if (body?.studentName !== undefined) {
      const name = String(body.studentName ?? '').trim().slice(0, 120);
      data.studentName = name || null;
    }
    if (body?.studentCode !== undefined) {
      const code = String(body.studentCode ?? '').trim().slice(0, 40);
      data.studentCode = code || null;
    }
    if (typeof body?.status === 'string' && ['unused', 'used', 'invalidated'].includes(body.status)) {
      data.status = body.status;
    }
    if (!Object.keys(data).length) {
      return NextResponse.json({ error: 'لا توجد تغييرات' }, { status: 400 });
    }

    const updated = await db.examSitting.update({
      where: { id: sittingId },
      data,
    });
    return NextResponse.json({ sitting: updated });
  } catch (err) {
    const msg = zodMessage(err);
    if (msg) return NextResponse.json({ error: msg }, { status: 400 });
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await ownedExam(id);
    if (!exam) return NextResponse.json(NOT_OWNED, { status: 404 });

    const url = new URL(req.url);
    const scope = url.searchParams.get('scope') ?? 'unused';
    if (scope === 'all') {
      const res = await db.examSitting.deleteMany({ where: { examId: id } });
      return NextResponse.json({ deleted: res.count });
    }
    if (scope === 'invalid') {
      const res = await db.examSitting.deleteMany({
        where: { examId: id, status: 'invalidated' },
      });
      return NextResponse.json({ deleted: res.count });
    }
    const res = await db.examSitting.deleteMany({
      where: { examId: id, status: { not: 'used' } },
    });
    return NextResponse.json({ deleted: res.count });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
