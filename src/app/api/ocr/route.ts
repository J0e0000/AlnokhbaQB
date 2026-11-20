// POST /api/ocr { imageBase64, lang: 'eng'|'ara' }
// PHASE 8: runs the DocumentProcessor pipeline (src/lib/qb/ocr/engine.ts).
// Response: { ok, engine, lang, text, confidence, needsReview } — needsReview
// is always true for the current engines (no self-assessed confidence), so
// OCR output is visibly flagged for the mandatory teacher review.

import { NextResponse } from 'next/server';
import { processDocument } from '@/lib/qb/ocr/engine';
import { clientIp, rateLimit } from '@/lib/auth/ratelimit';
import { readJsonBody, serverError, stripDataUrl } from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // heavy OCR route — 30 req/min per client (auth gate)
  const rl = await rateLimit(`ocr:${clientIp(req)}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'عدد كبير من الطلبات — خفّف السرعة وحاول بعد قليل' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  try {
    const body = await readJsonBody(req);
    const rawImage = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
    if (!rawImage) {
      return NextResponse.json({ error: 'الصورة مطلوبة (imageBase64)' }, { status: 400 });
    }
    const lang = body?.lang === 'eng' ? 'eng' : 'ara';
    const { base64, mime } = stripDataUrl(rawImage);

    const result = await processDocument({ base64, mime, lang });

    if (result.ok && result.text) {
      return NextResponse.json({
        ok: true,
        engine: result.engine,
        lang,
        text: result.text,
        confidence: result.confidence,
        needsReview: result.needsReview,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error:
          lang === 'ara'
            ? 'فشل التعرف الضوئي باللغة العربية في المحرك وفي النموذج البديل'
            : result.error || 'فشل التعرف الضوئي في المحرك',
        stage: result.stage ?? 'engineError',
        details: result.error,
        needsReview: true,
      },
      result.stage === 'noProcessor' || result.stage === 'engineUnreachable' ? { status: 503 } : { status: 502 }
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
