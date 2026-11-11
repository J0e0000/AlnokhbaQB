// ============================================================
// ALNOKHBA QB — Question Bank core (PHASE 1)
// Shared types + zod validation + bank↔document question mapping.
// Bank questions are the reusable pool; exams COPY questions into
// their documentJson (exams remain self-contained snapshots).
// ============================================================

import { z } from 'zod';
import type { QBQuestion } from './types';

export const QUESTION_TYPES = ['mcq', 'truefalse', 'short'] as const;
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface BankOption {
  id: string; // 'A' | 'B' | 'C' | ...
  text: string;
}

export interface BankQuestion {
  id: string;
  subject: string | null;
  chapter: string | null;
  topic: string | null;
  type: QuestionType;
  prompt: string;
  options: BankOption[];
  correctAnswer: string | null;
  explanation: string | null;
  difficulty: Difficulty;
  marks: number;
  tags: string[];
  source: string | null;
  status: string; // 'approved' | 'pending_review'
  createdAt: string;
  updatedAt: string;
}

// ---------- zod validation (POST / PATCH bodies) ----------

const optionSchema = z.object({
  id: z.string().min(1).max(4),
  text: z.string().max(2000).default(''),
});

export const questionInputSchema = z.object({
  subject: z.string().max(200).nullish(),
  chapter: z.string().max(200).nullish(),
  topic: z.string().max(200).nullish(),
  type: z.enum(QUESTION_TYPES).default('mcq'),
  prompt: z.string().min(1).max(5000),
  options: z.array(optionSchema).min(2).max(6).default([]),
  correctAnswer: z.string().max(4).nullish(),
  explanation: z.string().max(5000).nullish(),
  difficulty: z.enum(DIFFICULTIES).default('medium'),
  marks: z.number().int().min(1).max(100).default(1),
  tags: z.array(z.string().max(60)).max(12).default([]),
  source: z.string().max(60).nullish(),
});

export type QuestionInput = z.infer<typeof questionInputSchema>;

/** A question without a correct answer can never grade — mark it for review. */
export function statusFor(input: Pick<QuestionInput, 'correctAnswer' | 'type'>): string {
  return input.correctAnswer ? 'approved' : 'pending_review';
}

/** Validate that correctAnswer points at an existing option id. */
export function normalizeCorrectAnswer(
  correctAnswer: string | null | undefined,
  options: BankOption[]
): string | null {
  if (!correctAnswer) return null;
  return options.some((o) => o.id === correctAnswer) ? correctAnswer : null;
}

// ---------- bank ↔ document mapping ----------

/** True/false questions are stored as two fixed options. */
export function trueFalseOptions(): BankOption[] {
  return [
    { id: 'A', text: 'صح' },
    { id: 'B', text: 'خطأ' },
  ];
}

/**
 * Convert a bank question to a document QBQuestion. Question numbers are
 * assigned by the CALLER (they depend on the target document).
 */
export function toQBQuestion(bank: BankQuestion, id: string, number: number): QBQuestion {
  const options =
    bank.type === 'truefalse'
      ? trueFalseOptions()
      : bank.options.length >= 2
        ? bank.options
        : [
            { id: 'A', text: '' },
            { id: 'B', text: '' },
            { id: 'C', text: '' },
            { id: 'D', text: '' },
          ];
  return {
    id,
    number,
    type: 'mcq', // document model is mcq-shaped; truefalse/short degrade gracefully
    prompt: bank.prompt,
    options,
    marks: bank.marks,
  };
}

/** Parse the stored optionsJson safely. */
export function parseOptions(json: string): BankOption[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((o): o is BankOption => Boolean(o) && typeof o === 'object' && typeof (o as BankOption).id === 'string')
      .map((o) => ({ id: o.id, text: typeof o.text === 'string' ? o.text : '' }))
      .slice(0, 6);
  } catch {
    return [];
  }
}

/** Parse the stored tagsJson safely. */
export function parseTags(json: string): string[] {
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}
