// POST /api/assignments/:id/submissions/presign
// Step 1 of the direct-upload flow: validates the assignment (open, file
// mode, deadline) and the file, then hands the browser a SHORT-LIVED signed
// upload URL for the private "uploads" bucket. The browser PUTs the file
// straight to storage (bypassing Vercel's 4.5 MB function payload limit)
// and then POSTs /submissions with only the storage path.
// When Supabase is not configured the response is { mode: 'legacy' } and the
// client falls back to the classic base64 POST (local dev / self-host).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readJsonBody, serverError } from '../../../../_lib/shared';
import { safeExtension, sanitizeFileName } from '@/lib/qb/assignments';
import {
  STORAGE_MAX_BYTES,
  ensureBucket,
  storageConfigured,
  submissionObjectPath,
  supabaseAdmin,
} from '@/lib/storage/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJsonBody(req);
    const rawName = typeof body?.fileName === 'string' ? body.fileName : '';
    const fileSize = typeof body?.fileSize === 'number' ? Math.floor(body.fileSize) : 0;

    if (!rawName) {
      return NextResponse.json({ error: 'اسم الملف مطلوب' }, { status: 400 });
    }

    const assignment = await db.assignment.findUnique({ where: { id } });
    if (!assignment) {
      return NextResponse.json({ error: 'الواجب غير موجود' }, { status: 404 });
    }
    if (assignment.mode !== 'file') {
      return NextResponse.json(
        { error: 'هذا الواجب يُسلَّم كامتحان إلكتروني — لا يقبل ملفات' },
        { status: 400 }
      );
    }
    if (assignment.status !== 'open') {
      return NextResponse.json({ error: 'هذا الواجب مغلق حاليًا', code: 'CLOSED' }, { status: 403 });
    }
    const now = new Date();
    if (now > assignment.dueAt && assignment.latePolicy === 'block') {
      return NextResponse.json(
        { error: 'انتهى موعد التسليم — لم يُسمح بالتسليم المتأخر', code: 'LATE_BLOCKED' },
        { status: 403 }
      );
    }

    const fileName = sanitizeFileName(rawName);
    if (!safeExtension(fileName)) {
      return NextResponse.json({ error: 'نوع الملف غير مسموح' }, { status: 400 });
    }

    if (!storageConfigured()) {
      return NextResponse.json({ mode: 'legacy' });
    }

    if (fileSize > STORAGE_MAX_BYTES) {
      return NextResponse.json(
        { error: `حجم الملف يتجاوز الحد (${Math.round(STORAGE_MAX_BYTES / 1024 / 1024)} ميجابايت)` },
        { status: 413 }
      );
    }

    await ensureBucket();
    const path = submissionObjectPath(id, fileName);
    const { data, error } = await supabaseAdmin()
      .storage.from('uploads')
      .createSignedUploadUrl(path, { upsert: true });
    if (error || !data) {
      return NextResponse.json(
        serverError(error ?? new Error('createSignedUploadUrl failed')),
        { status: 502 }
      );
    }

    return NextResponse.json({
      mode: 'supabase',
      signedUrl: data.signedUrl,
      token: data.token,
      path: data.path,
      maxBytes: STORAGE_MAX_BYTES,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
