// GET /api/ai/ping?models=a,b,c&vision=1&maxTokens=64&timeoutMs=30000
// Server-side AI provider diagnostics (teacher-only).
//
// Makes ONE raw chat completion per requested model against the
// configured OpenAI-compatible endpoint and reports status / latency /
// first bytes of the reply or the provider error. Used to verify which
// model names work with the configured AI_API_KEY without touching the
// real feature endpoints. Costs a few tokens per model — keep
// maxTokens small (default 64).
//
// Examples:
//   /api/ai/ping                                   → default model from env
//   /api/ai/ping?models=gemini-3.8-flash,gemini-flash-latest
//   /api/ai/ping?vision=1                          → also verify image request shape
//
// NOTE: only the env backend (AI_API_KEY) is pinged; the z-ai sandbox
// backend is dev-only and always reachable locally.

import { NextResponse } from 'next/server';
import { requireSession } from '../../_lib/auth-guard';
import { aiStatus } from '@/lib/ai/client';

export const runtime = 'nodejs';
export const maxDuration = 120;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 64;
// 1×1 transparent PNG (67 bytes) — enough to prove the provider accepts
// image_url content without doing real OCR work.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

interface PingResult {
  model: string;
  ok: boolean;
  latencyMs: number;
  httpStatus?: number;
  reply?: string;
  error?: string;
}

async function pingModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  opts: { vision: boolean; maxTokens: number; timeoutMs: number }
): Promise<PingResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: 'Reply with exactly: PONG' },
    ];
    if (opts.vision) content.push({ type: 'image_url', image_url: { url: TINY_PNG } });

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: opts.maxTokens,
      }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - started;
    const bodyText = (await res.text().catch(() => '')).slice(0, 600);
    if (!res.ok) {
      return { model, ok: false, latencyMs, httpStatus: res.status, error: bodyText };
    }
    let reply = '';
    try {
      const json = JSON.parse(bodyText) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      reply = json?.choices?.[0]?.message?.content ?? bodyText;
    } catch {
      reply = bodyText;
    }
    return { model, ok: true, latencyMs, httpStatus: res.status, reply: reply.slice(0, 200) };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? `timeout after ${opts.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { model, ok: false, latencyMs, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request) {
  const g = await requireSession('teacher', req);
  if ('error' in g) return g.error;

  const url = new URL(req.url);
  const status = aiStatus();
  if (status.mode !== 'env' || !process.env.AI_API_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          'لا يوجد مزود خارجي مهيأ (AI_API_KEY غير موجود) — وضع التطوير يعتمد على النموذج المدمج ولا يحتاج فحص',
        mode: status.mode,
      },
      { status: 400 }
    );
  }

  const baseUrl = status.baseUrl!;
  const apiKey = process.env.AI_API_KEY.trim();
  const requested = (url.searchParams.get('models') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const models = requested.length ? requested.slice(0, 5) : [status.model ?? 'gpt-4o-mini'];
  const vision = url.searchParams.get('vision') === '1';
  const maxTokens = Math.min(Number(url.searchParams.get('maxTokens')) || DEFAULT_MAX_TOKENS, 512);
  const timeoutMs = Math.min(Number(url.searchParams.get('timeoutMs')) || DEFAULT_TIMEOUT_MS, 120_000);

  const results: PingResult[] = [];
  for (const model of models) {
    results.push(await pingModel(baseUrl, apiKey, model, { vision, maxTokens, timeoutMs }));
  }

  return NextResponse.json({
    baseUrl,
    vision,
    results,
    allOk: results.every((r) => r.ok),
  });
}
