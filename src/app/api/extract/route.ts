// GET  /api/extract        → recent extraction jobs (org-scoped)
// POST /api/extract        → run VLM extraction over page images
//   body: { documentId?, filename?, mimeType?, language, pages: [{ page, dataUrl }] }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { audit, rateLimit } from '@/lib/auth';
import { requireSession } from '../_lib/auth-guard';
import { serverError } from '../_lib/shared';
import { extractQuestionsFromPage, EXTRACT_LANGUAGES, type ExtractLanguage } from '@/lib/qb/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(500),
  dataUrl: z.string().startsWith('data:image/').max(6_000_000),
});

const bodySchema = z.object({
  documentId: z.string().max(64).optional(),
  filename: z.string().max(200).optional(),
  mimeType: z.string().max(100).optional(),
  language: z.enum(EXTRACT_LANGUAGES).default('auto'),
  pages: z.array(pageSchema).min(1).max(10),
});

const jobListSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

export async function GET(req: Request) {
  const g = await requireSession('viewer', req);
  if ('error' in g) return g.error;
  const url = new URL(req.url);
  const q = jobListSchema.safeParse({ limit: url.searchParams.get('limit') ?? 20 });
  const limit = q.success ? q.data.limit : 20;

  try {
    const jobs = await db.extractionJob.findMany({
      where: g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { document: { select: { filename: true, mimeType: true } } },
    });
    return NextResponse.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        language: j.language,
        questionCount: j.questionCount,
        error: j.error,
        createdAt: j.createdAt,
        document: j.document,
      })),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  const g = await requireSession('teacher', req);
  if ('error' in g) return g.error;

  if (!rateLimit(`extract:${g.session.uid}`, 30, 300_000)) {
    return NextResponse.json(
      { error: 'وصلت الحد الأقصى لعمليات الاستخراج — انتظر ٥ دقائق' },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'بيانات غير صالحة — أرسل صفحة واحدة على الأقل كصورة (data:image)' },
      { status: 400 }
    );
  }
  const { pages, language, documentId } = parsed.data;

  try {
    // resolve / create the source document record
    let doc = null as Awaited<ReturnType<typeof db.bankDocument.findFirst>> | null;
    if (documentId) {
      doc = await db.bankDocument.findFirst({
        where: {
          id: documentId,
          ...(g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId }),
        },
      });
      if (!doc) {
        return NextResponse.json({ error: 'المستند غير موجود' }, { status: 404 });
      }
    } else {
      doc = await db.bankDocument.create({
        data: {
          organizationId: g.session.orgId ?? null,
          uploadedByEmail: g.session.email,
          filename: parsed.data.filename ?? 'صفحات مستخرجة',
          mimeType: parsed.data.mimeType ?? 'image/png',
          size: pages.reduce((a, p) => a + p.dataUrl.length, 0),
          pageCount: pages.length,
          storedPath: null,
          status: 'ready',
        },
      });
    }

    const job = await db.extractionJob.create({
      data: {
        documentId: doc.id,
        organizationId: g.session.orgId ?? null,
        language,
        engine: 'vlm',
        status: 'processing',
      },
    });

    // extract page by page (VLM) — one page failure never kills the job
    let order = 0;
    let succeededPages = 0;
    let lastError: string | null = null;

    for (const p of pages) {
      try {
        const { items } = await extractQuestionsFromPage(p.dataUrl, language as ExtractLanguage);
        succeededPages += 1;
        if (items.length === 0) continue;
        await db.extractedQuestion.createMany({
          data: items.map((it) => ({
            jobId: job.id,
            order: order++,
            page: p.page,
            type: it.type,
            prompt: it.prompt,
            optionsJson: JSON.stringify(it.options ?? []),
            correctAnswer: it.correctAnswer ?? null,
            explanation: it.explanation ?? null,
            difficulty: it.difficulty,
            marks: it.marks,
            tagsJson: '[]',
            confidence: it.confidence,
            status: 'pending',
          })),
        });
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'فشل غير معروف';
        console.error('[extract] page failed', p.page, e);
      }
    }

    const questionCount = await db.extractedQuestion.count({ where: { jobId: job.id } });

    if (succeededPages === 0) {
      await db.extractionJob.update({
        where: { id: job.id },
        data: { status: 'failed', error: lastError ?? 'فشل استخراج جميع الصفحات', updatedAt: new Date() },
      });
      return NextResponse.json(
        { error: 'فشل استخراج الصفحات — أعد المحاولة أو استخدم جودة صورة أعلى', jobId: job.id },
        { status: 502 }
      );
    }

    await db.extractionJob.update({
      where: { id: job.id },
      data: { status: 'review', questionCount, error: lastError, updatedAt: new Date() },
    });

    await audit({
      session: g.session,
      action: 'extract.run',
      entity: 'extractionJob',
      entityId: job.id,
      meta: { pages: pages.length, questionCount, language },
      req,
    });

    return NextResponse.json({ jobId: job.id, questionCount, pages: pages.length }, { status: 201 });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
