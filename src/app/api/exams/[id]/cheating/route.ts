// GET /api/exams/:id/cheating?proximity=2&threshold=85&minOverlap=5
// Cheating detection (كشف الغش) — proximity + answer-similarity analysis.
//
// Rule (teacher-defined):
//   • Students sat in NEARBY seats (|seatA − seatB| ≤ proximity)
//   • AND their selected answers match on ≥ threshold% of the questions they
//     both answered  →  a suspected-cheating pair is reported.
//   • Identical WRONG answers (same wrong option on the same questions) are
//     reported separately — copying produces matching wrong answers, which is
//     the strongest signal a teacher can defend with.
//
// Identity source: the seat code (كود الجلوس) the student filled in the ID
// bubbles → Scan.studentCode === ExamSitting.code → seat number. When the
// exam has no registered sittings, numeric student codes are treated as raw
// seat numbers (seat-fallback mode, flagged in the response).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { serverError } from '../../../_lib/shared';
import type { QBScannedAnswer } from '@/lib/qb/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const NOT_OWNED = { error: 'غير موجود أو لا تملك صلاحية الوصول' } as const;

const MAX_SCANS = 400;
const MAX_PAIRS = 120;

interface AnswerPattern {
  scanId: string;
  code: string;
  seat: number | null;
  sittingId: string | null;
  studentName: string | null;
  score: number | null;
  maxScore: number | null;
  percent: number | null;
  answers: Map<number, string>; // question number → selected letter
  incorrect: Set<number>; // question numbers answered wrong
}

interface PairResult {
  seatA: number | null;
  seatB: number | null;
  codeA: string;
  codeB: string;
  studentNameA: string | null;
  studentNameB: string | null;
  scanIdA: string;
  scanIdB: string;
  seatGap: number;
  commonQuestions: number;
  sameAnswers: number;
  matchPct: number;
  bothWrongOverlap: number;
  sameWrong: number;
  sameWrongPct: number;
  flagged: boolean;
  severity: 'high' | 'medium';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** question number → selected letter (only clean single selections count). */
function answerMap(scan: { answersJson: string }): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const parsed = JSON.parse(scan.answersJson) as { answers?: QBScannedAnswer[] };
    for (const a of parsed.answers ?? []) {
      if (a.status === 'selected' && a.detected) map.set(a.number, a.detected);
    }
  } catch {
    // legacy/corrupt row → treated as an empty pattern
  }
  return map;
}

