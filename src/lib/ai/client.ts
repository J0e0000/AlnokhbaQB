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
  /** HTTP status returned by the provider itself (undefined for timeouts). */
  readonly rawStatus?: number;
  constructor(message: string, status: number, rawStatus?: number) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
    this.rawStatus = rawStatus;
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

/** AI_FALLBACK_MODEL accepts a comma-separated list of candidate models. */
function splitFallbacks(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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

function assertConfigured(): {
  baseUrl: string;
  apiKey: string;
  visionModel: string;
  chatModel: string;
  fallbackModel?: string;
} {
  const key = process.env.AI_API_KEY?.trim();
  if (key) {
    const baseUrl = trimSlash(process.env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1');
    const visionModel =
      process.env.AI_VISION_MODEL?.trim() || process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
    const chatModel =
      process.env.AI_CHAT_MODEL?.trim() || process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
    const fallbackModel = process.env.AI_FALLBACK_MODEL?.trim() || undefined;
    return { baseUrl, apiKey: key, visionModel, chatModel, fallbackModel };
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

/**
 * Google Gemini thinking models burn time (and max_tokens) on hidden
 * reasoning. Cap it to "low" so extraction/generation finish well inside
 * the request timeout. Only sent for the Gemini compat endpoint — other
 * providers may reject the field.
 */
function geminiExtras(baseUrl: string): Record<string, unknown> {
  return baseUrl.includes('generativelanguage.googleapis.com')
    ? { reasoning_effort: 'low' }
    : {};
}

/**
 * Runs a chat call with deadline-budgeted resilience:
 *  1. Provider rejects `reasoning_effort` (400) → retry once without it.
 *  2. Primary model rate-limited (429) / overloaded (503) → wait ~1.5 s and
 *     retry the same model once (transient spikes clear in seconds).
 *  3. Still failing → try each AI_FALLBACK_MODEL (comma-separated) in order.
 * Every attempt shares ONE overall deadline (`timeoutMs`) so the worst case
 * never exceeds the caller's budget.
 */
async function postChatResilient(
  cfg: { baseUrl: string; apiKey: string; model: string; fallbackModel?: string },
  /** `softOpts=false` rebuilds the body WITHOUT optional fields (detail /
   *  temperature) — used as the automatic fallback when a provider 400s. */
  buildBody: (
    model: string,
    extras: Record<string, unknown>,
    softOpts: boolean
  ) => Record<string, unknown>,
  timeoutMs: number
): Promise<{ text: string; model: string }> {
  const extras = geminiExtras(cfg.baseUrl);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const chain = [cfg.model, ...splitFallbacks(cfg.fallbackModel).filter((m) => m && m !== cfg.model)];

  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const budget = Math.min(remaining(), timeoutMs);
    if (budget < 5_000) break; // no point starting a call that cannot finish
    const attempt = (withExtras: boolean, withSoftOpts = true) =>
      postChat(
        cfg.baseUrl,
        cfg.apiKey,
        buildBody(model, withExtras ? extras : {}, withSoftOpts),
        budget
      );

    try {
      const res = await attempt(true);
      return { text: res.text, model };
    } catch (err) {
      lastError = err;
      if (err instanceof AiProviderError && err.rawStatus === 400) {
        // provider rejected something optional (reasoning_effort / detail /
        // temperature) → retry once with a minimal body
        try {
          const res = await attempt(false, false);
          return { text: res.text, model };
        } catch (err2) {
          lastError = err2;
          if (!(err2 instanceof AiProviderError && (err2.rawStatus === 429 || err2.rawStatus === 503))) {
            throw err2;
          }
        }
      }
      // 429/503 (or timeout) → brief pause then same model once, then next in chain
      if (err instanceof AiProviderError && (err.rawStatus === 429 || err.rawStatus === 503)) {
        if (i === 0 && remaining() > 10_000) {
          await sleep(1_500);
          try {
            const res = await attempt(true);
            return { text: res.text, model };
          } catch (err3) {
            lastError = err3;
          }
        }
        continue; // next model in chain
      }
      if (!(err instanceof AiProviderError && err.rawStatus === undefined)) {
        throw err; // hard error (auth/bad request/network) — no point retrying
      }
      // timeouts fall through to the next candidate model
    }
  }
  throw lastError instanceof Error ? lastError : new AiProviderError('فشل مزود الذكاء الاصطناعي', 502);
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
      res.status >= 500 ? 502 : 400,
      res.status
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
  /** Sampling temperature. Defaults to 0 (greedy decoding): OCR and
   *  extraction are TRANSCRIPTION, not generation — deterministic sampling
   *  plus full-resolution input are the two strongest anti-hallucination
   *  levers. Pass a higher value only for genuinely creative vision tasks. */
  temperature?: number;
}

/** One-shot vision call: image + instruction → text. */
export async function aiVisionText({
  prompt,
  dataUrl,
  maxTokens = 4096,
  timeoutMs = 120_000,
  temperature = 0,
}: VisionParams): Promise<string> {
  const cfg = assertConfigured();
  if (cfg.apiKey) {
    const { text } = await postChatResilient(
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.visionModel, fallbackModel: cfg.fallbackModel },
      (model, extras, soft) => ({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: dataUrl,
                  // detail:'high' keeps near-full image resolution instead of
                  // a downscaled thumbnail — low-res input is the #1 reason
                  // vision models "reconstruct" (i.e. invent) unreadable pages
                  ...(soft ? { detail: 'high' } : {}),
                },
              },
            ],
          },
        ],
        max_tokens: maxTokens,
        // greedy decoding — a transcription must never "roll the dice"
        ...(soft ? { temperature } : {}),
        ...extras,
      }),
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
    temperature,
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
    const { text } = await postChatResilient(
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.chatModel, fallbackModel: cfg.fallbackModel },
      (model, extras) => ({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        ...extras,
      }),
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
