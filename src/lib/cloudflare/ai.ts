// ============================================================
// ALNOKHBA QB — Cloudflare Workers AI vision OCR (server only)
//
// The page image goes to a vision model on Cloudflare's GPUs, so the
// app no longer depends on a Python host having the Arabic tesseract
// data installed.
//
// Endpoint: POST /accounts/{id}/ai/run/{model}
//
// Two payload shapes exist and models disagree about which they take:
//   • chat   — OpenAI-compatible `messages` with a base64 data URL.
//              Works for mistral-small-3.1, llama-4-scout, gemma…
//   • legacy — `{ prompt, image: [bytes] }`, for llama-3.2-vision.
// Multipart is not accepted by either, so we only send JSON, trying
// chat first and falling back to legacy.
// ============================================================

import { cloudflareAiConfig, type CloudflareAiConfig } from './config';

export interface VisionOcrInput {
  base64: string;
  mime: string;
  prompt: string;
  maxTokens?: number;
}

export interface VisionOcrDeps {
  config?: CloudflareAiConfig | null;
  fetchImpl?: typeof fetch;
}

export class CloudflareAiError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'CloudflareAiError';
    this.status = status;
  }
}

const DEFAULT_MAX_TOKENS = 2048;

export type VisionPayload =
  | { kind: 'chat'; body: Record<string, unknown> }
  | { kind: 'legacy'; body: Record<string, unknown> };

/** Both request shapes, in the order they should be tried. */
export function buildPayloads(input: VisionOcrInput): VisionPayload[] {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const mime = input.mime.startsWith('image/') ? input.mime : 'image/png';
  const dataUrl = `data:${mime};base64,${input.base64}`;
  return [
    {
      kind: 'chat',
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: input.prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: maxTokens,
      },
    },
    {
      kind: 'legacy',
      body: {
        prompt: input.prompt,
        image: Array.from(Buffer.from(input.base64, 'base64')),
        max_tokens: maxTokens,
      },
    },
  ];
}

/** Pull the model's text out of the shapes Workers AI returns. */
export function extractVisionText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as { result?: unknown; response?: unknown };
  const result = body.result;
  const candidates: unknown[] = [];

  if (typeof result === 'string') candidates.push(result);
  if (result && typeof result === 'object') {
    const r = result as {
      response?: unknown;
      text?: unknown;
      description?: unknown;
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    };
    candidates.push(r.response, r.text, r.description);
    for (const choice of r.choices ?? []) {
      candidates.push(choice?.message?.content, choice?.text);
    }
  }
  candidates.push(body.response);

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Workers AI error payload → one readable line. */
export function describeAiFailure(status: number, payload: unknown): string {
  const body = payload as
    | { errors?: Array<{ message?: string } | string>; error?: string }
    | string
    | null;
  if (typeof body === 'string') return body.slice(0, 200) || `HTTP ${status}`;
  const first = body?.errors?.[0];
  const message =
    (typeof first === 'string' ? first : first?.message) ||
    body?.error ||
    (status === 401 || status === 403 ? 'رمز Cloudflare غير صالح أو بلا صلاحية Workers AI' : '');
  if (status === 404) return message || 'النموذج غير متاح على حساب Cloudflare هذا';
  return message || `استجابة غير متوقعة من Cloudflare (HTTP ${status})`;
}

export interface VisionOcrResult {
  text: string;
  model: string;
}

/**
 * Run one OCR pass on the Workers AI vision model.
 * Throws CloudflareAiError with an Arabic-ready reason on failure.
 */
export async function visionOcr(
  input: VisionOcrInput,
  deps: VisionOcrDeps = {},
): Promise<VisionOcrResult> {
  const config = deps.config === undefined ? cloudflareAiConfig() : deps.config;
  if (!config) {
    throw new CloudflareAiError('Cloudflare غير مهيأ (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN)', 503);
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${config.ocrModel}`;

  let lastError: CloudflareAiError | null = null;
  for (const payload of buildPayloads(input)) {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.body),
    });
    const raw = await response.text();
    const body = safeJson(raw);

    if (!response.ok) {
      lastError = new CloudflareAiError(describeAiFailure(response.status, body), response.status);
      // a credential/model problem will not improve with another shape
      if (response.status === 401 || response.status === 403 || response.status === 404) throw lastError;
      continue;
    }
    const text = extractVisionText(body);
    if (text) return { text, model: config.ocrModel };
    lastError = new CloudflareAiError('النموذج أعاد نصًا فارغًا', 502);
  }
  throw lastError ?? new CloudflareAiError('تعذر تنفيذ التعرف الضوئي', 502);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 300);
  }
}

// ---------- entitlement probe ----------
// A token can exist and still be refused: Workers AI must be enabled on the
// account, and Cloudflare answers 403 "Authentication error" until it is. The
// status rail asks this instead of trusting the presence of env vars.
let probeCache: { at: number; ok: boolean } | null = null;

export async function probeCloudflareAi(ttlMs = 10 * 60_000): Promise<boolean> {
  const config = cloudflareAiConfig();
  if (!config) return false;
  const now = Date.now();
  if (probeCache && now - probeCache.at < ttlMs) return probeCache.ok;
  let ok = false;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/models/search?per_page=1`,
      { headers: { Authorization: `Bearer ${config.apiToken}` }, signal: AbortSignal.timeout(3000) },
    );
    ok = res.ok;
  } catch {
    ok = false;
  }
  probeCache = { at: now, ok };
  return ok;
}
