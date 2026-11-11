// GET /api/questions/export?format=json|csv → download the whole (org-scoped) bank

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { audit } from '@/lib/auth';
import { requireSession } from '../../_lib/auth-guard';
import { serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const g = await requireSession('viewer', req);
  if ('error' in g) return g.error;
  const format = (new URL(req.url).searchParams.get('format') ?? 'json').toLowerCase();

  try {
    const rows = await db.question.findMany({
      where: g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    const items = rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      chapter: r.chapter,
      topic: r.topic,
      type: r.type,
      prompt: r.prompt,
      options: JSON.parse(r.optionsJson || '[]'),
      correctAnswer: r.correctAnswer,
      explanation: r.explanation,
      difficulty: r.difficulty,
      marks: r.marks,
      tags: JSON.parse(r.tagsJson || '[]'),
      source: r.source,
      status: r.status,
      createdAt: r.createdAt,
    }));

    await audit({
      session: g.session,
      action: 'question.export',
      entity: 'question',
      meta: { format, count: items.length },
      req,
    });

    if (format === 'csv') {
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        return `"${s.replace(/"/g, '""')}"`;
      };
      const header = [
        'subject', 'chapter', 'topic', 'type', 'prompt', 'options',
        'correctAnswer', 'explanation', 'difficulty', 'marks', 'tags', 'status',
      ];
      const lines = [header.join(',')];
      for (const it of items) {
        lines.push(
          [
            it.subject, it.chapter, it.topic, it.type, it.prompt,
            (it.options as Array<{ id: string; text: string }>).map((o) => `${o.id}:${o.text}`).join(' | '),
            it.correctAnswer, it.explanation, it.difficulty, it.marks,
            (it.tags as string[]).join(' | '), it.status,
          ].map(esc).join(',')
        );
      }
      // UTF-8 BOM so Excel renders Arabic correctly
      const csv = '\uFEFF' + lines.join('\n');
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="question-bank-${Date.now()}.csv"`,
        },
      });
    }

    return new NextResponse(JSON.stringify({ exportedAt: new Date().toISOString(), questions: items }, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="question-bank-${Date.now()}.json"`,
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
