// GET /api/exams → exam list
// POST /api/exams { title, subject?, direction?, institution? } → new draft exam

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sanitizeDocument, starterDocument } from '@/lib/qb/schema';
import { readJsonBody, serverError, zodMessage } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const exams = await db.exam.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    const list = exams.map((exam) => {
      let questionCount = 0;
      try {
        const doc = JSON.parse(exam.documentJson) as { questions?: unknown[] };
        questionCount = Array.isArray(doc.questions) ? doc.questions.length : 0;
      } catch {
        questionCount = 0;
      }
      return {
        id: exam.id,
        title: exam.title,
        subject: exam.subject,
        status: exam.status,
        questionCount,
        omrEnabled: exam.omrEnabled,
        onlineEnabled: exam.onlineEnabled,
        durationMin: exam.durationMin,
        attemptsAllowed: exam.attemptsAllowed,
        randomizeOrder: exam.randomizeOrder,
        securityPolicy: exam.securityPolicy,
        currentVersion: exam.currentVersion,
        updatedAt: exam.updatedAt,
      };
    });
    return NextResponse.json(list);
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonBody(req);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return NextResponse.json({ error: 'عنوان الامتحان مطلوب (title)' }, { status: 400 });
    }
    const institution =
      typeof body?.institution === 'string' && body.institution.trim()
        ? body.institution.trim()
        : 'مدرسة النخبة';
    const direction = body?.direction === 'ltr' ? 'ltr' : 'rtl';

    const doc = starterDocument(title, institution);
    doc.direction = direction === 'ltr' ? 'ltr' : 'rtl';
    const sanitized = sanitizeDocument(doc);

    const exam = await db.exam.create({
      data: {
        title,
        subject: typeof body?.subject === 'string' ? body.subject.trim() : null,
        gradeLevel: typeof body?.gradeLevel === 'string' ? body.gradeLevel.trim() : null,
        direction: sanitized.direction,
        status: 'DRAFT',
        documentJson: JSON.stringify(sanitized),
        answerKeyJson: '{}',
        omrEnabled: false,
        currentVersion: 0,
      },
    });
    return NextResponse.json({ exam, document: sanitized }, { status: 201 });
  } catch (err) {
    if (isZodError(err)) {
      return NextResponse.json({ error: `مستند غير صالح: ${zodMessage(err)}` }, { status: 400 });
    }
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

function isZodError(err: unknown): boolean {
  return Array.isArray((err as { issues?: unknown })?.issues);
}
