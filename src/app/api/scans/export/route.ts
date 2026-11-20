// GET /api/scans/export?examId=...
// CSV export of the results log (port of the legacy nokhba-qb
// exportResultsCSV): UTF-8 BOM + Excel-friendly quoting so Arabic opens
// correctly in Excel. Columns match the original log:
//   الامتحان، الطالب، الدرجة، من، صحيحة، خاطئة، فارغة، متعددة، التاريخ

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function csvCell(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const examId = url.searchParams.get('examId') || undefined;

    const scans = await db.scan.findMany({
      where: examId ? { examId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 5000,
      include: { exam: { select: { title: true } }, student: { select: { name: true } } },
    });

    const head = ['الامتحان', 'الطالب', 'الدرجة', 'من', 'صحيحة', 'خاطئة', 'فارغة', 'متعددة', 'التاريخ'];
    const rows = scans.map((s) => {
      const grade = safeParse(s.gradeJson);
      const date = new Date(s.createdAt).toLocaleString('ar-EG');
      return [
        s.exam?.title ?? '—',
        s.student?.name ?? s.studentCode ?? '—',
        typeof grade.score === 'number' ? round2(grade.score) : '—',
        typeof grade.maxScore === 'number' ? grade.maxScore : '—',
        Array.isArray(grade.correct) ? grade.correct.length : '',
        Array.isArray(grade.incorrect) ? grade.incorrect.length : '',
        Array.isArray(grade.unanswered) ? grade.unanswered.length : '',
        Array.isArray(grade.ambiguous) ? grade.ambiguous.length : '',
        date,
      ];
    });

    const csv =
      '\uFEFF' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="nokhba-results.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
