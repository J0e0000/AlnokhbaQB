// POST /api/ocr { imageBase64, lang: 'eng'|'ara' }
// PHASE 8: runs the DocumentProcessor pipeline (src/lib/qb/ocr/engine.ts).
// Response: { ok, engine, lang, text, confidence, needsReview } — needsReview
// is always true for the current engines (no self-assessed confidence), so
// OCR output is visibly flagged for the mandatory teacher review.

import { NextResponse } from 'next/server';
import { processDocument } from '@/lib/qb/ocr/engine';
import { readJsonBody, serverError, stripDataUrl } from '../_lib/shared';
import { requireSession } from '../_lib/auth-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// NOTE: role check only — OCR produces no persisted org data (extraction → teacher).
export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
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
