// POST /api/assignments/:id/submissions
// File-submission mode (PHASE 5). Two transports:
//  A) storage (Vercel): { studentName, studentCode?, storagePath, fileName, fileType, fileSize }
//     — the browser already uploaded the file DIRECTLY to the private
//       "uploads" bucket via a signed URL (see ./presign) so no file bytes
//       flow through this function. The DB keeps the storage PATH only.
//  B) legacy (local/self-host): { studentName, studentCode?, fileBase64, fileName, fileType }
//     — base64 body, stored under db/assignments/ (DB keeps the PATH only).
// Rules for both: assignment open + mode=file, server-clock deadline
// (block → 403 / allow → flagged late), extension allowlist, resubmission
// by the same student replaces the file and clears the grade.

import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readJsonBody, serverError } from '../../../_lib/shared';
import { MAX_UPLOAD_BYTES, safeExtension, sanitizeFileName } from '@/lib/qb/assignments';
import {
  STORAGE_MAX_BYTES,
  isOwnSubmissionPath,
  removeSubmissionObject,
  storageConfigured,
  supabaseAdmin,
} from '@/lib/storage/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const UPLOADS_DIR = path.join(process.cwd(), 'db', 'assignments');

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJsonBody(req);

    const studentName = typeof body?.studentName === 'string' ? body.studentName.trim() : '';
    const studentCode =
      typeof body?.studentCode === 'string' && body.studentCode.trim() ? body.studentCode.trim() : null;
    const rawName = typeof body?.fileName === 'string' ? body.fileName : '';
    const fileType =
      typeof body?.fileType === 'string' && body.fileType.trim() ? body.fileType.trim() : null;

    if (!studentName || !rawName) {
      return NextResponse.json(
        { error: 'اسم الطالب وملف التسليم مطلوبان' },
        { status: 400 }
      );
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

    // server-side deadline
    const now = new Date();
    const late = now > assignment.dueAt;
    if (late && assignment.latePolicy === 'block') {
      return NextResponse.json(
        { error: 'انتهى موعد التسليم — لم يُسمح بالتسليم المتأخر', code: 'LATE_BLOCKED' },
        { status: 403 }
      );
    }

    const fileName = sanitizeFileName(rawName);
    const ext = safeExtension(fileName);
    if (!ext) {
      return NextResponse.json({ error: 'نوع الملف غير مسموح' }, { status: 400 });
    }

    const storagePath = typeof body?.storagePath === 'string' ? body.storagePath.trim() : '';
    const fileBase64 = typeof body?.fileBase64 === 'string' ? body.fileBase64 : '';
    if (!storagePath && !fileBase64) {
      return NextResponse.json(
        { error: 'الملف مطلوب (storagePath للرفع المباشر أو fileBase64 للوضع التقليدي)' },
        { status: 400 }
      );
    }

    let finalStoragePath: string | null = null;
    let finalFilePath: string | null = null;
    let fileSize = 0;

    if (storagePath) {
      // ---- transport A: direct-to-storage (the bytes never pass through here) ----
      if (!storageConfigured()) {
        return NextResponse.json(
          { error: 'خدمة التخزين غير مهيأة على الخادم (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' },
          { status: 503 }
        );
      }
      if (!isOwnSubmissionPath(id, storagePath)) {
        return NextResponse.json({ error: 'مسار تخزين غير صالح' }, { status: 400 });
      }
      const declaredSize = typeof body?.fileSize === 'number' ? Math.floor(body.fileSize) : 0;
      if (declaredSize <= 0) {
        return NextResponse.json({ error: 'الملف فارغ' }, { status: 400 });
      }
      if (declaredSize > STORAGE_MAX_BYTES) {
        return NextResponse.json(
          { error: `حجم الملف يتجاوز الحد (${Math.round(STORAGE_MAX_BYTES / 1024 / 1024)} ميجابايت)` },
          { status: 413 }
        );
      }
      // the object must actually exist in the bucket before the ledger row
      const sb = supabaseAdmin();
      const parentDir = storagePath.split('/').slice(0, -1).join('/');
      const objectName = storagePath.split('/').pop() ?? '';
      const { data: obj, error: headErr } = await sb.storage
        .from('uploads')
        .list(parentDir, { search: objectName });
      if (headErr || !obj?.some((o) => o.name === objectName)) {
        return NextResponse.json(
          { error: 'لم يُعثر على الملف في التخزين — أعد الرفع ثم أعد المحاولة' },
          { status: 400 }
        );
      }
      finalStoragePath = storagePath;
      fileSize = declaredSize;
    } else {
      // ---- transport B: legacy base64 → local disk ----
      let buffer: Buffer;
      try {
        buffer = Buffer.from(fileBase64, 'base64');
      } catch {
        return NextResponse.json({ error: 'تعذر قراءة الملف' }, { status: 400 });
      }
      if (buffer.length === 0) {
        return NextResponse.json({ error: 'الملف فارغ' }, { status: 400 });
      }
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `حجم الملف يتجاوز الحد (${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} ميجابايت)` },
          { status: 413 }
        );
      }
      mkdirSync(UPLOADS_DIR, { recursive: true });
      const storedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      finalFilePath = path.join('db', 'assignments', storedName);
      writeFileSync(path.join(process.cwd(), finalFilePath), buffer);
      fileSize = buffer.length;
    }

    // resubmission: same student (name+code, file-mode row) replaces the file
    const existing = await db.assignmentSubmission.findFirst({
      where: { assignmentId: id, studentName, studentCode, attemptId: null },
      orderBy: { submittedAt: 'desc' },
    });
    if (existing?.storagePath) {
      await removeSubmissionObject(existing.storagePath);
    }
    if (existing?.filePath) {
      try {
        unlinkSync(path.join(process.cwd(), existing.filePath));
      } catch {
        /* old file already gone — fine */
      }
    }

    const data = {
      fileName,
      fileType,
      fileSize,
      storagePath: finalStoragePath,
      filePath: finalFilePath,
      late,
      status: 'submitted' as const,
      submittedAt: now,
      score: null,
      maxScore: null,
      feedback: null,
    };

    const submission = existing
      ? await db.assignmentSubmission.update({ where: { id: existing.id }, data })
      : await db.assignmentSubmission.create({
          data: { ...data, assignmentId: id, studentName, studentCode },
        });

    return NextResponse.json(
      {
        submission: {
          id: submission.id,
          studentName: submission.studentName,
          late: submission.late,
          status: submission.status,
          submittedAt: submission.submittedAt.toISOString(),
          fileName: submission.fileName,
          fileSize: submission.fileSize,
        },
        late,
      },
      { status: existing ? 200 : 201 }
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
