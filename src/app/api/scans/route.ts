// GET /api/scans?examId=&status=&review=PENDING → newest scans (limit 200)
// `review=PENDING` powers the teacher review queue: only sheets whose
// reviewStatus is PENDING (ambiguous answers / unknown identity / low trust).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { serverError } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GradeLike {
  score?: number;
  maxScore?: number;
  percent?: number;
  ambiguous?: number[];
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const examId = url.searchParams.get('examId') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const review = url.searchParams.get('review') || undefined;

    const scans = await db.scan.findMany({
      where: {
        ...(examId ? { examId } : {}),
        ...(status ? { status } : {}),
        ...(review ? { reviewStatus: review } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      // diagnosticsJson can carry a full base64 sheet on serverless hosts —
      // never load it for a 200-row list
      select: {
        id: true,
        createdAt: true,
        examId: true,
        examVersionId: true,
        studentCode: true,
        studentId: true,
        status: true,
        reviewStatus: true,
        pageIndex: true,
        overallConfidence: true,
        gradeJson: true,
        exam: { select: { title: true } },
      },
    });

    return NextResponse.json(
      scans.map((s) => {
        let grade: GradeLike = {};
        try {
          grade = JSON.parse(s.gradeJson) as GradeLike;
        } catch {
          grade = {};
        }
        return {
          id: s.id,
          createdAt: s.createdAt,
          examId: s.examId,
          examVersionId: s.examVersionId,
          studentCode: s.studentCode,
          studentId: s.studentId,
          status: s.status,
          reviewStatus: s.reviewStatus,
          examTitle: s.exam?.title ?? null,
          pageIndex: s.pageIndex,
          ambiguousCount: Array.isArray(grade.ambiguous) ? grade.ambiguous.length : 0,
          overallConfidence: s.overallConfidence,
          score: grade.score ?? null,
          maxScore: grade.maxScore ?? null,
          percent: grade.percent ?? null,
          needsReview:
            s.status === 'PROCESSED' &&
            ((Array.isArray(grade.ambiguous) && grade.ambiguous.length > 0) ||
              s.overallConfidence < 0.6),
        };
      })
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
