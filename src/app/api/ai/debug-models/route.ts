// TEMPORARY debug route — lists models available to the configured AI key.
// DELETE AFTER USE. GET /api/ai/debug-models
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const key = process.env.AI_API_KEY?.trim();
  const base = (process.env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!key) return NextResponse.json({ error: 'no AI_API_KEY' }, { status: 500 });
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 500);
    }
    return NextResponse.json({ status: res.status, body: parsed });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
