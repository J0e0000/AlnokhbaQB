// POST /api/ai/generate  (PHASE 9)
// { topic, subject?, gradeLevel?, count 1-15, type mcq|truefalse|short, difficulty, lang 'ara'|'eng' }
// → z-ai LLM (BACKEND ONLY) produces STRICT-JSON questions → each candidate is
//   validated against the bank schema → stored with source='ai' and
//   status='pending_review' ALWAYS: AI output is never auto-published; the
//   teacher's review (open + re-save with a key) is what approves it.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { orgFilter } from '@/lib/auth';
import { requireSession } from '../../_lib/auth-guard';
import { readJsonBody, serverError, zodMessage } from '../../_lib/shared';
import {
  normalizeCorrectAnswer,
  questionInputSchema,
  trueFalseOptions,
  type QuestionInput,
} from '@/lib/qb/bank';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const genSchema = z.object({
  topic: z.string().trim().min(3, 'الموضوع قصير جدًا').max(300),
  subject: z.string().trim().max(200).optional(),
  gradeLevel: z.string().trim().max(100).optional(),
  count: z.number().int().min(1).max(15).default(5),
  type: z.enum(['mcq', 'truefalse', 'short']).default('mcq'),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  lang: z.enum(['ara', 'eng']).default('ara'),
});

function buildPrompt(p: {
  topic: string;
  subject?: string;
  gradeLevel?: string;
  count: number;
  type: string;
  difficulty: string;
  lang: 'ara' | 'eng';
}): { system: string; user: string } {
  const langRule =
    p.lang === 'ara'
      ? 'اكتب كل المحتوى باللغة العربية الفصحى.'
      : 'Write everything in clear English.';
  const system =
    'You are an expert exam-question writer for school teachers. You output STRICT, VALID JSON only — no markdown fences, no commentary, no trailing text.';
  const shape =
    p.type === 'mcq'
      ? `{"type":"mcq","prompt":"…","options":[{"id":"A","text":"…"},{"id":"B","text":"…"},{"id":"C","text":"…"},{"id":"D","text":"…"}],"correctAnswer":"A","explanation":"…"}`
      : p.type === 'truefalse'
        ? `{"type":"truefalse","prompt":"…","correctAnswer":"A","explanation":"…"} (A=صح/true, B=خطأ/false — vary the correct answer between A and B)`
        : `{"type":"short","prompt":"…","explanation":"model answer"}`;
  const user = [
    `Write ${p.count} ${p.difficulty} ${p.type} exam question(s) about: "${p.topic}".`,
    p.subject ? `Subject/context: ${p.subject}.` : '',
    p.gradeLevel ? `Target grade: ${p.gradeLevel}.` : '',
    langRule,
    `Return ONLY a JSON array of exactly ${p.count} objects, each shaped exactly like: ${shape}`,
    p.type === 'mcq'
      ? 'Each mcq has exactly 4 options with ids A,B,C,D; exactly one is correct; distractors must be plausible; do not reuse the same option text.'
      : '',
    'Every question MUST include "explanation" (why the answer is correct).',
  ]
    .filter(Boolean)
    .join(' ');
  return { system, user };
}

function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Strip an LLM candidate down to the prompt/options/key/explanation core. */
function normalizeCandidate(
  raw: unknown,
  type: 'mcq' | 'truefalse' | 'short'
): Pick<QuestionInput, 'type' | 'prompt' | 'options' | 'correctAnswer' | 'explanation'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim().slice(0, 5000) : '';
  if (!prompt) return null;

  if (type === 'truefalse') {
    // fixed options; accept A/B (or true/false) as the key
    const rawKey = typeof o.correctAnswer === 'string' ? o.correctAnswer.trim().toUpperCase() : '';
    const correctAnswer = rawKey === 'B' || rawKey === 'FALSE' || rawKey === 'خطأ' ? 'B' : 'A';
    return {
      type: 'truefalse',
      prompt,
      options: trueFalseOptions(),
      correctAnswer,
      explanation: typeof o.explanation === 'string' ? o.explanation.slice(0, 5000) : null,
    };
  }

  const options =
    type === 'mcq'
      ? (Array.isArray(o.options) ? o.options : [])
          .map((op, i) => {
            if (!op || typeof op !== 'object') return null;
            const t = (op as Record<string, unknown>).text;
            const text = typeof t === 'string' ? t.trim().slice(0, 2000) : '';
            if (!text) return null;
            return { id: ['A', 'B', 'C', 'D', 'E', 'F'][i] ?? String(i), text };
          })
          .filter((x): x is { id: string; text: string } => x !== null)
      : [];

  return {
    type,
    prompt,
    options,
    correctAnswer: typeof o.correctAnswer === 'string' ? o.correctAnswer.trim().slice(0, 4) : null,
    explanation: typeof o.explanation === 'string' ? o.explanation.slice(0, 5000) : null,
  };
}

