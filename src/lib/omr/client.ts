// ============================================================
// ALNOKHBA QB — OMR engine HTTP client (typed)
// The engine is a Python/OpenCV mini-service on :3032 (Task 2-a).
// All transport failures map to a clean, machine-readable result —
// the API layer converts them to 503 with a clear Arabic message.
// ============================================================

import type {
  OMRTemplate,
  OMRThresholds,
  QBScanDiagnostics,
  QBScannedAnswer,
} from '@/lib/qb/types';
import { qrSigningSecret } from '@/lib/qb/omr-template';

// Engine base resolution:
//  1. explicit OMR_ENGINE_URL (local dev / self-hosted mini-service on :3032)
//  2. Vercel → the SAME deployment ships a Python FastAPI service under
//     /api/omr (omr-service/, routed via the top-level rewrite in
//     vercel.json). Self-calls MUST use the PUBLIC production alias:
//     raw deployment URLs (VERCEL_URL) are SSO-locked by Vercel
//     Authentication, which would 401 the internal engine call.
//  3. fallback → local mini-service default
function resolveEngineBase(): string {
  const explicit = process.env.OMR_ENGINE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (process.env.VERCEL) {
    const host =
      process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
      process.env.VERCEL_URL?.trim();
    if (host) return `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/omr`;
  }
  return 'http://127.0.0.1:3032';
}

export const OMR_ENGINE_URL = resolveEngineBase();

// ---------- error shape ----------

export type OmrTransportStage =
  | 'engineUnreachable'
  | 'timeout'
  | 'engineHttpError'
  | 'engineProtocol';

/** Transport-level failure (engine down / timeout / non-JSON). `stage` discriminates. */
export interface OmrClientError {
  ok: false;
  error: string;
  stage: OmrTransportStage;
  status?: number;
  details?: unknown;
}

// ---------- /process ----------

export interface OmrProcessRequest {
  imageBase64: string;
  /** PDF input (alternative to imageBase64): engine rasterizes pageIndex */
  pdfBase64?: string;
  pageIndex?: number;
  pdfDpi?: number;
  /** null → engine QR-decodes the sheet and reports back needsTemplate */
  template?: OMRTemplate | null;
  /** { [questionNumber]: optionLetter } — engine keys by NUMBER */
  answerKey?: Record<string, string> | null;
  /** { [questionNumber]: marks } — advisory, for engine-side preview grade */
  marksMap?: Record<string, number> | null;
  thresholds?: OMRThresholds | null;
  debug?: boolean;
  /** manual 4-corner fallback: user-clicked printed marker centers
   *  TL,TR,BR,BL in ORIGINAL image pixels (legacy nokhba-qb calibration port) */
  manualMarkers?: number[][] | null;
}

export interface OmrProcessSuccess {
  ok: true;
  answers: QBScannedAnswer[];
  studentId?: { digits?: string; confidence?: number } | null;
  needsTemplate?: boolean;
  qr?: {
    examVersionId?: string;
    templateId?: string;
    sheet?: number;
  } | null;
  diagnostics?: Partial<QBScanDiagnostics> | null;
  debugImage?: string | null; // base64 jpeg
  correctedImage?: string | null; // base64 jpeg
  sheet?: number;
}

/** The engine ran but reported a business failure (e.g. template mismatch). */
export interface OmrProcessFailure {
  ok: false;
  error: string;
  stage: string; // engine-reported, e.g. 'templateMismatch'
  answers?: QBScannedAnswer[];
  diagnostics?: Partial<QBScanDiagnostics> | null;
  debugImage?: string | null;
  correctedImage?: string | null;
}

export type ProcessScanResult = OmrProcessSuccess | OmrProcessFailure | OmrClientError;

export function isTransportError(r: ProcessScanResult): r is OmrClientError {
  return (
    r.ok === false &&
    (r.stage === 'engineUnreachable' ||
      r.stage === 'timeout' ||
      r.stage === 'engineHttpError' ||
      r.stage === 'engineProtocol')
  );
}

// ---------- /ocr ----------

export interface OmrOcrResult {
  ok: true;
  text: string;
  lang: string;
  /** 0..1 tesseract self-assessment (mean word confidence); null/undefined = not provided */
  confidence?: number | null;
}

// ---------- low-level fetch ----------

