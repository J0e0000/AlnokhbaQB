// POST /api/exams/:id/publish
// Creates an immutable ExamVersion snapshot (version = currentVersion + 1)
// from the CURRENT draft, builds the OMR template when the document enables
// it, then flips the exam to PUBLISHED. Re-publishing an unchanged draft
// intentionally creates a NEW version (versions are immutable history).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { buildOmrTemplate } from '@/lib/qb/omr-template';
import { sanitizeAnswerKey, sanitizeDocument } from '@/lib/qb/schema';
import type { OMRTemplate } from '@/lib/qb/types';
import { serverError } from '../../../_lib/shared';

export const maxDuration = 60;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await db.exam.findUnique({ where: { id } });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }
    if (exam.status === 'ARCHIVED') {
      return NextResponse.json({ error: 'لا يمكن نشر امتحان مؤرشف' }, { status: 409 });
    }

    let document;
    let answerKey;
    try {
      document = sanitizeDocument(JSON.parse(exam.documentJson));
      answerKey = sanitizeAnswerKey(JSON.parse(exam.answerKeyJson));
    } catch (err) {
      return NextResponse.json(
        {
          error: 'مسودة الامتحان غير صالحة — لا يمكن النشر. صحّح المستند أولًا.',
          details: err instanceof Error ? err.message : String(err),
        },
        { status: 400 }
      );
    }

    const versionNumber = exam.currentVersion + 1;

    // 1) snapshot row (template needs the version id → saved right after)
    const version = await db.examVersion.create({
      data: {
        examId: exam.id,
        version: versionNumber,
        title: exam.title,
        documentJson: JSON.stringify(document),
        answerKeyJson: JSON.stringify(answerKey),
        omrTemplateJson: null,
      },
    });

    // 2) OMR template bound to THIS version id
    let omrTemplate: OMRTemplate | null = null;
    if (document.omr.enabled) {
      omrTemplate = buildOmrTemplate({
        examId: exam.id,
        examVersionId: version.id,
        document,
        versionNumber,
      });
      await db.examVersion.update({
        where: { id: version.id },
        data: { omrTemplateJson: JSON.stringify(omrTemplate) },
      });
    }

    // 3) flip the exam
    await db.exam.update({
      where: { id: exam.id },
      data: {
        currentVersion: versionNumber,
        status: 'PUBLISHED',
        omrEnabled: document.omr.enabled,
      },
    });

    return NextResponse.json({
      versionId: version.id,
      version: versionNumber,
      omrEnabled: document.omr.enabled,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
