// POST /api/pw/ai — AI tools (summarize / translate / markdown).
// Accepts EXTRACTED TEXT (never files — files stay in the browser), streams
// the model output back as SSE. The SDK key never leaves the server.

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 240;

const MAX_CHARS = 80_000;

interface AiBody {
  mode?: string;
  text?: string;
  length?: string;
  target?: string;
}

function buildMessages(mode: string, text: string, length?: string, target?: string) {
  const cap =
    length === 'brief'
      ? 'Keep it brief: a 3-4 sentence overview plus at most 5 key points.'
      : length === 'detailed'
        ? 'Be detailed: cover the document section by section.'
        : 'Aim for a compact but complete summary: overview paragraph, key points, notable figures/claims, and any action items.';

  switch (mode) {
    case 'summarize':
      return {
        system:
          'You are an expert document analyst. Summarize documents faithfully — never invent facts. Use clean Markdown with short headings and bullet points.',
        user: `Summarize the following document. ${cap}\n\nUse this structure:\n## Overview\n## Key points\n## Details worth noting\n\nDocument text:\n"""\n${text}\n"""`,
      };
    case 'translate':
      return {
        system:
          'You are a professional translator. Translate faithfully, preserving paragraph breaks, list structure and headings. Output ONLY the translation, no commentary.',
        user: `Translate the following document text into ${target || 'English'}. Keep the same paragraph/heading structure. Do not summarize — translate everything.\n\nDocument text:\n"""\n${text}\n"""`,
      };
    case 'markdown':
      return {
        system:
          'You convert documents to Markdown. Preserve the hierarchy: use # for the title, ## for major sections, ### for subsections, lists for enumerations and Markdown tables for tabular data. Output ONLY Markdown, no commentary.',
        user: `Convert the following document text into well-structured Markdown. Infer headings from context (numbers, capitalization, short lines). Preserve the reading order.\n\nDocument text:\n"""\n${text}\n"""`,
      };
    default:
      throw new Error('Unknown AI mode');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  let body: AiBody;
  try {
    body = (await req.json()) as AiBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const mode = String(body.mode ?? '');
  const text = String(body.text ?? '');
  if (!['summarize', 'translate', 'markdown'].includes(mode)) {
    return NextResponse.json({ error: 'Unknown AI mode' }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ error: 'The document has no extractable text — try the OCR tool first.' }, { status: 400 });
  }
  const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const truncationNote =
    text.length > MAX_CHARS
      ? `\n\n[Note: the document is long; only the first ${MAX_CHARS} characters were analysed.]`
      : '';

  let system: string, user: string;
  try {
    ({ system, user } = buildMessages(mode, clipped, body.length, body.target));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Bad request' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const mod = (await import('z-ai-web-dev-sdk')) as unknown as {
          default: { create: () => Promise<AiClient> };
        };
        const zai = await mod.default.create();
        send('status', { message: 'Thinking…' });

        let full = '';
        // Try true streaming first; fall back to one-shot + simulated chunks.
        try {
          const completion = await zai.chat.completions.create({
            messages: [
              { role: 'assistant', content: system },
              { role: 'user', content: user },
            ],
            stream: true,
            thinking: { type: 'disabled' },
          });
          const iterable = completion as unknown as AsyncIterable<StreamChunk>;
          const iteratorFn = (iterable as { [Symbol.asyncIterator]?: () => AsyncIterator<StreamChunk> })[
            Symbol.asyncIterator
          ];
          if (typeof iteratorFn === 'function') {
            for await (const chunk of iterable) {
              const delta = chunk?.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                full += delta;
                send('delta', { text: delta });
              }
            }
          }
        } catch {
          /* fall through to non-streaming */
        }
        if (!full.trim()) {
          const completion = (await zai.chat.completions.create({
            messages: [
              { role: 'assistant', content: system },
              { role: 'user', content: user },
            ],
            thinking: { type: 'disabled' },
          })) as { choices?: Array<{ message?: { content?: string } }> };
          full = completion.choices?.[0]?.message?.content ?? '';
          const CHUNK = 96;
          for (let i = 0; i < full.length; i += CHUNK) {
            send('delta', { text: full.slice(i, i + CHUNK) });
            await sleep(15);
          }
        }
        if (!full.trim()) {
          send('error', { message: 'The model returned an empty response — please retry.' });
        } else {
          if (truncationNote) send('delta', { text: truncationNote });
          send('done', { text: full });
        }
      } catch (err) {
        send('error', {
          message: err instanceof Error ? err.message : 'The AI service is unavailable — please retry.',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

interface AiClient {
  chat: {
    completions: {
      create: (params: unknown) => Promise<unknown>;
    };
  };
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}
