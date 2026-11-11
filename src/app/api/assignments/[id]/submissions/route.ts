// POST /api/assignments/:id/submissions
// File-submission mode (PHASE 5): { studentName, studentCode?, fileBase64, fileName, fileType }
//  • assignment must be open + mode=file
//  • server clock enforces dueAt: block → 403; allow → flagged late
//  • ≤10 MB, extension allowlist, stored under db/assignments/ (DB keeps the PATH only)
//  • resubmission by the same student replaces the file and clears the grade

import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readJsonBody, serverError } from '../../../_lib/shared';
import { requireSession } from '../../../_lib/auth-guard';
import { MAX_UPLOAD_BYTES, safeExtension, sanitizeFileName } from '@/lib/qb/assignments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const UPLOADS_DIR = path.join(process.cwd(), 'db', 'assignments');

// NOTE: min role 'viewer' — file submission is the STUDENT-side action of the
// assignments flow (any authenticated org member may submit their homework).
export async function POST(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const { id } = await ctx.params;
    const body = await readJsonBody(req);

    const studentName = typeof body?.studentName === 'string' ? body.studentName.trim() : '';
    const studentCode =
      typeof body?.studentCode === 'string' && body.studentCode.trim() ? body.studentCode.trim() : null;
    const fileBase64 = typeof body?.fileBase64 === 'string' ? body.fileBase64 : '';
    const rawName = typeof body?.fileName === 'string' ? body.fileName : '';
    const fileType =
      typeof body?.fileType === 'string' && body.fileType.trim() ? body.fileType.trim() : null;

    if (!studentName || !fileBase64 || !rawName) {
      return NextResponse.json(
        { error: 'اسم الطالب وملف التسليم مطلوبان' },
        { status: 400 }
      );
    }

    const assignment = await db.assignment.findUnique({ where: { id } });
    if (!assignment) {
      return NextResponse.json({ error: 'الواجب غير موجود' }, { status: 404 });
    }
    if (g.session.role !== 'super_admin' && assignment.organizationId !== g.session.orgId) {
      return NextResponse.json(
        { error: 'غير موجود أو لا تملك صلاحية الوصول' },
        { status: 404 }
      );
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

    // validate + decode the upload
    const fileName = sanitizeFileName(rawName);
    const ext = safeExtension(fileName);
    if (!ext) {
      return NextResponse.json({ error: 'نوع الملف غير مسموح' }, { status: 400 });
    }
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

    // resubmission: same student (name+code, file-mode row) replaces the file
    const existing = await db.assignmentSubmission.findFirst({
      where: { assignmentId: id, studentName, studentCode, attemptId: null },
      orderBy: { submittedAt: 'desc' },
    });
    if (existing?.filePath) {
      try {
        unlinkSync(path.join(process.cwd(), existing.filePath));
      } catch {
        /* old file already gone — fine */
      }
    }

    mkdirSync(UPLOADS_DIR, { recursive: true });
    const storedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = path.join('db', 'assignments', storedName);
    writeFileSync(path.join(process.cwd(), filePath), buffer);

    const data = {
      fileName,
      fileType,
      fileSize: buffer.length,
      filePath,
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