function incorrectSet(scan: { gradeJson: string }): Set<number> {
  const set = new Set<number>();
  try {
    const g = JSON.parse(scan.gradeJson) as { incorrect?: number[] };
    for (const n of g.incorrect ?? []) set.add(n);
  } catch {
    // no grade → no wrong-answer signal
  }
  return set;
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10; // 1 decimal
}

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const exam = await db.exam.findUnique({
      where: { id },
      select: { id: true, title: true },
    });
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });

    const url = new URL(req.url);
    const proximity = clamp(Math.round(Number(url.searchParams.get('proximity')) || 2), 1, 10);
    const threshold = clamp(Number(url.searchParams.get('threshold')) || 85, 50, 100);
    const minOverlap = clamp(Math.round(Number(url.searchParams.get('minOverlap')) || 5), 1, 50);

    // ---- 1. gather scans (latest PROCESSED/REVIEWED per student code)
    const scans = await db.scan.findMany({
      where: {
        examId: id,
        status: { in: ['PROCESSED', 'REVIEWED'] },
        studentCode: { not: null },
      },
      select: {
        id: true,
        studentCode: true,
        answersJson: true,
        gradeJson: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_SCANS,
    });

    const byCode = new Map<string, (typeof scans)[number]>();
    for (const s of scans) {
      const code = s.studentCode as string;
      if (!byCode.has(code)) byCode.set(code, s); // desc order → first wins
    }

    // ---- 2. resolve seats: sitting codes first, numeric fallback second
    const sittings = await db.examSitting.findMany({
      where: { examId: id },
      select: {
        id: true,
        code: true,
        seatNumber: true,
        studentName: true,
        status: true,
      },
    });
    const sittingByCode = new Map(sittings.map((s) => [s.code, s]));
    const hasSittings = sittings.length > 0;

    const patterns: AnswerPattern[] = [];
    const unlinkedCodes: string[] = [];

    for (const [code, scan] of byCode) {
      const sitting = sittingByCode.get(code);
      let seat: number | null = null;
      if (sitting) {
        seat = sitting.seatNumber;
      } else if (!hasSittings) {
        const n = Number(code);
        seat = Number.isInteger(n) && n > 0 && n <= 9999 ? n : null;
      } else {
        unlinkedCodes.push(code);
      }
      const grade = (() => {
        try {
          return JSON.parse(scan.gradeJson) as { score?: number; maxScore?: number; percent?: number };
        } catch {
          return {};
        }
      })();
      patterns.push({
        scanId: scan.id,
        code,
        seat,
        sittingId: sitting?.id ?? null,
        studentName: sitting?.studentName ?? null,
        score: grade.score ?? null,
        maxScore: grade.maxScore ?? null,
        percent: grade.percent ?? null,
        answers: answerMap(scan),
        incorrect: incorrectSet(scan),
      });
    }

    const seated = patterns.filter((p) => p.seat !== null);

    // ---- 3. pairwise comparison inside the proximity window
    const pairs: PairResult[] = [];
    let compared = 0;
    for (let i = 0; i < seated.length; i++) {
      for (let j = i + 1; j < seated.length; j++) {
        const a = seated[i];
        const b = seated[j];
        const gap = Math.abs((a.seat as number) - (b.seat as number));
        if (gap > proximity) continue;
        compared++;

        // common questions both answered with a clean selection
        const common: number[] = [];
        for (const num of a.answers.keys()) {
          if (b.answers.has(num)) common.push(num);
        }
        if (common.length < minOverlap) continue;

        let same = 0;
        let sameWrong = 0;
        let bothWrongOverlap = 0;
        for (const num of common) {
          const la = a.answers.get(num);
          const lb = b.answers.get(num);
          if (la && lb && la === lb) {
            same++;
            const wrongA = a.incorrect.has(num);
            const wrongB = b.incorrect.has(num);
            if (wrongA && wrongB) {
              bothWrongOverlap++;
              sameWrong++;
            }
          }
        }
        const wrongOverlap = common.filter(
          (num) => a.incorrect.has(num) && b.incorrect.has(num)
        ).length;

        const matchPct = pct(same, common.length);
        const sameWrongPct = pct(sameWrong, Math.max(wrongOverlap, 1));
        const flagged = matchPct >= threshold;
        const severity: 'high' | 'medium' =
          matchPct >= 90 || (matchPct >= threshold && sameWrongPct >= 80 && sameWrong >= 3)
            ? 'high'
            : 'medium';

        pairs.push({
          seatA: a.seat,
          seatB: b.seat,
          codeA: a.code,
          codeB: b.code,
          studentNameA: a.studentName,
          studentNameB: b.studentName,
          scanIdA: a.scanId,
          scanIdB: b.scanId,
          seatGap: gap,
          commonQuestions: common.length,
          sameAnswers: same,
          matchPct,
          bothWrongOverlap: wrongOverlap,
          sameWrong,
          sameWrongPct,
          flagged,
          severity,
        });
      }
    }

    pairs.sort((x, y) => {
      if (x.flagged !== y.flagged) return x.flagged ? -1 : 1;
      if (x.matchPct !== y.matchPct) return y.matchPct - x.matchPct;
      return y.sameWrong - x.sameWrong;
    });
    const flaggedPairs = pairs.filter((p) => p.flagged);

    // ---- 4. persist sitting ↔ scan links (best effort, keeps registry true)
    if (hasSittings) {
      const now = new Date();
      for (const p of patterns) {
        if (!p.sittingId) continue;
        try {
          await db.examSitting.update({
            where: { id: p.sittingId },
            data: { scanId: p.scanId, status: 'used', usedAt: now },
          });
        } catch {
          // non-blocking
        }
      }
    }


    return NextResponse.json({
      examId: id,
      examTitle: exam.title,
      mode: hasSittings ? 'sitting-codes' : 'seat-fallback',
      settings: { proximity, threshold, minOverlap },
      stats: {
        scansCount: patterns.length,
        seatedCount: seated.length,
        sittingsCount: sittings.length,
        compared,
        flaggedCount: flaggedPairs.length,
        highestMatch: pairs.length ? Math.max(...pairs.map((p) => p.matchPct)) : 0,
        unlinkedCodes: unlinkedCodes.slice(0, 30),
      },
      pairs: pairs.slice(0, MAX_PAIRS),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
