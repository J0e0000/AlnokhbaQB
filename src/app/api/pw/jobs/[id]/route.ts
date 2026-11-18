// GET /api/pw/jobs/[id] — poll job status.

import { NextResponse } from 'next/server';
import { getJob, jobStatusView } from '@/lib/pw/server/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: 'Job not found or expired' }, { status: 404 });
  }
  return NextResponse.json(jobStatusView(job));
}
