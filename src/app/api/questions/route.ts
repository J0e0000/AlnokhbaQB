// GET /api/questions?q=&subject=&type=&difficulty=&tag=&status=&page=&pageSize=
//   → { questions, total, page, pageSize, meta }   (PHASE 1: bank listing)
// POST /api/questions { prompt, options, correctAnswer?, ... } → new question

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  normalizeCorrectAnswer,
  parseOptions,
  parseTags,
  questionInputSchema,
  statusFor,
  trueFalseOptions,
  type BankQuestion,
} from '@/lib/qb/bank';
import { readJsonBody, serverError, zodMessage } from '../_lib/shared';
import type { Prisma } from '@prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function serialize(row: {
  id: string;
  subject: string | null;
  chapter: string | null;
  topic: string | null;
  type: string;
  prompt: string;
  optionsJson: string;
  correctAnswer: string | null;
  explanation: string | null;
  difficulty: string;
  marks: number;
  tagsJson: string;
  source: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): BankQuestion {
  return {
    id: row.id,
    subject: row.subject,
    chapter: row.chapter,
    topic: row.topic,
    type: row.type as BankQuestion['type'],
    prompt: row.prompt,
    options: parseOptions(row.optionsJson),
    correctAnswer: row.correctAnswer,
    explanation: row.explanation,
    difficulty: row.difficulty as BankQuestion['difficulty'],
    marks: row.marks,
    tags: parseTags(row.tagsJson),
    source: row.source,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q')?.trim() ?? '';
    const subject = url.searchParams.get('subject')?.trim() ?? '';
    const type = url.searchParams.get('type')?.trim() ?? '';
    const difficulty = url.searchParams.get('difficulty')?.trim() ?? '';
    const tag = url.searchParams.get('tag')?.trim() ?? '';
    const status = url.searchParams.get('status')?.trim() ?? ''; // approved | pending_review (PHASE 8/9 review queue)
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get('pageSize') ?? '50') || 50));

    const where: Prisma.QuestionWhereInput = {};
    if (q) {
      where.OR = [
        { prompt: { contains: q } },
        { topic: { contains: q } },
        { chapter: { contains: q } },
        { tagsJson: { contains: q } },
      ];
    }
    if (subject) where.subject = subject;
    if (type) where.type = type;
    if (difficulty) where.difficulty = difficulty;
    if (tag) where.tagsJson = { contains: `"${tag}"` };
    if (status === 'approved' || status === 'pending_review') where.status = status;

    const [rows, total, allRows] = await Promise.all([
      db.question.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.question.count({ where }),
      db.question.findMany({
        select: { subject: true, type: true, difficulty: true, tagsJson: true },
      }),
    ]);

    // facet metadata for filter dropdowns (cheap on SQLite at QB scale)
    const subjects = [...new Set(allRows.map((r) => r.subject).filter((s): s is string => Boolean(s)))].sort();
    const types = [...new Set(allRows.map((r) => r.type))];
    const difficulties = [...new Set(allRows.map((r) => r.difficulty))];
    const tags = [
      ...new Set(
        allRows.flatMap((r) => {
          try {
            const arr = JSON.parse(r.tagsJson) as unknown;
            return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : [];
          } catch {
            return [];
          }
        })
      ),
    ].sort();

    return NextResponse.json({
      questions: rows.map(serialize),
      total,
      page,
      pageSize,
      meta: { subjects, types, difficulties, tags },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonBody(req);
    const parsed = questionInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: `بيانات السؤال غير صالحة: ${zodMessage(parsed.error)}` }, { status: 400 });
    }
    const input = parsed.data;
    const options = input.type === 'truefalse' ? trueFalseOptions() : input.options;
    const correctAnswer = normalizeCorrectAnswer(input.correctAnswer, options);

    const row = await db.question.create({
      data: {
        subject: input.subject?.trim() || null,
        chapter: input.chapter?.trim() || null,
        topic: input.topic?.trim() || null,
        type: input.type,
        prompt: input.prompt.trim(),
        optionsJson: JSON.stringify(options),
        correctAnswer,
        explanation: input.explanation?.trim() || null,
        difficulty: input.difficulty,
        marks: input.marks,
        tagsJson: JSON.stringify(input.tags.map((t) => t.trim()).filter(Boolean)),
        source: input.source?.trim() || 'manual',
        status: statusFor({ ...input, correctAnswer }),
      },
    });
    return NextResponse.json({ question: serialize(row) }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: `بيانات غير صالحة: ${zodMessage(err)}` }, { status: 400 });
    }
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
