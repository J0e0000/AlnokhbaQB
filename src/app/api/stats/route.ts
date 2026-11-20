// GET /api/stats → dashboard counts
// { exams, publishedVersions, scans, avgConfidence, scansNeedingReview, students }

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { serverError } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GradeLike {
  ambiguous?: number[];
  score?: number;
  maxScore?: number;
}

export async function GET() {
  try {
    const [exams, publishedExams, versions, scans, students] = await Promise.all([
      db.exam.count(),
      db.exam.count({ where: { status: 'PUBLISHED' } }),
      db.examVersion.count(),
      db.scan.findMany({
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { status: true, overallConfidence: true, gradeJson: true },
      }),
      db.student.count(),
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
