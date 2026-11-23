// ============================================================
// ALNOKHBA QB — OMR engine HTTP client (typed)
// The engine is a Python/OpenCV mini-service on :3032 (Task 2-a).
// All transport failures map to a clean, machine-readable result —
// the API layer converts them to 503 with a clear Arabic message.
// ============================================================

import type { FixedSheetTemplate } from '@/lib/qb/fixed-sheet';
import type {
  OMRTemplate,
  OMRThresholds,
  QBScanDiagnostics,
  QBScannedAnswer,
} from '@/lib/qb/types';

export const OMR_ENGINE_URL =
  process.env.OMR_ENGINE_URL || 'http://127.0.0.1:3032';

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
  /** null → engine QR-decodes the sheet and reports back needsTemplate.
   *  Fixed reusable sheets send their exam-level template here. */
  template?: OMRTemplate | FixedSheetTemplate | null;
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

/** Handwritten student ID read from the fixed sheet's digit boxes (assist). */
export interface OmrHandwrittenId {
  digits: string; // '?' marks an unreadable position — never guessed
  complete: boolean;
  confidence: number;
  backend?: string;
  stripImage?: string | null;
  perDigit: Array<{
    index: number;
    value: string | null;
    confidence: number;
    status: string;
  }>;
}

/** Shaded digit columns of the fixed sheet's ID grid (deterministic). */
export interface OmrIdGrid {
  digits: string; // '?' marks an empty/unclear column
  complete: boolean;
  confidence: number;
  columns: Array<{
    index: number;
    value: number | null;
    status: 'selected' | 'unanswered' | 'multiple' | 'unclear';
    confidence: number;
    ratios: Record<string, number>;
  }>;
}

/** Version bubble row read from the fixed sheet. */
export interface OmrVersionRead {
  value: number | null; // 1-based version number
  status: 'selected' | 'unanswered' | 'multiple' | 'unclear' | 'invalid';
  confidence: number;
  ratios: Record<string, number>;
}

export interface OmrProcessSuccess {
  ok: true;
  answers: QBScannedAnswer[];
  studentId?: { digits?: string; confidence?: number } | null;
  /** 'fixed' → exam-level reusable sheet (ANQB3 QR, no version in the QR) */
  mode?: 'fixed' | 'version';
  examId?: string | null;
  handwrittenId?: OmrHandwrittenId | null;
  idGrid?: OmrIdGrid | null;
  version?: OmrVersionRead | null;
  needsTemplate?: boolean;
  /** sheet was found but nothing was readable — route stores REVIEW */
  needsReview?: boolean;
  qr?: {
    examVersionId?: string;
    templateId?: string;
    sheet?: number;
    sheets?: number;
    /** raw decoded payload (needed for the exam-level ANQB3 codes) */
    payload?: string;
  } | null;
  diagnostics?: Partial<QBScanDiagnostics> | null;
  debugImage?: string | null; // base64 jpeg
  correctedImage?: string | null; // base64 jpeg
  sheet?: number;
  /** ruled tables found on the sheet (geometry + text when OCR is available) */
  tables?: unknown[];
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
  /** mean tesseract word confidence 0..1, null when unavailable */
  confidence?: number | null;
}

// ---------- low-level fetch ----------

async function engineFetch(
  path: string,
  init: RequestInit & { timeoutMs: number }
): Promise<Response | OmrClientError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
  // Engine auth: bearer token when configured (engine rejects requests
  // without it; GET /health stays public by design).
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (process.env.OMR_ENGINE_TOKEN) {
    headers.authorization = `Bearer ${process.env.OMR_ENGINE_TOKEN}`;
  }
  // Vercel omr-service variant: shared-secret gate via x-anqb-omr-key.
  if (process.env.OMR_SHARED_SECRET) {
    headers['x-anqb-omr-key'] = process.env.OMR_SHARED_SECRET;
  }
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
      error: process.env.VERCEL && !process.env.OMR_ENGINE_URL
        ? 'محرك OMR غير متصل — اضبط متغير OMR_ENGINE_URL في Vercel ليشير إلى خدمة المحرك المستضافة'
        : 'OMR engine unreachable — is the service running?',
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

// ---------- public client ----------

/** POST /process — template=null first (QR discovery), then WITH template. */
export async function processScan(payload: OmrProcessRequest): Promise<ProcessScanResult> {
  const res = await enginePostJson<OmrProcessSuccess | OmrProcessFailure>(
    '/process',
    {
      imageBase64: payload.imageBase64,
      template: payload.template ?? null,
      answerKey: payload.answerKey ?? null,
      marksMap: payload.marksMap ?? null,
      thresholds: payload.thresholds ?? null,
      debug: payload.debug ?? true,
      manualMarkers: payload.manualMarkers ?? null,
    },
    30_000
  );
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
  lang: 'eng' | 'ara'
): Promise<OmrOcrResult | OmrClientError> {
  const res = await enginePostJson<{ ok?: boolean; text?: string; confidence?: number | null }>(
    '/ocr',
    { imageBase64, lang },
    30_000
  );
  if (res instanceof Response === false && res && typeof res === 'object') {
    const body = res as {
      ok?: boolean;
      text?: string;
      confidence?: number | null;
      error?: string;
      stage?: string;
    };
    if (body.ok && typeof body.text === 'string') {
      return {
        ok: true,
        text: body.text,
        lang,
        confidence: typeof body.confidence === 'number' ? body.confidence : null,
      };
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

export interface OmrPdfPagesResult {
  ok: true;
  total: number;
  fromPage: number;
  /** JPEG base64 per requested page (engine-rasterized) */
  pages: string[];
  truncated: boolean;
}

/** Rasterize a PDF page range into JPEG base64 via the engine's /pdf_pages. */
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
