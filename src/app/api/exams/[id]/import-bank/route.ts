// POST /api/exams/:id/import-bank  { questionIds[] }
// Appends Question Bank questions to an EXISTING draft exam's document
// (PHASE 2). Numbers continue after the current last question; new question
// elements stack below the lowest element and flow onto new pages.
// Answer key entries are pre-filled where the bank question has one.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parseOptions, toQBQuestion, type BankQuestion } from '@/lib/qb/bank';
import { sanitizeAnswerKey, sanitizeDocument } from '@/lib/qb/schema';
import { serverError } from '../../../_lib/shared';
import type { QBDocument, QBElement, QBQuestion } from '@/lib/qb/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await db.exam.findUnique({ where: { id } });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }
    if (exam.status !== 'DRAFT') {
      return NextResponse.json(
        { error: 'لا يمكن تعديل امتحان منشور — أنشئ نسخة جديدة أو عدّ المسودة قبل النشر' },
        { status: 409 }
      );
    }

    const body = (await req.json().catch(() => null)) as { questionIds?: unknown } | null;
    const ids = Array.isArray(body?.questionIds)
      ? (body.questionIds as unknown[]).filter((i): i is string => typeof i === 'string')
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: 'اختر سؤالًا واحدًا على الأقل' }, { status: 400 });
    }

    const doc = sanitizeDocument(JSON.parse(exam.documentJson)) as QBDocument;
    const key = JSON.parse(exam.answerKeyJson) as Record<string, string>;

    const bankRows = await db.question.findMany({ where: { id: { in: ids } } });
    const byId = new Map(bankRows.map((r) => [r.id, r]));
    const ordered = ids.map((q) => byId.get(q)).filter((r): r is (typeof bankRows)[number] => Boolean(r));
    if (ordered.length === 0) {
      return NextResponse.json({ error: 'لم يتم العثور على الأسئلة المحددة' }, { status: 404 });
    }

    let nextNumber = doc.questions.reduce((m, q) => Math.max(m, q.number), 0);
    const suffix = Date.now().toString(36);

    let page = doc.elements.reduce(
      (m, el) => (el.page === 0 ? Math.max(m, el.page) : m),
      0
    );
    let y = doc.elements.reduce((m, el) => (el.page === page ? Math.max(m, el.y + el.heightMm) : m), 36);

    const addedQuestions: QBQuestion[] = [];
    const addedElements: QBElement[] = [];

    for (let i = 0; i < ordered.length; i++) {
      const bank = ordered[i];
      const bankQ: BankQuestion = {
        id: bank.id,
        subject: bank.subject,
        chapter: bank.chapter,
        topic: bank.topic,
        type: bank.type as BankQuestion['type'],
        prompt: bank.prompt,
        options: parseOptions(bank.optionsJson),
        correctAnswer: bank.correctAnswer,
        explanation: bank.explanation,
        difficulty: bank.difficulty as BankQuestion['difficulty'],
        marks: bank.marks,
        tags: [],
        source: bank.source,
        status: bank.status,
        createdAt: bank.createdAt.toISOString(),
        updatedAt: bank.updatedAt.toISOString(),
      };
      nextNumber += 1;
      const q = toQBQuestion(bankQ, `q-bank-${suffix}-${nextNumber}`, nextNumber);
      if (bank.correctAnswer && q.options.some((o) => o.id === bank.correctAnswer)) {
        key[q.id] = bank.correctAnswer;
      }

      if (y > doc.pageSize.heightMm - 40 && page < doc.pageCount + 48) {
        page += 1;
        y = doc.margins.topMm + 40;
      }
      addedElements.push({
        id: `el-bank-${suffix}-${nextNumber}`,
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
          align: doc.direction === 'rtl' ? 'right' : 'left',
          color: '#111827',
          lineHeight: 1.5,
        },
        content: {
          questionId: q.id,
          showNumber: true,
          optionLayout: 'vertical',
          showOptionLetter: true,
          showMarks: false,
        },
      });
      y += 26;
      addedQuestions.push(q);
    }

    const updated = sanitizeDocument({
      ...doc,
      pageCount: Math.max(doc.pageCount, page + 1),
      questions: [...doc.questions, ...addedQuestions],
      elements: [...doc.elements, ...addedElements],
    });

    await db.exam.update({
      where: { id },
      data: {
        documentJson: JSON.stringify(updated),
        answerKeyJson: JSON.stringify(sanitizeAnswerKey(key)),
      },
    });

    return NextResponse.json({
      ok: true,
      added: addedQuestions.length,
      questionCount: updated.questions.length,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
