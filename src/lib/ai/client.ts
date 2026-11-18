// ============================================================
// ALNOKHBA QB — unified AI gateway (server-only)
//
// ONE place for every model call (vision OCR / question extraction /
// question generation / document tools). Two backends:
//
//  1. ENV MODE  — AI_API_KEY is set → plain fetch against ANY
//     OpenAI-compatible provider (OpenAI, OpenRouter, Google Gemini
//     OpenAI-compat, Z.ai public API, Groq, Together, Ollama…).
//     This is what makes the app work on Vercel: the sandbox's
//     built-in z-ai endpoint resolves to private IPs (172.25.x.x)
//     that serverless hosts can never reach.
//  2. ZAI MODE  — no AI_API_KEY → fall back to z-ai-web-dev-sdk
//     (works only inside the Z.ai dev sandbox; used for local dev).
//
// If neither backend is available every call throws
// AiNotConfiguredError whose Arabic message tells the admin exactly
// which env vars to set — instead of a misleading "retry / higher
// image quality" toast.
// ============================================================

import { ensureZaiConfig } from '@/lib/zai-config';

// ---------- errors ----------

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      'خدمة الذكاء الاصطناعي غير مهيأة على الخادم — أضف AI_API_KEY (وAI_BASE_URL إن لزم) في إعدادات البيئة ثم أعد النشر'
    );
    this.name = 'AiNotConfiguredError';
  }
}

export class AiProviderError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
  }
}

// ---------- config ----------

export type AiMode = 'env' | 'zai' | 'none';

export interface AiStatus {
  mode: AiMode;
  /** Base URL actually used in env mode (key never included). */
  baseUrl?: string;
  /** Vision/chat model in env mode. */
  model?: string;
}

const DEFAULT_MODEL = 'gpt-4o-mini';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** Cheap config introspection — no network calls, safe for /api/health. */
export function aiStatus(): AiStatus {
  const key = process.env.AI_API_KEY?.trim();
  if (key) {
    return {
      mode: 'env',
      baseUrl: trimSlash(process.env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1'),
      model:
        process.env.AI_VISION_MODEL?.trim() ||
        process.env.AI_CHAT_MODEL?.trim() ||
        process.env.AI_MODEL?.trim() ||
        DEFAULT_MODEL,
    };
  }
  if (ensureZaiConfig()) return { mode: 'zai' };
  return { mode: 'none' };
}

function assertConfigured(): { baseUrl: string; apiKey: string; visionModel: string; chatModel: string } {
  const key = process.env.AI_API_KEY?.trim();
  if (key) {
    const baseUrl = trimSlash(process.env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1');
    const visionModel =
      process.env.AI_VISION_MODEL?.trim() || process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
    const chatModel =
      process.env.AI_CHAT_MODEL?.trim() || process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
    return { baseUrl, apiKey: key, visionModel, chatModel };
  }
  if (ensureZaiConfig()) {
    // z-ai sandbox mode is handled by the SDK paths below
    return { baseUrl: '', apiKey: '', visionModel: '', chatModel: '' };
  }
  throw new AiNotConfiguredError();
}

// ---------- low-level helpers ----------

interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

async function postChat(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<{ text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `انتهت مهلة الاتصال بعد ${Math.round(timeoutMs / 1000)} ثانية`
        : `تعذر الاتصال بمزود الذكاء الاصطناعي (${baseUrl})`;
    throw new AiProviderError(reason, 504);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new AiProviderError(
      `مزود الذكاء الاصطناعي أعاد خطأ ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status >= 500 ? 502 : 400
    );
  }

  const json = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const text = json?.choices?.[0]?.message?.content ?? '';
  return { text };
}

// ---------- z-ai sandbox mode (dev only) ----------

type ZaiClient = {
  chat: {
    completions: {
      create: (params: unknown) => Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
      createVision: (params: unknown) => Promise<{
        choices?: Array<{ message?: { content?: string } }>;
      }>;
    };
  };
};

async function getZai(): Promise<ZaiClient> {
  const mod = (await import('z-ai-web-dev-sdk')) as unknown as {
    default: { create: () => Promise<ZaiClient> };
  };
  return mod.default.create();
}

// ---------- public API ----------

interface VisionParams {
  prompt: string;
  /** data:image/… URL */
  dataUrl: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** One-shot vision call: image + instruction → text. */
export async function aiVisionText({
  prompt,
  dataUrl,
  maxTokens = 4096,
  timeoutMs = 120_000,
}: VisionParams): Promise<string> {
  const cfg = assertConfigured();
  if (cfg.apiKey) {
    const { text } = await postChat(
      cfg.baseUrl,
      cfg.apiKey,
      {
        model: cfg.visionModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: maxTokens,
      },
      timeoutMs
    );
    return text;
  }
  const zai = await getZai();
  const completion = await zai.chat.completions.createVision({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    thinking: { type: 'disabled' },
  });
  return completion.choices?.[0]?.message?.content ?? '';
}

interface ChatParams {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** One-shot text call: system + user → text. */
export async function aiChatText({
  system,
  user,
  maxTokens = 4096,
  timeoutMs = 120_000,
}: ChatParams): Promise<string> {
  const cfg = assertConfigured();
  if (cfg.apiKey) {
    const { text } = await postChat(
      cfg.baseUrl,
      cfg.apiKey,
      {
        model: cfg.chatModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
      },
      timeoutMs
    );
    return text;
  }
  const zai = await getZai();
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: system },
      { role: 'user', content: user },
    ],
    thinking: { type: 'disabled' },
  });
  return completion.choices?.[0]?.message?.content ?? '';
}
