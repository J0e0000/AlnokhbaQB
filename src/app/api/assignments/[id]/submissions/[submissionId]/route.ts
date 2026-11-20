// PATCH /api/assignments/:id/submissions/:submissionId
// Teacher grading (PHASE 5): { score?, feedback? } → status='graded'.
// Works for both modes: overrides the auto-graded score of a graded
// assignment, or enters the manual score of a file submission.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readJsonBody, serverError } from '../../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; submissionId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id, submissionId } = await ctx.params;
    const body = await readJsonBody(req);
    if (!body) {
      return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
    }

    const submission = await db.assignmentSubmission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.assignmentId !== id) {
      return NextResponse.json({ error: 'التسليم غير موجود' }, { status: 404 });
    }

    const data: {
      score?: number | null;
      feedback?: string | null;
      status?: string;
    } = {};

    if (body.score !== undefined) {
      if (body.score === null) {
        data.score = null;
      } else if (typeof body.score === 'number' && Number.isFinite(body.score) && body.score >= 0) {
        data.score = body.score;
      } else {
        return NextResponse.json({ error: 'الدرجة يجب أن تكون رقمًا غير سالب' }, { status: 400 });
      }
    }
    if (body.feedback !== undefined) {
      data.feedback =
        typeof body.feedback === 'string' && body.feedback.trim()
          ? body.feedback.trim().slice(0, 2000)
          : null;
    }

    if (data.score !== undefined || data.feedback !== undefined) {
      data.status = 'graded'; // teacher touched it → out of the auto pipeline
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'لا يوجد شيء لتحديثه' }, { status: 400 });
    }

    const updated = await db.assignmentSubmission.update({
      where: { id: submissionId },
      data,
    });
    return NextResponse.json({
      submission: {
        id: updated.id,
        score: updated.score,
        maxScore: updated.maxScore,
        feedback: updated.feedback,
        status: updated.status,
        late: updated.late,
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
