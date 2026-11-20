// POST /api/attempts  { examId, studentName, studentCode?, assignmentId? }
//   → starts OR resumes an attempt (PHASE 3). Server clock sets expiresAt;
//     questions + answer key are FROZEN on the attempt row; the client never
//     receives the key or any correctness info.
//     assignmentId (PHASE 5): starting from a graded assignment gates the
//     server-side dueAt deadline (block → reject; allow → late flag on close).
// GET  /api/attempts?examId=  → teacher monitor list (stale actives auto-finalize)

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sanitizeDocument } from '@/lib/qb/schema';
import { buildAttemptQuestions, finalizeAttempt, isExpired, type AttemptQuestion } from '@/lib/qb/online';
import { readJsonBody, serverError } from '../_lib/shared';
import type { QBDocument } from '@/lib/qb/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function publicAttempt(a: {
  id: string;
  examId: string;
  studentName: string;
  studentCode: string | null;
  startedAt: Date;
  expiresAt: Date;
  submittedAt: Date | null;
  status: string;
  answersJson: string;
  score: number | null;
  maxScore: number | null;
  securityJson: string;
}) {
  return {
    id: a.id,
    examId: a.examId,
    studentName: a.studentName,
    studentCode: a.studentCode,
    startedAt: a.startedAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    submittedAt: a.submittedAt?.toISOString() ?? null,
    status: a.status,
    answers: JSON.parse(a.answersJson) as Record<string, string>,
    score: a.score,
    maxScore: a.maxScore,
    securityEvents: (JSON.parse(a.securityJson) as Array<{ type: string; at: string }>).length,
  };
}

export async function POST(req: Request) {
  try {
    const body = await readJsonBody(req);
    const examId = typeof body?.examId === 'string' ? body.examId : '';
    const studentName = typeof body?.studentName === 'string' ? body.studentName.trim() : '';
    const studentCode =
      typeof body?.studentCode === 'string' && body.studentCode.trim() ? body.studentCode.trim() : null;
    const assignmentId = typeof body?.assignmentId === 'string' ? body.assignmentId : null;
    if (!examId || !studentName) {
      return NextResponse.json({ error: 'اسم الطالب وامتحان مطلوبان' }, { status: 400 });
    }

    // PHASE 5: graded-assignment gate (server clock decides, never the client)
    let assignment: { id: string; dueAt: Date; latePolicy: string; status: string } | null = null;
    if (assignmentId) {
      const a = await db.assignment.findUnique({ where: { id: assignmentId } });
      if (!a || a.mode !== 'graded' || a.examId !== examId) {
        return NextResponse.json({ error: 'الواجب غير صالح لهذا الامتحان' }, { status: 400 });
      }
      if (a.status !== 'open') {
        return NextResponse.json({ error: 'هذا الواجب مغلق حاليًا', code: 'CLOSED' }, { status: 403 });
      }
      if (new Date() > a.dueAt && a.latePolicy === 'block') {
        return NextResponse.json(
          { error: 'انتهى موعد تسليم الواجب — لم يُسمح بالتسليم المتأخر', code: 'LATE_BLOCKED' },
          { status: 403 }
        );
      }
      assignment = { id: a.id, dueAt: a.dueAt, latePolicy: a.latePolicy, status: a.status };
    }

    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }
    if (exam.status !== 'PUBLISHED' || !exam.onlineEnabled) {
      return NextResponse.json(
        { error: 'هذا الامتحان غير متاح أونلاين — يجب نشره وتفعيل وضع أونلاين أولًا' },
        { status: 403 }
      );
    }

    // resume: same student + same exam + still active → same attempt (refresh
    // / reopen / reconnect never resets the server timer)
    const existing = await db.examAttempt.findFirst({
      where: { examId, studentName, studentCode, status: 'active' },
      orderBy: { startedAt: 'desc' },
    });
    if (existing) {
      if (isExpired(existing.expiresAt)) {
        await finalizeAttempt(existing.id, 'expired');
        return NextResponse.json(
          { error: 'انتهى وقت هذا المحاولة قبل استئنافها — تم إغلاقها وتسجيلها', code: 'EXPIRED' },
          { status: 409 }
        );
      }
      const questions = JSON.parse(existing.questionsJson) as AttemptQuestion[];
      return NextResponse.json({
        resumed: true,
        serverNow: new Date().toISOString(),
        attempt: {
          id: existing.id,
          examId,
          examTitle: exam.title,
          studentName,
          securityPolicy: exam.securityPolicy,
          startedAt: existing.startedAt.toISOString(),
          expiresAt: existing.expiresAt.toISOString(),
          status: existing.status,
          answers: JSON.parse(existing.answersJson) as Record<string, string>,
          questions,
        },
      });
    }

    // attempts limit (invalidated attempts don't consume the allowance)
    const used = await db.examAttempt.count({
      where: { examId, studentName, studentCode, status: { not: 'invalidated' } },
    });
    if (used >= exam.attemptsAllowed) {
      return NextResponse.json(
        { error: `استُهلكت محاولاتك لهذا الامتحان (${exam.attemptsAllowed})`, code: 'NO_ATTEMPTS' },
        { status: 403 }
      );
    }

    // freeze questions + key from the CURRENT draft document (the exam was
    // published; the draft is the canonical live content)
    const doc = sanitizeDocument(JSON.parse(exam.documentJson)) as QBDocument;
    if (doc.questions.length === 0) {
      return NextResponse.json({ error: 'الامتحان لا يحتوي أسئلة' }, { status: 409 });
    }
    const key = JSON.parse(exam.answerKeyJson) as Record<string, string>;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + exam.durationMin * 60_000); // server clock

    const created = await db.examAttempt.create({
      data: {
        examId,
        studentName,
        studentCode,
        expiresAt,
        status: 'active',
        assignmentId: assignment?.id ?? null, // PHASE 5: ledger mirror on close
        questionsJson: '[]', // set right after (needs the attempt id for seeded shuffle)
        answersJson: '{}',
        answerKeyJson: JSON.stringify(key),
      },
    });

    const questions = buildAttemptQuestions(doc.questions, created.id, exam.randomizeOrder);
    const withQuestions = await db.examAttempt.update({
      where: { id: created.id },
      data: { questionsJson: JSON.stringify(questions) },
    });

    return NextResponse.json(
      {
        resumed: false,
        serverNow: now.toISOString(),
        attempt: {
          id: withQuestions.id,
          examId,
          examTitle: exam.title,
          studentName,
          securityPolicy: exam.securityPolicy,
          startedAt: withQuestions.startedAt.toISOString(),
          expiresAt: withQuestions.expiresAt.toISOString(),
          status: withQuestions.status,
          answers: {},
          questions,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const examId = url.searchParams.get('examId')?.trim() ?? '';
    if (!examId) {
      return NextResponse.json({ error: 'examId مطلوب' }, { status: 400 });
    }
    // lazily finalize stale active attempts so the monitor always tells the truth
    const stale = await db.examAttempt.findMany({ where: { examId, status: 'active' } });
    for (const a of stale) {
      if (isExpired(a.expiresAt)) await finalizeAttempt(a.id, 'expired');
    }
    const rows = await db.examAttempt.findMany({
      where: { examId },
      orderBy: { startedAt: 'desc' },
      take: 200,
    });
    return NextResponse.json({ attempts: rows.map(publicAttempt) });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
