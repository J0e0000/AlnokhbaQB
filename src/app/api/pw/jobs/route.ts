// POST /api/pw/jobs — create a server-side processing job (multipart form).

import { NextResponse } from 'next/server';
import { createJob, checkRateLimit } from '@/lib/pw/server/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      'local';
    const form = await req.formData();
    const tool = String(form.get('tool') ?? '');
    if (!tool) {
      return NextResponse.json({ error: 'Missing tool id' }, { status: 400 });
    }
    let opts: Record<string, string | number | boolean> = {};
    const rawOpts = form.get('options');
    if (typeof rawOpts === 'string' && rawOpts.trim()) {
      try {
        const parsed = JSON.parse(rawOpts) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            opts[k] = v;
          }
        }
      } catch {
        return NextResponse.json({ error: 'Invalid options payload' }, { status: 400 });
      }
    }
    const entries: { name: string; mime: string; buf: Buffer }[] = [];
    for (const value of form.getAll('files')) {
      if (value instanceof File) {
        const buf = Buffer.from(await value.arrayBuffer());
        entries.push({ name: value.name || 'file', mime: value.type || '', buf });
      }
    }

    checkRateLimit(ip);
    const job = await createJob({ tool, ip, entries, opts });
    return NextResponse.json({ id: job.id }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not create the job';
    const status = /limit|too large|does not look|No files|Unknown tool|Invalid options/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
