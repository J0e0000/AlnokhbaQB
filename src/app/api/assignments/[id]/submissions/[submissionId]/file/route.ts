// GET /api/assignments/:id/submissions/:submissionId/file
// Streams the uploaded file back to the teacher (PHASE 5).
// The DB stores only the relative PATH; the route re-resolves it and
// refuses anything escaping db/assignments/ (path-traversal guard).

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { serverError } from '../../../../../_lib/shared';
import { requireSession } from '../../../../../_lib/auth-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; submissionId: string }> };

const BASE_DIR = path.join(process.cwd(), 'db', 'assignments');

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain; charset=utf-8',
  zip: 'application/zip',
};

export async function GET(req: Request, ctx: Ctx) {
  try {
    const g = await requireSession('viewer', req);
    if ('error' in g) return g.error;
    const { id, submissionId } = await ctx.params;
    // scope through the assignment's organisation
    const assignment = await db.assignment.findUnique({
      where: { id },
      select: { organizationId: true },
    });
    if (
      !assignment ||
      (g.session.role !== 'super_admin' && assignment.organizationId !== g.session.orgId)
    ) {
      return NextResponse.json({ error: 'لا يوجد ملف لهذا التسليم' }, { status: 404 });
    }
    const submission = await db.assignmentSubmission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.assignmentId !== id || !submission.filePath) {
      return NextResponse.json({ error: 'لا يوجد ملف لهذا التسليم' }, { status: 404 });
    }

    const resolved = path.resolve(process.cwd(), submission.filePath);
    if (!resolved.startsWith(BASE_DIR + path.sep) || !existsSync(resolved)) {
      return NextResponse.json({ error: 'الملف غير متوفر على الخادم' }, { status: 404 });
    }

    const buffer = readFileSync(resolved);
    const ext = (path.extname(resolved).slice(1) || '').toLowerCase();
    const contentType = submission.fileType || MIME_BY_EXT[ext] || 'application/octet-stream';
    const downloadName = submission.fileName || `submission_${submissionId}.${ext || 'bin'}`;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
