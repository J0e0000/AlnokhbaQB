// Grading: answer key + per-question weights + negative marking → per-sheet
// scores and per-question item analysis (difficulty + answer distribution).

import type { FormTemplate, SheetResult } from './types';

export interface SheetScore {
  sheetId: string;
  fileName: string;
  score: number;
  maxScore: number;
  percentage: number;
  correct: number;
  wrong: number;
  blank: number;
  multiple: number;
  graded: number;
}

export interface ItemStat {
  question: number;
  key: string;
  gradedCount: number;
  correct: number;
  wrong: number;
  blank: number;
  multiple: number;
  percentCorrect: number;
  /** label → count */
  distribution: Record<string, number>;
}

export interface GradeReport {
  perSheet: SheetScore[];
  items: ItemStat[];
  totalWeight: number;
  gradedQuestions: number[];
}

function weightOf(template: FormTemplate, q: number): number {
  const w = template.weights[String(q)];
  return Number.isFinite(w) && (w as number) > 0 ? (w as number) : 1;
}

export function gradedQuestionNumbers(template: FormTemplate): number[] {
  return Object.keys(template.key)
    .map((k) => Number(k))
    .filter((q) => Number.isFinite(q) && (template.key[String(q)] ?? '') !== '')
    .sort((a, b) => a - b);
}

export function gradeResults(results: SheetResult[], template: FormTemplate): GradeReport {
  const graded = gradedQuestionNumbers(template);
  const negative = template.negative > 0 ? template.negative : 0;
  const totalWeight = graded.reduce((s, q) => s + weightOf(template, q), 0);

  const perSheet: SheetScore[] = results.map((r) => {
    let score = 0;
    let correct = 0;
    let wrong = 0;
    let blank = 0;
    let multiple = 0;
    for (const q of graded) {
      const v = r.fields[`OMR-*-${q}`] ?? findOmrField(r, q);
      if (!v || v.status === 'blank') {
        blank++;
        continue;
      }
      if (v.status === 'multiple') {
        multiple++;
        continue; // never scores
      }
      const answer = (v.labels ?? [])[0] ?? '';
      if (answer === template.key[String(q)]) {
        correct++;
        score += weightOf(template, q);
      } else {
        wrong++;
        score -= negative;
      }
    }
    return {
      sheetId: r.sheetId,
      fileName: r.fileName,
      score: Number(score.toFixed(2)),
      maxScore: totalWeight,
      percentage: totalWeight > 0 ? Number(((score / totalWeight) * 100).toFixed(1)) : 0,
      correct,
      wrong,
      blank,
      multiple,
      graded: graded.length,
    };
  });

  // item analysis
  const items: ItemStat[] = graded.map((q) => {
    const stat: ItemStat = {
      question: q,
      key: template.key[String(q)],
      gradedCount: 0,
      correct: 0,
      wrong: 0,
      blank: 0,
      multiple: 0,
      percentCorrect: 0,
      distribution: {},
    };
    for (const r of results) {
      const v = findOmrField(r, q);
      stat.gradedCount++;
      if (!v || v.status === 'blank') {
        stat.blank++;
        continue;
      }
      if (v.status === 'multiple') {
        stat.multiple++;
        continue;
      }
      const answer = (v.labels ?? [])[0] ?? '';
      stat.distribution[answer] = (stat.distribution[answer] ?? 0) + 1;
      if (answer === template.key[String(q)]) stat.correct++;
      else stat.wrong++;
    }
    stat.percentCorrect = stat.gradedCount ? Number(((stat.correct / stat.gradedCount) * 100).toFixed(1)) : 0;
    return stat;
  });

  return { perSheet, items, totalWeight, gradedQuestions: graded };
}

function findOmrField(r: SheetResult, q: number): SheetResult['fields'][string] | undefined {
  for (const key of Object.keys(r.fields)) {
    const v = r.fields[key];
    if (v.kind === 'omr' && v.question === q) return v;
  }
  return undefined;
}
