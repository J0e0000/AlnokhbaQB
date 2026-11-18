// GET /api/pw/jobs/[id]/result?file=<name> — download one result file.
// Once every result file of a job has been downloaded, the job directory is
// deleted immediately (privacy default). Anything left is swept after the TTL.

import { NextResponse } from 'next/server';
import { readResult } from '@/lib/pw/server/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const file = url.searchParams.get('file') ?? '';
  const found = await readResult(id, file);
  if (!found) {
    return NextResponse.json(
      { error: 'Result not found — it may have already been downloaded or expired.' },
      { status: 404 }
    );
  }
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  const type = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return new NextResponse(new Uint8Array(found.data), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(found.data.length),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(found.meta.name)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
