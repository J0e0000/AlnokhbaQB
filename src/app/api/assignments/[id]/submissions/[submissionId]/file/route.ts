// GET /api/assignments/:id/submissions/:submissionId/file
// Streams the uploaded file back to the teacher (PHASE 5).
//  • Supabase-backed submission (storagePath set) → 302 redirect to a
//    SHORT-LIVED signed URL (createSignedUrl, 60 s) — the browser fetches
//    the bytes straight from storage.
//  • Legacy local-disk submission → streamed from db/assignments/ exactly
//    as before (path-traversal guard intact).

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { serverError } from '../../../../../_lib/shared';
import { SUPABASE_BUCKET, storageConfigured, supabaseAdmin } from '@/lib/storage/supabase';

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

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id, submissionId } = await ctx.params;
    const submission = await db.assignmentSubmission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.assignmentId !== id) {
      return NextResponse.json({ error: 'لا يوجد ملف لهذا التسليم' }, { status: 404 });
    }

    const ext = (path.extname(submission.fileName ?? '').slice(1) || '').toLowerCase();
    const downloadName = submission.fileName || `submission_${submissionId}.${ext || 'bin'}`;

    // ---- Supabase-backed: 302 to a short-lived signed URL ----
    if (submission.storagePath) {
      if (!storageConfigured()) {
        return NextResponse.json(
          { error: 'خدمة التخزين غير مهيأة على الخادم (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' },
          { status: 503 }
        );
      }
      const { data, error } = await supabaseAdmin()
        .storage.from(SUPABASE_BUCKET)
        .createSignedUrl(submission.storagePath, 60, { download: downloadName });
      if (error || !data?.signedUrl) {
        return NextResponse.json(
          { error: 'تعذر توليد رابط تنزيل مؤقت للملف' },
          { status: 502 }
        );
      }
      return NextResponse.redirect(data.signedUrl, 302);
    }

    // ---- legacy local-disk streaming ----
    if (!submission.filePath) {
      return NextResponse.json({ error: 'لا يوجد ملف لهذا التسليم' }, { status: 404 });
    }
    const resolved = path.resolve(process.cwd(), submission.filePath);
    if (!resolved.startsWith(BASE_DIR + path.sep) || !existsSync(resolved)) {
      return NextResponse.json({ error: 'الملف غير متوفر على الخادم' }, { status: 404 });
    }

    const buffer = readFileSync(resolved);
    const contentType = submission.fileType || MIME_BY_EXT[ext] || 'application/octet-stream';

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
