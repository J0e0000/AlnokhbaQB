// GET /api/health → { ok, db, pdf, omrEngine }
// Public by design, but UNAUTHENTICATED callers get { ok } only — the db /
// pdf / omrEngine internals require a valid session (see src/proxy.ts).

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { getBrowserHealth, warmBrowser } from '@/lib/pdf/pool';
import { engineHealth } from '@/lib/omr/client';
import { serverError } from '../_lib/shared';
import { authConfigured, SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

    // Public, minimal payload for unauthenticated callers.
    // (When the auth gate is not configured yet, the proxy is fail-open and
    // the full payload stays available — nothing is protected at that point.)
    const authed =
      !authConfigured() ||
      (await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value));
    if (!authed) {
      return NextResponse.json({ ok: dbOk });
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
