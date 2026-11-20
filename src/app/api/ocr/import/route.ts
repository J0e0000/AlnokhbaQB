// POST /api/ocr/import { text, title?, target?: 'exam' | 'bank' }
// Port of the legacy nokhba-qb OCR importer: parse OCR'd/typed text into
// question prompts, then EITHER:
//   • target 'exam' (default): create a DRAFT exam preloaded with the
//     questions so the teacher fills choices + key in the designer
//   • target 'bank' (PHASE 8): append them to the reusable Question Bank as
//     source='ocr', status='pending_review', correctAnswer=null — OCR content
//     is NEVER auto-published; the teacher must set the key (review act).
//
// Parsing rules (identical to the original importOCRToDesigner):
//   • a new question starts at a line beginning with a number
//     (Latin 0-9 or Arabic-Indic ٠-٩) followed by . ) or -
//   • continuation lines append to the current question
//   • no numbered lines at all → the whole text becomes a single question

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { sanitizeDocument, starterDocument } from '@/lib/qb/schema';
import { serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  text: z.string().min(3).max(200_000),
  title: z.string().max(300).optional(),
  target: z.enum(['exam', 'bank']).default('exam'),
});

/** Latin + Arabic-Indic digits followed by . ) or - (original regex). */
const NUMBERED_LINE_RE = /^[\d\u0660-\u0669]+[\.\)\-]/;
const NUMBER_PREFIX_RE = /^[\d\u0660-\u0669]+[\.\)\-]\s*/;

export function parseNumberedQuestions(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const prompts: string[] = [];
  let current: string | null = null;

  for (const line of lines) {
    if (NUMBERED_LINE_RE.test(line)) {
      if (current !== null) prompts.push(current);
      current = line.replace(NUMBER_PREFIX_RE, '');
    } else if (current !== null) {
      current += ' ' + line;
    } else {
      current = line;
    }
  }
  if (current !== null) prompts.push(current);
  if (prompts.length === 0) prompts.push(text.trim());

  return prompts
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 500);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const parsedBody = bodySchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: 'النص مطلوب (3 أحرف على الأقل)' },
        { status: 400 }
      );
    }
    const { text } = parsedBody.data;
    const title = parsedBody.data.title?.trim() || 'امتحان مستورد من OCR';

    const prompts = parseNumberedQuestions(text);
    if (prompts.length === 0) {
      return NextResponse.json(
        { error: 'لم يتم العثور على أي سؤال في النص' },
        { status: 400 }
      );
    }

    // ---- PHASE 8: straight into the Question Bank as pending_review ----
    if (parsedBody.data.target === 'bank') {
      const rows = prompts.slice(0, 200).map((prompt) => ({
        prompt,
        type: 'mcq',
        optionsJson: JSON.stringify([
          { id: 'A', text: '' },
          { id: 'B', text: '' },
          { id: 'C', text: '' },
          { id: 'D', text: '' },
        ]),
        correctAnswer: null, // teacher sets the key during review — never auto
        difficulty: 'medium',
        marks: 1,
        tagsJson: JSON.stringify(['ocr']),
        source: 'ocr',
        status: 'pending_review', // never auto-published
      }));
      const created = await db.question.createMany({ data: rows });
      return NextResponse.json({
        target: 'bank',
        bankCreated: created.count,
        questionCount: created.count,
      });
    }

    const exam = await db.exam.create({
      data: { title, status: 'DRAFT', direction: 'rtl' },
    });

    // Build the canonical document: starter chrome (header + name fields) +
    // one question (4 empty options أ-د) + one question element per prompt,
    // stacked vertically exactly like the designer's own "add question".
    const doc = starterDocument(title, 'مدرسة النخبة');
    const suffix = exam.id.slice(-6);

    const questions = prompts.map((prompt, i) => ({
      id: `q-ocr-${suffix}-${i + 1}`,
      number: i + 1,
      type: 'mcq' as const,
      prompt,
      options: [
        { id: 'A', text: '' },
        { id: 'B', text: '' },
        { id: 'C', text: '' },
        { id: 'D', text: '' },
      ],
      marks: 1,
    }));

    // sequential vertical layout; overflow flows onto new pages
    const questionElements: Array<Record<string, unknown>> = [];
    let page = 0;
    let y =
      doc.elements.reduce(
        (m, el) => (el.page === 0 ? Math.max(m, el.y + el.heightMm) : m),
        36
      ) + 4;

    for (let i = 0; i < questions.length; i++) {
      if (y > doc.pageSize.heightMm - 40 && page < doc.pageCount + 48) {
        page += 1;
        y = doc.margins.topMm + 40;
      }
      questionElements.push({
        id: `el-ocr-${suffix}-${i + 1}`,
        type: 'question',
        page,
        x: doc.margins.leftMm,
        y,
        widthMm: doc.pageSize.widthMm - doc.margins.leftMm - doc.margins.rightMm,
        heightMm: 22,
        rotation: 0,
        style: {
          fontFamily: 'Tajawal',
          fontSize: 12,
          bold: false,
          italic: false,
          underline: false,
          align: 'right',
          color: '#111827',
          lineHeight: 1.5,
        },
        content: {
          questionId: questions[i].id,
          showNumber: true,
          optionLayout: 'vertical',
          showOptionLetter: true,
          showMarks: false,
        },
      });
      y += 26;
    }

    const documentJson = sanitizeDocument({
      ...doc,
      pageCount: page + 1,
      questions,
      elements: [...doc.elements, ...questionElements],
    });

    await db.exam.update({
      where: { id: exam.id },
      data: { documentJson: JSON.stringify(documentJson) },
    });

    return NextResponse.json({
      target: 'exam',
      examId: exam.id,
      title,
      questionCount: questions.length,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
