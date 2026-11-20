// GET /api/scans?examId=&status= → newest scans (limit 100)

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

    const scans = await db.scan.findMany({
      where: {
        ...(examId ? { examId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
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
