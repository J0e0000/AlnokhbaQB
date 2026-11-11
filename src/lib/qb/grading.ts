// ============================================================
// ALNOKHBA QB — Deterministic auto-grading
// Works on scanned answers (with statuses) + answer key + optional
// teacher overrides. Ambiguous/unanswered NEVER earn marks and are
// reported distinctly.
// ============================================================

import type {
  QBAnswerKey,
  QBDocument,
  QBScanGrade,
  QBScannedAnswer,
} from './types';

export function gradeScan(params: {
  document: QBDocument;
  answerKey: QBAnswerKey;
  answers: QBScannedAnswer[];
  /** questionNumber -> optionId; teacher corrections applied over detection */
  overrides?: Record<string, string>;
}): QBScanGrade {
  const { document, answerKey, answers, overrides = {} } = params;

  // question number -> question (for marks + key lookup)
  const byNumber = new Map(document.questions.map((q) => [q.number, q]));
  const correct: number[] = [];
  const incorrect: number[] = [];
  const ambiguous: number[] = [];
  const unanswered: number[] = [];
  let score = 0;
  let maxScore = 0;

  for (const q of document.questions) {
    maxScore += q.marks;
    const scanned = answers.find((a) => a.number === q.number);
    const override = overrides[String(q.number)];
    const keyOption = answerKey[q.id];

    if (!keyOption) continue; // no key for this question — skip from grading

    let chosen: string | null = null;
    let status = scanned?.status ?? 'unanswered';

    if (override) {
      chosen = override;
      status = 'selected';
    } else if (scanned) {
      chosen = scanned.detected;
    }

    if (status === 'multiple' || status === 'unclear' || status === 'invalid') {
      ambiguous.push(q.number);
      continue;
    }
    if (!chosen || status === 'unanswered') {
      unanswered.push(q.number);
      continue;
    }
    if (chosen === keyOption) {
      correct.push(q.number);
      score += q.marks;
    } else {
      incorrect.push(q.number);
    }
  }

  // Negative marking (port of original settings.neg 0.25 rule): deduct a flat
  // penalty per WRONG answer (not for ambiguous/unclear/unanswered — those are
  // never penalized and never score). Clamped at zero like the original.
  const neg = document.grading?.negativeMarking ?? 0;
  if (neg > 0 && incorrect.length > 0) {
    score = Math.max(0, score - incorrect.length * neg);
  }

  return {
    score,
    maxScore,
    correct,
    incorrect,
    ambiguous,
    unanswered,
    percent: maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0,
    negativeApplied: neg > 0 ? incorrect.length * neg : 0,
  };
}

/** Apply teacher overrides to scanned answers (for review flow). */
export function applyOverrides(
  answers: QBScannedAnswer[],
  overrides: Record<string, string>
): QBScannedAnswer[] {
  return answers.map((a) => {
    const ov = overrides[String(a.number)];
    if (!ov) return a;
    return { ...a, detected: ov, status: 'selected', confidence: 1 };
  });
}
