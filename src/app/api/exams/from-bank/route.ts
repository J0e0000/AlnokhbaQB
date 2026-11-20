// POST /api/exams/from-bank
// { title, subject?, direction?, institution?, questionIds[],
//   online?: { enabled, durationMin?, attemptsAllowed?, randomizeOrder?, securityPolicy? } }
// → creates a DRAFT exam whose documentJson is composed from Question Bank
//   rows (PHASE 2). The answer key is pre-filled from bank correctAnswer
//   where known — questions without a key stay gradeable-later (teacher sets
//   the key in the designer before publishing).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parseOptions, toQBQuestion, type BankQuestion } from '@/lib/qb/bank';
import { sanitizeAnswerKey, sanitizeDocument, starterDocument } from '@/lib/qb/schema';
import { readJsonBody, serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readJsonBody(req);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const ids = Array.isArray(body?.questionIds)
      ? (body.questionIds as unknown[]).filter((i): i is string => typeof i === 'string')
      : [];
    if (!title) {
      return NextResponse.json({ error: 'عنوان الامتحان مطلوب (title)' }, { status: 400 });
    }
    if (ids.length === 0) {
      return NextResponse.json({ error: 'اختر سؤالًا واحدًا على الأقل من البنك' }, { status: 400 });
    }

    const bankRows = await db.question.findMany({ where: { id: { in: ids } } });
    // preserve the caller's selection order
    const byId = new Map(bankRows.map((r) => [r.id, r]));
    const ordered: BankQuestion[] = ids
      .map((id) => byId.get(id))
      .filter((r): r is (typeof bankRows)[number] => Boolean(r))
      .map((r) => ({
        id: r.id,
        subject: r.subject,
        chapter: r.chapter,
        topic: r.topic,
        type: r.type as BankQuestion['type'],
        prompt: r.prompt,
        options: parseOptions(r.optionsJson),
        correctAnswer: r.correctAnswer,
        explanation: r.explanation,
        difficulty: r.difficulty as BankQuestion['difficulty'],
        marks: r.marks,
        tags: [],
        source: r.source,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    if (ordered.length === 0) {
      return NextResponse.json({ error: 'لم يتم العثور على الأسئلة المحددة' }, { status: 404 });
    }

    const institution =
      typeof body?.institution === 'string' && body.institution.trim() ? body.institution.trim() : 'مدرسة النخبة';
    const direction = body?.direction === 'ltr' ? 'ltr' : 'rtl';

    // Build the canonical document: starter chrome + one question element per
    // bank question, stacked vertically; overflow flows onto new pages (same
    // layout strategy as the OCR importer).
    const doc = starterDocument(title, institution);
    doc.direction = direction;
    const suffix = Date.now().toString(36);

    const answerKey: Record<string, string> = {};
    const elements: Array<Record<string, unknown>> = [];
    let page = 0;
    let y =
      doc.elements.reduce((m, el) => (el.page === 0 ? Math.max(m, el.y + el.heightMm) : m), 36) + 4;

    const questions = ordered.map((bank, i) => {
      const q = toQBQuestion(bank, `q-bank-${suffix}-${i + 1}`, i + 1);
      if (bank.correctAnswer && q.options.some((o) => o.id === bank.correctAnswer)) {
        answerKey[q.id] = bank.correctAnswer;
      }
      return q;
    });

    for (let i = 0; i < questions.length; i++) {
      if (y > doc.pageSize.heightMm - 40 && page < doc.pageCount + 48) {
        page += 1;
        y = doc.margins.topMm + 40;
      }
      elements.push({
        id: `el-bank-${suffix}-${i + 1}`,
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
          align: direction === 'rtl' ? 'right' : 'left',
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

    const online = (body?.online ?? {}) as Record<string, unknown>;
    const documentJson = sanitizeDocument({
      ...doc,
      pageCount: page + 1,
      questions,
      elements: [...doc.elements, ...elements],
    });

    const exam = await db.exam.create({
      data: {
        title,
        subject: typeof body?.subject === 'string' ? body.subject.trim() : null,
        direction,
        status: 'DRAFT',
        documentJson: JSON.stringify(documentJson),
        answerKeyJson: JSON.stringify(sanitizeAnswerKey(answerKey)),
        omrEnabled: false,
        currentVersion: 0,
        onlineEnabled: online.enabled === true,
        durationMin: clampInt(online.durationMin, 1, 600, 30),
        attemptsAllowed: clampInt(online.attemptsAllowed, 1, 10, 1),
        randomizeOrder: online.randomizeOrder === true,
        securityPolicy: online.securityPolicy === 'strict' ? 'strict' : 'warning',
      },
    });

    return NextResponse.json(
      {
        examId: exam.id,
        title,
        questionCount: questions.length,
        keyCount: Object.keys(answerKey).length,
        missingKey: questions.length - Object.keys(answerKey).length,
      },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
