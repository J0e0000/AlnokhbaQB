// AI handwriting transcription for FormScan OCR regions.
// POST { image: dataURL } → { text }
// The vision model is called SERVER-SIDE only — the SDK key never reaches the
// browser, and the image is not persisted anywhere.

import { NextResponse } from 'next/server';
import { requireSession } from '../../_lib/auth-guard';
import { rateLimit, serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IMAGE_BYTES = 4_500_000; // ~4.5 MB dataURL

export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;

    if (!rateLimit(`transcribe:${g.session.uid}`, 30, 60_000)) {
      return NextResponse.json({ error: 'حد الطلبات للنموذج — انتقل بعد قليل' }, { status: 429 });
    }

    const body = (await req.json().catch(() => null)) as { image?: string } | null;
    const image = body?.image ?? '';
    if (!image.startsWith('data:image/')) {
      return NextResponse.json({ error: 'يجب إرسال صورة بصيغة dataURL' }, { status: 400 });
    }
    if (image.length > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: 'الصورة كبيرة جدًا (الحد 4 ميجابايت)' }, { status: 413 });
    }

    const mod = (await import('z-ai-web-dev-sdk')) as unknown as {
      default: {
        create: () => Promise<{
          chat: {
            completions: {
              createVision: (params: unknown) => Promise<{
                choices?: Array<{ message?: { content?: string } }>;
              }>;
            };
          };
        }>;
      };
    };
    const zai = await mod.default.create();
    const completion = await zai.chat.completions.createVision({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe ALL text visible in this cropped form region, exactly as written. ' +
                'It may be handwritten or printed, in Arabic or English. Output ONLY the transcription — ' +
                'no commentary, no markdown. If nothing is legible, output an empty string.',
            },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    });
    const text = (completion.choices?.[0]?.message?.content ?? '').trim();
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