export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    const body = await readJsonBody(req);
    const parsed = genSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `بيانات التوليد غير صالحة: ${zodMessage(parsed.error)}` },
        { status: 400 }
      );
    }
    const p = parsed.data;

    const { system, user } = buildPrompt(p);
    const mod = (await import('z-ai-web-dev-sdk')) as unknown as {
      default: {
        create: () => Promise<{
          chat: {
            completions: {
              create: (params: unknown) => Promise<{
                choices?: Array<{ message?: { content?: string } }>;
              }>;
            };
          };
        }>;
      };
    };
    const zai = await mod.default.create();

    // LLMs occasionally emit non-JSON prose — ask again once before failing.
    const askOnce = async (): Promise<string> => {
      const completion = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: system },
          { role: 'user', content: user },
        ],
        thinking: { type: 'disabled' },
      });
      return completion.choices?.[0]?.message?.content ?? '';
    };
    let raw = await askOnce();
    let candidates = extractJsonArray(raw);
    if (candidates.length === 0) {
      raw = await askOnce();
      candidates = extractJsonArray(raw);
    }
    if (candidates.length === 0) {
      console.warn('[ai/generate] unparseable LLM output, first 300 chars:', raw.slice(0, 300));
      return NextResponse.json(
        { error: 'لم ينتج النموذج أسئلة صالحة — أعد المحاولة بصياغة مختلفة للموضوع' },
        { status: 502 }
      );
    }

    // validate + persist; AI questions are ALWAYS pending_review (never auto-published)
    const createdIds: string[] = [];
    let rejected = 0;
    for (const candidate of candidates.slice(0, p.count)) {
      const core = normalizeCandidate(candidate, p.type);
      if (!core) {
        rejected++;
        continue;
      }
      const withMeta: QuestionInput = {
        ...core,
        subject: p.subject?.trim() || null,
        chapter: null,
        topic: p.topic.slice(0, 200),
        difficulty: p.difficulty,
        marks: 1,
        tags: ['ai'],
        source: 'ai',
      };
      const check = questionInputSchema.safeParse(withMeta);
      if (!check.success) {
        rejected++;
        console.warn('[ai/generate] candidate rejected:', zodMessage(check.error), '| prompt:', (core.prompt ?? '').slice(0, 60));
        continue;
      }
      const input = check.data;
      const options = input.type === 'truefalse' ? trueFalseOptions() : input.options;
      const correctAnswer = normalizeCorrectAnswer(input.correctAnswer, options);
      if (input.type === 'mcq' && (!correctAnswer || options.length < 2)) {
        rejected++; // an mcq without a usable key is useless even for review
        continue;
      }
      const row = await db.question.create({
        data: {
          organizationId: orgFilter(g.session) ?? null,
          subject: input.subject,
          chapter: input.chapter,
          topic: input.topic,
          type: input.type,
          prompt: input.prompt.trim(),
          optionsJson: JSON.stringify(options),
          correctAnswer,
          explanation: input.explanation ?? null,
          difficulty: input.difficulty,
          marks: input.marks,
          tagsJson: JSON.stringify(input.tags),
          source: 'ai',
          status: 'pending_review', // ALWAYS — teacher review required
        },
      });
      createdIds.push(row.id);
    }

    if (createdIds.length === 0) {
      return NextResponse.json(
        { error: 'النموذج أنتج أسئلة غير صالحة — أعد المحاولة', rejected },
        { status: 502 }
      );
    }

    const rows = await db.question.findMany({
      where: { id: { in: createdIds }, organizationId: orgFilter(g.session) },
    });
    return NextResponse.json(
      {
        generated: rows.length,
        rejected,
        questions: rows.map((r) => ({
          id: r.id,
          prompt: r.prompt,
          type: r.type,
          status: r.status,
          correctAnswer: r.correctAnswer,
        })),
      },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
