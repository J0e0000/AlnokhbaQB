// ============================================================
// ALNOKHBA QB — Online exam engine (PHASE 3 + 4)
// Server-authoritative attempts: frozen questions + key, server
// clock expiry, autosave, security events, deterministic grading.
// The client NEVER sees the key pre-submit and can never extend
// the timer — remaining time is derived from the server clock.
// ============================================================

import { db } from '@/lib/db';
import type { QBQuestion } from './types';

export interface AttemptQuestion {
  number: number;
  id: string;
  type: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  marks: number;
}

export interface AttemptGrade {
  score: number;
  maxScore: number;
  percent: number;
  correct: number[];
  incorrect: number[];
  unanswered: number[];
  /** questionNumber → correct option id (post-submit review ONLY) */
  review: Record<string, string>;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Fisher–Yates with a stable seed so a given attempt always shows the same order. */
function seededShuffle<T>(arr: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h + i), 2246822519);
    h ^= h >>> 13;
    const j = Math.abs(h) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build the frozen, client-safe question list for a new attempt.
 * Randomization is deterministic per attempt id (refresh/reconnect keeps order).
 */
export function buildAttemptQuestions(
  questions: QBQuestion[],
  attemptId: string,
  randomize: boolean
): AttemptQuestion[] {
  const list: AttemptQuestion[] = questions.map((q) => ({
    number: q.number,
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    options: q.options.map((o) => ({ id: o.id, text: o.text })),
    marks: q.marks,
  }));
  if (!randomize) return list;
  return seededShuffle(list, attemptId).map((q, i) => ({ ...q, number: i + 1 }));
}

/** Server-side grading of a finalized attempt against its FROZEN key. */
export function gradeAttempt(params: {
  questions: AttemptQuestion[];
  answerKey: Record<string, string>;
  answers: Record<string, string>;
}): AttemptGrade {
  const { questions, answerKey, answers } = params;
  const correct: number[] = [];
  const incorrect: number[] = [];
  const unanswered: number[] = [];
  const review: Record<string, string> = {};
  let score = 0;
  let maxScore = 0;

  for (const q of questions) {
    maxScore += q.marks;
    const key = answerKey[q.id];
    if (!key) continue; // no key for this question — cannot grade, skipped
    review[String(q.number)] = key;
    const chosen = answers[String(q.number)];
    if (!chosen) {
      unanswered.push(q.number);
      continue;
    }
    if (chosen === key) {
      correct.push(q.number);
      score += q.marks;
    } else {
      incorrect.push(q.number);
    }
  }

  return {
    score,
    maxScore,
    percent: maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0,
    correct,
    incorrect,
    unanswered,
    review,
  };
}

/**
 * Finalize an attempt once and only once (idempotent):
 * grade vs the frozen key and flip status. 'invalidated' attempts keep
 * their last synchronized answers but never receive a score.
 * If the attempt belongs to a graded ASSIGNMENT (PHASE 5), the result is
 * mirrored into the assignment submission ledger (one row per attempt).
 * Returns null if the attempt was already finalized (caller re-reads it).
 */
export async function finalizeAttempt(attemptId: string, status: 'submitted' | 'expired'): Promise<AttemptGrade | null> {
  const attempt = await db.examAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.status !== 'active') return null;

  const questions = JSON.parse(attempt.questionsJson) as AttemptQuestion[];
  const key = JSON.parse(attempt.answerKeyJson) as Record<string, string>;
  const answers = JSON.parse(attempt.answersJson) as Record<string, string>;
  const grade = gradeAttempt({ questions, answerKey: key, answers });

  await db.examAttempt.update({
    where: { id: attemptId },
    data: {
      status: status === 'submitted' ? 'submitted' : 'expired',
      submittedAt: new Date(),
      score: status === 'submitted' ? grade.score : null,
      maxScore: grade.maxScore,
    },
  });

  // PHASE 5: mirror the closed attempt into the assignment ledger.
  // late = closed after the server-side dueAt (only possible when the
  // assignment allows late submissions — 'block' rejects before finalize).
  if (attempt.assignmentId) {
    try {
      const assignment = await db.assignment.findUnique({ where: { id: attempt.assignmentId } });
      if (assignment) {
        const closedAt = new Date();
        const expiredRow = status === 'expired';
        await db.assignmentSubmission.upsert({
          where: { attemptId: attempt.id },
          create: {
            assignmentId: assignment.id,
            studentName: attempt.studentName,
            studentCode: attempt.studentCode,
            attemptId: attempt.id,
            score: expiredRow ? null : grade.score,
            maxScore: grade.maxScore,
            late: closedAt > assignment.dueAt,
            status: expiredRow ? 'expired' : 'submitted',
            submittedAt: closedAt,
          },
          update: {
            score: expiredRow ? null : grade.score,
            maxScore: grade.maxScore,
            late: closedAt > assignment.dueAt,
            status: expiredRow ? 'expired' : 'submitted',
            submittedAt: closedAt,
          },
        });
      }
    } catch {
      // ledger mirroring must never break attempt finalization
    }
  }

  return grade;
}

/**
 * Is the attempt past its server-set deadline? Expiry is enforced at every
 * read/write — no cron needed; a stale active attempt finalizes lazily.
 */
export function isExpired(expiresAt: Date): boolean {
  return Date.now() >= expiresAt.getTime();
}

/** Validate + normalize an incoming security event type. */
const SECURITY_TYPES = new Set([
  'tab_hidden', // visibilitychange → hidden
  'window_blur', // focus loss
  'fullscreen_exit',
  'page_leave', // pagehide while active
  'copy_attempt',
]);

export function normalizeSecurityType(t: unknown): string | null {
  return typeof t === 'string' && SECURITY_TYPES.has(t) ? t : null;
}

export const securityEventLimit = 200; // cap the audit trail per attempt