async function engineFetch(
  path: string,
  init: RequestInit & { timeoutMs: number }
): Promise<Response | OmrClientError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
  const headers = new Headers(init.headers);
  // shared secret between the Next.js app and the OMR engine service
  // (engaged only when OMR_SHARED_SECRET is configured on both sides)
  const secret = process.env.OMR_SHARED_SECRET?.trim();
  if (secret) headers.set('x-anqb-omr-key', secret);
  try {
    const res = await fetch(`${OMR_ENGINE_URL}${path}`, {
      ...init,
      headers,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        stage: 'timeout',
        error: `انتهت المهلة أثناء الاتصال بمحرك OMR (${init.timeoutMs / 1000} ثانية)`,
        details: msg,
      };
    }
    return {
      ok: false,
      stage: 'engineUnreachable',
      error: 'OMR engine unreachable — is the service running?',
      details: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function enginePostJson<T>(
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<T | OmrClientError> {
  const res = await engineFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (res instanceof Response === false) return res as OmrClientError;

  const httpRes = res as Response;
  let parsed: unknown;
  try {
    parsed = await httpRes.json();
  } catch {
    parsed = null;
  }

  if (!httpRes.ok) {
    // engine replied with an error status AND a structured body → keep the body
    if (parsed && typeof parsed === 'object' && 'ok' in (parsed as Record<string, unknown>)) {
      return parsed as T;
    }
    return {
      ok: false,
      stage: 'engineHttpError',
      status: httpRes.status,
      error: `OMR engine returned HTTP ${httpRes.status}`,
      details: parsed,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      stage: 'engineProtocol',
      error: 'OMR engine returned a malformed (non-JSON) response',
      details: parsed,
    };
  }
  return parsed as T;
}

// ---------- /pdf_pages ----------

export interface OmrPdfPagesResult {
  ok: true;
  total: number;
  fromPage: number;
  /** JPEG base64 per requested page (engine-rasterized) */
  pages: string[];
  truncated: boolean;
}

/** POST /pdf_pages — rasterize a chunk of PDF pages (cursor-based batching).
 *  Timeouts are NOT retried here: the caller (batch route) resumes by cursor. */
export async function pdfPages(params: {
  pdfBase64: string;
  fromPage?: number;
  maxPages?: number;
  dpi?: number;
  quality?: number;
  timeoutMs?: number;
}): Promise<OmrPdfPagesResult | OmrClientError> {
  const res = await enginePostJson<OmrPdfPagesResult>(
    '/pdf_pages',
    {
      pdfBase64: params.pdfBase64,
      fromPage: params.fromPage ?? 0,
      maxPages: params.maxPages ?? 8,
      dpi: params.dpi ?? 200,
      quality: params.quality ?? 85,
    },
    params.timeoutMs ?? 90_000
  );
  if (
    res &&
    typeof res === 'object' &&
    'ok' in res &&
    (res as { ok?: boolean }).ok === true &&
    Array.isArray((res as { pages?: unknown }).pages)
  ) {
    return res as OmrPdfPagesResult;
  }
  return res as OmrClientError;
}

// ---------- public client ----------

/** POST /process — template=null first (QR discovery), then WITH template.
 *  Transient `engineUnreachable` failures are retried once after a short
 *  delay: the engine supervisor (watch.ts) restarts Python within ~1s of a
 *  crash, so a single retry heals the "unreachable" window instead of
 *  surfacing it to the teacher. Timeouts and protocol errors are NOT retried. */
export async function processScan(payload: OmrProcessRequest): Promise<ProcessScanResult> {
  const once = () =>
    enginePostJson<OmrProcessSuccess | OmrProcessFailure>(
      '/process',
      {
        imageBase64: payload.imageBase64,
        pdfBase64: payload.pdfBase64 ?? null,
        pageIndex: payload.pageIndex ?? null,
        pdfDpi: payload.pdfDpi ?? null,
        template: payload.template ?? null,
        answerKey: payload.answerKey ?? null,
        marksMap: payload.marksMap ?? null,
        thresholds: payload.thresholds ?? null,
        debug: payload.debug ?? true,
        manualMarkers: payload.manualMarkers ?? null,
        // QR v2 HMAC verification secret (server-to-server only)
        qrSecret: qrSigningSecret(),
      },
      // 55s: the engine is CPU-bound OpenCV on serverless CPU; the two-call
      // flow (identity + full) must survive the slowest class. maxDuration=60
      // on the scan route keeps the whole request inside the function budget.
      55_000
    );

  let res = await once();
  // The supervisor restarts Python within ~1s of a crash; retry twice so a
  // scan issued right at a crash+reboot window survives instead of erroring.
  const delays = [1200, 2500];
  for (let i = 0; i < delays.length && isTransportError(res) && res.stage === 'engineUnreachable'; i++) {
    await new Promise((r) => setTimeout(r, delays[i]));
    res = await once();
  }
  // Engine nests the QR identity under qr.parsed — flatten it so callers can
  // read qr.examVersionId / qr.templateId / qr.sheet directly.
  if (
    res.ok &&
    res.qr &&
    typeof res.qr === 'object' &&
    'parsed' in (res.qr as Record<string, unknown>)
  ) {
    const { parsed, ...rest } = res.qr as Record<string, unknown> & {
      parsed?: Record<string, unknown>;
    };
    return {
      ...res,
      qr: { ...(parsed ?? {}), ...rest },
    } as ProcessScanResult;
  }
  return res;
}

/** POST /ocr — tesseract text extraction (Arabic falls back to VLM in the API route). */
export async function ocrText(
  imageBase64: string,
  lang: 'eng' | 'ara' | 'ara+eng'
): Promise<OmrOcrResult | OmrClientError> {
  const res = await enginePostJson<{ ok?: boolean; text?: string; confidence?: number | null }>(
    '/ocr',
    { imageBase64, lang },
    60_000
  );
  if (res instanceof Response === false && res && typeof res === 'object') {
    const body = res as { ok?: boolean; text?: string; error?: string; stage?: string; confidence?: number | null };
    if (body.ok && typeof body.text === 'string') {
      return { ok: true, text: body.text, lang, confidence: body.confidence ?? null };
    }
    if ('stage' in body) return res as OmrClientError;
    return {
      ok: false,
      stage: 'engineProtocol',
      error: body.error || 'OMR engine OCR failed',
    } as OmrClientError;
  }
  return res as OmrClientError;
}

export interface EngineHealth {
  ok: boolean;
  error?: string;
  raw?: unknown;
}

/** GET /health with a short timeout (for /api/health). */
export async function engineHealth(timeoutMs = 2000): Promise<EngineHealth> {
  const res = await engineFetch('/health', { method: 'GET', timeoutMs });
  if (res instanceof Response === false) {
    return { ok: false, error: (res as OmrClientError).error };
  }
  const httpRes = res as Response;
  if (!httpRes.ok) {
    return { ok: false, error: `OMR engine health returned HTTP ${httpRes.status}` };
  }
  try {
    const json = await httpRes.json();
    return { ok: true, raw: json };
  } catch {
    return { ok: true, raw: null };
  }
}
