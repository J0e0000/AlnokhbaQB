// POST /api/attempts/:id/submit → finalize + grade server-side.
// Idempotent: submitting twice (or after auto-expiry) returns the stored
// result. The review payload (correct answers) is only revealed AFTER the
// attempt is closed. Invalidated attempts cannot be submitted.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { finalizeAttempt, isExpired, type AttemptQuestion } from '@/lib/qb/online';
import { serverError } from '../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const attempt = await db.examAttempt.findUnique({ where: { id } });
    if (!attempt) {
      return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 });
    }

    if (attempt.status === 'invalidated') {
      return NextResponse.json(
        { error: 'أُلغيت هذه المحاولة بسبب مخالفة القواعد — لا يمكن تسليمها', status: 'invalidated' },
        { status: 409 }
      );
    }

    // closed attempts return their stored result (idempotent resubmit)
    if (attempt.status !== 'active') {
      const questions = JSON.parse(attempt.questionsJson) as AttemptQuestion[];
      const key = JSON.parse(attempt.answerKeyJson) as Record<string, string>;
      const answers = JSON.parse(attempt.answersJson) as Record<string, string>;
      const review: Record<string, string> = {};
      for (const q of questions) {
        const k = key[q.id];
        if (k) review[String(q.number)] = k;
      }
      return NextResponse.json({
        status: attempt.status,
        submittedAt: attempt.submittedAt?.toISOString() ?? null,
        score: attempt.score,
        maxScore: attempt.maxScore,
        answers,
        review,
        questionCount: questions.length,
      });
    }

    // PHASE 5: assignment deadline gate at submit time (server clock).
    // A blocked late submission (or a submission into a closed assignment)
    // closes the attempt as expired — no score — and rejects.
    if (attempt.assignmentId) {
      const assignment = await db.assignment.findUnique({ where: { id: attempt.assignmentId } });
      if (assignment) {
        const blocked =
          assignment.status !== 'open' ||
          (new Date() > assignment.dueAt && assignment.latePolicy === 'block');
        if (blocked) {
          await finalizeAttempt(attempt.id, 'expired');
          return NextResponse.json(
            {
              error:
                assignment.status !== 'open'
                  ? 'أُغلق هذا الواجب — تم إغلاق محاولتك دون درجة'
                  : 'انتهى موعد التسليم — تم إغلاق محاولتك دون درجة',
              code: assignment.status !== 'open' ? 'CLOSED' : 'LATE_BLOCKED',
              status: 'expired',
            },
            { status: 403 }
          );
        }
      }
    }

    // active → finalize now (expired-at-submit is recorded as 'expired')
    const expired = isExpired(attempt.expiresAt);
    const grade = await finalizeAttempt(attempt.id, expired ? 'expired' : 'submitted');
    if (!grade) {
      // raced with another submit — return the stored state
      const fresh = await db.examAttempt.findUnique({ where: { id } });
      return NextResponse.json({
        status: fresh?.status ?? 'submitted',
        submittedAt: fresh?.submittedAt?.toISOString() ?? null,
        score: fresh?.score ?? null,
        maxScore: fresh?.maxScore ?? null,
        answers: JSON.parse(fresh?.answersJson ?? '{}') as Record<string, string>,
        review: {},
        questionCount: (JSON.parse(fresh?.questionsJson ?? '[]') as AttemptQuestion[]).length,
      });
    }

    return NextResponse.json({
      status: expired ? 'expired' : 'submitted',
      submittedAt: new Date().toISOString(),
      score: grade.score,
      maxScore: grade.maxScore,
      percent: grade.percent,
      correct: grade.correct,
      incorrect: grade.incorrect,
      unanswered: grade.unanswered,
      answers: JSON.parse(attempt.answersJson) as Record<string, string>,
      review: grade.review,
      questionCount: (JSON.parse(attempt.questionsJson) as AttemptQuestion[]).length,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
