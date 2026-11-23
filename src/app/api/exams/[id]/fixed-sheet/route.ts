// GET  /api/exams/:id/fixed-sheet → current fixed sheet revision (+ list)
// POST /api/exams/:id/fixed-sheet → create a new revision
//   { totalQuestions?, optionsPerQuestion?, idDigits?, versions?, name? }
// The template is exam-level: one printed sheet serves every version, so the
// copies can be distributed in any order.

import { NextResponse } from 'next/server';

import { db } from '@/lib/db';
import {
  buildFixedSheetTemplate,
  fixedSheetTemplateId,
  validateFixedSheetTemplate,
} from '@/lib/qb/fixed-sheet';
import { sanitizeDocument } from '@/lib/qb/schema';
import { readJsonBody, serverError } from '../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const rows = await db.fixedSheet.findMany({
      where: { examId: id },
      orderBy: { revision: 'desc' },
      take: 20,
    });
    const current = rows[0] ?? null;
    return NextResponse.json({
      examId: id,
      current: current
        ? {
            id: current.id,
            revision: current.revision,
            templateId: current.templateId,
            name: current.name,
            createdAt: current.createdAt,
            template: safeJson(current.dataJson),
          }
        : null,
      revisions: rows.map((r) => ({
        id: r.id,
        revision: r.revision,
        templateId: r.templateId,
        name: r.name,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exam = await db.exam.findUnique({
      where: { id },
      include: { versions: { select: { version: true } } },
    });
    if (!exam) {
      return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 });
    }

    const body = await readJsonBody(req);
    const doc = sanitizeDocument(safeJson(exam.documentJson) ?? {});
    const publishedVersions = exam.versions.length;
    const versionsFromBody = Number(body?.versions);
    const versions =
      Number.isInteger(versionsFromBody) && versionsFromBody >= 2
        ? versionsFromBody
        : Math.max(2, publishedVersions || 2);
    if (publishedVersions > 0 && versions !== publishedVersions) {
      return NextResponse.json(
        {
          error: `عدد النسخ المطبوعة (${versions}) لا يطابق عدد النسخ المنشورة (${publishedVersions}) — سيتعذّر التصحيح الآلي`,
          stage: 'versionCountMismatch',
        },
        { status: 409 }
      );
    }

    const last = await db.fixedSheet.findFirst({
      where: { examId: id },
      orderBy: { revision: 'desc' },
    });
    const revision = (last?.revision ?? 0) + 1;
    const templateId = fixedSheetTemplateId(id, revision);
    const optionsFromDoc = doc.questions?.[0]?.options?.length ?? 4;

    const template = buildFixedSheetTemplate({
      examId: id,
      examTitle: exam.title,
      totalQuestions: Number.isInteger(Number(body?.totalQuestions))
        ? Number(body?.totalQuestions)
        : Math.max(1, doc.questions?.length ?? 0),
      optionsPerQuestion: Number.isInteger(Number(body?.optionsPerQuestion))
        ? Number(body?.optionsPerQuestion)
        : Math.min(4, optionsFromDoc),
      idDigits: Number.isInteger(Number(body?.idDigits)) ? Number(body?.idDigits) : 6,
      versions,
      direction: exam.direction === 'ltr' ? 'ltr' : 'rtl',
      marksPerQuestion: doc.questions?.[0]?.marks ?? 1,
      templateId,
    });

    if (!validateFixedSheetTemplate(template)) {
      return NextResponse.json({ error: 'تعذّر بناء ورقة صالحة' }, { status: 500 });
    }

    const row = await db.fixedSheet.create({
      data: {
        examId: id,
        revision,
        templateId,
        name: `${exam.title} — ورقة موحّدة r${revision}`,
        dataJson: JSON.stringify(template),
      },
    });

    return NextResponse.json({
      id: row.id,
      revision: row.revision,
      templateId: row.templateId,
      sheets: template.sheets,
      totalQuestions: template.totalQuestions,
      versions: template.versionMarks.letters.length,
      idDigits: template.idBoxes.digits,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

function safeJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
