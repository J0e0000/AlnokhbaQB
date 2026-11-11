// ============================================================
// ALNOKHBA QB — Documents API (upload sources for extraction)
// GET  /api/documents            → org-scoped list (newest 50)
// POST /api/documents (multipart)→ save file to db/uploads + record
// ============================================================

import { NextResponse } from 'next/server';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { audit, rateLimit } from '@/lib/auth';
import { requireSession } from '../_lib/auth-guard';
import { serverError } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const MAX_SIZE = 20 * 1024 * 1024; // 20MB

export async function GET(req: Request) {
  const g = await requireSession('viewer', req);
  if ('error' in g) return g.error;

  try {
    const docs = await db.bankDocument.findMany({
      where: g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { jobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return NextResponse.json({
      documents: docs.map((d) => ({
        id: d.id,
        filename: d.filename,
        mimeType: d.mimeType,
        size: d.size,
        pageCount: d.pageCount,
        status: d.status,
        createdAt: d.createdAt,
        lastJob: d.jobs[0]
          ? { id: d.jobs[0].id, status: d.jobs[0].status, questionCount: d.jobs[0].questionCount }
          : null,
      })),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  const g = await requireSession('teacher', req);
  if ('error' in g) return g.error;

  if (!rateLimit(`upload:${g.session.uid}`, 30, 300_000)) {
    return NextResponse.json({ error: 'عدد كبير من الرفعات — حاول بعد قليل' }, { status: 429 });
  }

  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'الملف مطلوب' }, { status: 400 });
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return NextResponse.json(
        { error: 'نوع ملف غير مدعوم — المسموح: PDF أو PNG أو JPG أو WEBP' },
        { status: 400 }
      );
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'حجم الملف يتجاوز ٢٠ ميجابايت' }, { status: 400 });
    }

    const id = `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const ext = file.type === 'application/pdf' ? 'pdf' : file.type.split('/')[1].replace('jpeg', 'jpg');
    const dir = path.join(process.cwd(), 'db', 'uploads');
    await mkdir(dir, { recursive: true });
    const storedPath = `db/uploads/${id}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(dir, `${id}.${ext}`), buf);

    const pageCountRaw = form.get('pageCount');
    const pageCount = typeof pageCountRaw === 'string' && /^\d+$/.test(pageCountRaw) ? parseInt(pageCountRaw, 10) : null;

    const doc = await db.bankDocument.create({
      data: {
        organizationId: g.session.orgId ?? null,
        uploadedByEmail: g.session.email,
        filename: file.name.slice(0, 200) || 'document',
        mimeType: file.type,
        size: file.size,
        pageCount,
        storedPath,
        status: 'ready',
      },
    });

    await audit({
      session: g.session,
      action: 'document.upload',
      entity: 'bankDocument',
      entityId: doc.id,
      meta: { filename: doc.filename, size: doc.size },
      req,
    });

    return NextResponse.json(
      { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, size: doc.size, pageCount: doc.pageCount },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
