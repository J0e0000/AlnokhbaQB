// GET /api/stats → dashboard counts
// { exams, publishedVersions, scans, avgConfidence, scansNeedingReview, students }

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { orgFilter } from '@/lib/auth';
import { requireSession } from '../_lib/auth-guard';
import { serverError } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GradeLike {
  ambiguous?: number[];
  score?: number;
  maxScore?: number;
}

export async function GET(req: Request) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const org = orgFilter(g.session);
    const orgExam = org !== undefined ? { organizationId: org } : {};
    const orgViaExam = org !== undefined ? { exam: { organizationId: org } } : {};

    const [exams, publishedExams, versions, scans, students] = await Promise.all([
      db.exam.count({ where: orgExam }),
      db.exam.count({ where: { ...orgExam, status: 'PUBLISHED' } }),
      db.examVersion.count({ where: orgViaExam }),
      db.scan.findMany({
        where: orgViaExam,
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { status: true, overallConfidence: true, gradeJson: true },
      }),
      db.student.count({ where: orgExam }),
    ]);

    let confidenceSum = 0;
    let scansNeedingReview = 0;
    for (const scan of scans) {
      confidenceSum += scan.overallConfidence;
      if (scan.status !== 'PROCESSED') continue;
      let grade: GradeLike = {};
      try {
        grade = JSON.parse(scan.gradeJson) as GradeLike;
      } catch {
        grade = {};
      }
      const hasAmbiguous = Array.isArray(grade.ambiguous) && grade.ambiguous.length > 0;
      if (hasAmbiguous || scan.overallConfidence < 0.6) scansNeedingReview++;
    }

    return NextResponse.json({
      exams,
      publishedExams,
      publishedVersions: versions,
      scans: scans.length,
      avgConfidence:
        scans.length > 0
          ? Math.round((confidenceSum / scans.length) * 1000) / 1000
          : 0,
      scansNeedingReview,
      students,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
