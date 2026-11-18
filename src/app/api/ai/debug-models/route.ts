// TEMPORARY debug route — probes AI provider models for text/vision capability.
// DELETE AFTER USE. GET /api/ai/debug-models
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function probe(
  base: string,
  key: string,
  model: string,
  withImage: boolean
): Promise<string> {
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: 'Reply with the single word: OK' },
  ];
  if (withImage) content.push({ type: 'image_url', image_url: { url: TINY_PNG } });
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 16,
      }),
    });
    const text = await res.text();
    if (!res.ok) return `HTTP ${res.status}: ${text.slice(0, 160)}`;
    const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    return `OK → "${(json.choices?.[0]?.message?.content ?? '').slice(0, 60).trim()}"`;
  } catch (err) {
    return `FETCH_ERROR: ${String(err).slice(0, 120)}`;
  }
}

export async function GET() {
  const key = process.env.AI_API_KEY?.trim();
  const base = (process.env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!key) return NextResponse.json({ error: 'no AI_API_KEY' }, { status: 500 });

  const candidates = [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'allam-2-7b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
  ];

  const results: Record<string, { text?: string; vision?: string }> = {};
  for (const model of candidates) {
    results[model] = {
      text: await probe(base, key, model, false),
      vision: await probe(base, key, model, true),
    };
  }
  return NextResponse.json({ base, results });
}
