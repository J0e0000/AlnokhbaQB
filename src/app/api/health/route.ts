// GET /api/health → { ok, db, pdf, omrEngine }

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getBrowserHealth, warmBrowser } from '@/lib/pdf/pool';
import { engineHealth } from '@/lib/omr/client';
import { serverError } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// serverless headroom: chromium extraction + first launch + render can exceed the 10s default
export const maxDuration = 60;

export async function GET() {
  try {
    // Pre-warm the PDF browser pool (fire-and-forget): the app shell polls
    // /api/health on mount, so the browser is launching BEFORE the user's
    // first "تنزيل PDF" click instead of paying a 2-5s cold start inside it.
    warmBrowser();

    let dbOk = false;
    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const pdf = getBrowserHealth();
    const omrEngine = await engineHealth(2000);

    return NextResponse.json({
      ok: dbOk,
      db: dbOk,
      pdf,
      omrEngine: {
        ok: omrEngine.ok,
        ...(omrEngine.ok ? {} : { error: omrEngine.error ?? 'OMR engine unreachable' }),
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
