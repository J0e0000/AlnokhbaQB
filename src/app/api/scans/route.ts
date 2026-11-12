// GET /api/scans?examId=&status=&review=PENDING → newest scans (limit 100)
// `review` filters the dedicated reviewStatus column (the review queue uses
// review=PENDING); `needsReview` mirrors that column, falling back to the
// heuristic for legacy rows created before it existed.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { orgFilter } from '@/lib/auth';
import { requireSession } from '../_lib/auth-guard';
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
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const url = new URL(req.url);
    const examId = url.searchParams.get('examId') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const review = url.searchParams.get('review') || undefined;
    const org = orgFilter(g.session);

    const scans = await db.scan.findMany({
      where: {
        ...(examId ? { examId } : {}),
        ...(status ? { status } : {}),
        ...(review ? { reviewStatus: review } : {}),
        // multi-tenant: scans are scoped through their exam's organisation
        ...(org !== undefined ? { exam: { organizationId: org } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { exam: { select: { title: true } } },
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
            s.reviewStatus === 'PENDING' ||
            (s.reviewStatus === 'NONE' &&
              s.status === 'PROCESSED' &&
              ((Array.isArray(grade.ambiguous) && grade.ambiguous.length > 0) ||
                s.overallConfidence < 0.6)),
        };
      })
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
