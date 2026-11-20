// GET   /api/attempts/:id → attempt state (serverNow for clock sync; NO key)
// PATCH /api/attempts/:id { answers?, securityEvent? }
//   → autosave + security audit. Expiry is enforced server-side on every
//     call: an expired attempt is finalized and further answers are rejected.
//     STRICT policy: a security event immediately invalidates the attempt.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  finalizeAttempt,
  isExpired,
  normalizeSecurityType,
  securityEventLimit,
  type AttemptQuestion,
} from '@/lib/qb/online';
import { readJsonBody, serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    let attempt = await db.examAttempt.findUnique({ where: { id } });
    if (!attempt) {
      return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 });
    }
    if (attempt.status === 'active' && isExpired(attempt.expiresAt)) {
      await finalizeAttempt(attempt.id, 'expired');
      attempt = await db.examAttempt.findUnique({ where: { id } });
      if (!attempt) {
        return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 });
      }
    }
    const questions = JSON.parse(attempt.questionsJson) as AttemptQuestion[];
    const exam = await db.exam.findUnique({ where: { id: attempt.examId } });
    return NextResponse.json({
      serverNow: new Date().toISOString(),
      attempt: {
        id: attempt.id,
        examId: attempt.examId,
        examTitle: exam?.title ?? '',
        studentName: attempt.studentName,
        securityPolicy: exam?.securityPolicy ?? 'warning',
        startedAt: attempt.startedAt.toISOString(),
        expiresAt: attempt.expiresAt.toISOString(),
        status: attempt.status,
        submittedAt: attempt.submittedAt?.toISOString() ?? null,
        answers: JSON.parse(attempt.answersJson) as Record<string, string>,
        score: attempt.score,
        maxScore: attempt.maxScore,
        questions,
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const attempt = await db.examAttempt.findUnique({ where: { id } });
    if (!attempt) {
      return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 });
    }

    // ---- expiry enforcement (authoritative) ----
    if (attempt.status === 'active' && isExpired(attempt.expiresAt)) {
      const grade = await finalizeAttempt(attempt.id, 'expired');
      return NextResponse.json(
        {
          finalized: true,
          status: 'expired',
          serverNow: new Date().toISOString(),
          grade,
        },
        { status: 409 }
      );
    }
    if (attempt.status !== 'active') {
      return NextResponse.json(
        { error: 'هذه المحاولة مغلقة — لا يمكن تعديل الإجابات', status: attempt.status },
        { status: 409 }
      );
    }

    const body = await readJsonBody(req);
    const exam = await db.exam.findUnique({ where: { id: attempt.examId } });

    // ---- security event (PHASE 4) ----
    const eventType = normalizeSecurityType(body?.securityEvent);
    if (eventType) {
      const trail = JSON.parse(attempt.securityJson) as Array<{ type: string; at: string }>;
      trail.push({ type: eventType, at: new Date().toISOString() });
      const trimmed = JSON.stringify(trail.slice(-securityEventLimit));
      if (exam?.securityPolicy === 'strict') {
        await db.examAttempt.update({
          where: { id },
          data: { securityJson: trimmed, status: 'invalidated', submittedAt: new Date() },
        });
        return NextResponse.json(
          {
            invalidated: true,
            status: 'invalidated',
            serverNow: new Date().toISOString(),
            error: 'تم إنهاء المحاولة بسبب مخالفة قواعد الامتحان — حفظت آخر إجاباتك المتزامنة',
          },
          { status: 409 }
        );
      }
      await db.examAttempt.update({ where: { id }, data: { securityJson: trimmed } });
    }

    // ---- answers autosave ----
    if (body?.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)) {
      const incoming = body.answers as Record<string, unknown>;
      const current = JSON.parse(attempt.answersJson) as Record<string, string>;
      const questions = JSON.parse(attempt.questionsJson) as AttemptQuestion[];
      const validNumbers = new Set(questions.map((q) => String(q.number)));
      const validOptions = new Map(questions.map((q) => [String(q.number), new Set(q.options.map((o) => o.id))]));
      for (const [num, opt] of Object.entries(incoming)) {
        if (!validNumbers.has(num)) continue; // ignore forged question numbers
        if (typeof opt !== 'string') continue;
        if (opt !== '' && !validOptions.get(num)?.has(opt)) continue; // ignore forged option ids
        current[num] = opt;
      }
      await db.examAttempt.update({ where: { id }, data: { answersJson: JSON.stringify(current) } });
    }

    return NextResponse.json({
      ok: true,
      serverNow: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
