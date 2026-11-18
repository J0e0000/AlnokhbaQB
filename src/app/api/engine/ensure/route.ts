// POST /api/engine/ensure → make sure the local OMR engine sidecar is up.
//
// Dev/self-host helper: when the Python engine (:3032) is not running
// (fresh machine, crashed watcher), this spawns it as a detached child of
// the Next.js server and waits for /health. Requires a teacher session.
// On Vercel this is a no-op 501 — the engine there is omr-service/ or an
// external OMR_ENGINE_URL, not a local child process.
//
// GET → passive status only (no spawn).

import { NextResponse } from 'next/server';
import { ensureEngine, engineHealthy } from '@/lib/omr/supervisor';
import { OMR_ENGINE_URL } from '@/lib/omr/client';
import { requireSession } from '../../_lib/auth-guard';
import { serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  try {
    const healthy = await engineHealthy();
    return NextResponse.json({ ok: healthy, engineUrl: OMR_ENGINE_URL });
  } catch (err) {
    return NextResponse.json({ ...serverError(err), ok: false }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    if (process.env.VERCEL) {
      return NextResponse.json(
        {
          ok: false,
          error: 'على Vercel يعمل المحرك كخدمة منفصلة (/api/omr) — لا حاجة للتشغيل التلقائي هنا.',
          action: 'disabled',
        },
        { status: 501 },
      );
    }
    const result = await ensureEngine();
    return NextResponse.json(result, { status: result.ok ? 200 : 503 });
  } catch (err) {
    return NextResponse.json({ ...serverError(err), ok: false }, { status: 500 });
  }
}
