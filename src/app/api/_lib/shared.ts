// ============================================================
// ALNOKHBA QB — shared helpers for API routes (server-only)
// ============================================================

import { db } from '@/lib/db';
import { OMR_DEFAULT_THRESHOLDS } from '@/lib/qb/omr-template';
import type { CalibrationProfile } from '@prisma/client';

// ---------- request body / errors ----------

// Naive in-memory sliding-window rate limiter for expensive scan endpoints.
// Per-actor (session user id), process-wide; resets on redeploy — enough to
// stop runaway loops and accidental flooding, not a full WAF.
const RATE_BUCKETS = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = (RATE_BUCKETS.get(key) ?? []).filter((t) => now - t < windowMs);
  if (bucket.length >= limit) {
    RATE_BUCKETS.set(key, bucket);
    return false;
  }
  bucket.push(now);
  RATE_BUCKETS.set(key, bucket);
  if (RATE_BUCKETS.size > 5000) RATE_BUCKETS.clear(); // hard memory bound
  return true;
}

export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function zodMessage(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: Array<string | number>; message: string }> })
    ?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0];
    const path = first.path?.length ? ` (${first.path.join('.')})` : '';
    return `${first.message}${path}`;
  }
  return err instanceof Error ? err.message : 'بيانات غير صالحة';
}

export function serverError(err: unknown): { error: string; details?: string } {
  return {
    error: 'خطأ غير متوقع في الخادم',
    details: err instanceof Error ? err.message : String(err),
  };
}

/** Strip a `data:<mime>;base64,` prefix if present → raw base64 + mime.
 *  Accepts ANY mime (images AND application/pdf for OMR batch uploads). */
export function stripDataUrl(s: string): { base64: string; mime: string } {
  const trimmed = s.trim();
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,/.exec(trimmed);
  if (m) return { base64: trimmed.slice(m[0].length), mime: m[1] };
  return { base64: trimmed, mime: '' };
}

// ---------- upload limits (env-configurable safe defaults) ----------
//
// All scan endpoints enforce these on BOTH the JSON/base64 and the
// multipart/binary paths. Defaults keep current behavior; deployments can
// tighten them (SCAN_MAX_IMAGE_MB=10, SCAN_MAX_PDF_MB=25, SCAN_MAX_PDF_PAGES=30)
// or widen them for self-hosted hosts without platform body caps.

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/** Single sheet image cap (bytes). Default 25 MB. */
export function scanMaxImageBytes(): number {
  return Math.floor(envNumber('SCAN_MAX_IMAGE_MB', 25, 1, 100) * 1024 * 1024);
}

/** PDF upload cap (bytes). Default 40 MB (scanned stacks are large). */
export function scanMaxPdfBytes(): number {
  return Math.floor(envNumber('SCAN_MAX_PDF_MB', 40, 1, 200) * 1024 * 1024);
}

/** PDF page-count cap. Default 200 pages. */
export function scanMaxPdfPages(): number {
  return Math.floor(envNumber('SCAN_MAX_PDF_PAGES', 200, 1, 1000));
}

/** PDF rasterization DPI sent to the engine. Default 300 (engine clamps 72..300). */
export function scanPdfDpi(): number {
  return Math.floor(envNumber('SCAN_PDF_DPI', 300, 72, 300));
}

/** Content sniff: accept only real JPEG/PNG bytes (magic numbers). */
export function imageSignature(bytes: Uint8Array): 'jpeg' | 'png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  return null;
}

// ---------- calibration (OMR thresholds) ----------

export interface CalibrationPreset {
  filled: number;
  empty: number;
  ambiguousMargin: number;
  minAbsoluteFill: number;
}

export interface CalibrationConfig extends CalibrationPreset {
  presets?: Record<string, CalibrationPreset>;
}

export function defaultCalibrationConfig(): CalibrationConfig {
  const pencil: CalibrationPreset = { ...OMR_DEFAULT_THRESHOLDS };
  return {
    ...pencil,
    presets: {
      pencil,
      pen: { filled: 0.5, empty: 0.22, ambiguousMargin: 0.1, minAbsoluteFill: 0.08 },
      light: { filled: 0.38, empty: 0.2, ambiguousMargin: 0.1, minAbsoluteFill: 0.08 },
    },
  };
}

function isFinite01(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function validPreset(p: unknown): CalibrationPreset | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (
    !isFinite01(o.filled) ||
    !isFinite01(o.empty) ||
    !isFinite01(o.ambiguousMargin) ||
    !isFinite01(o.minAbsoluteFill)
  ) {
    return null;
  }
  return {
    filled: o.filled,
    empty: o.empty,
    ambiguousMargin: o.ambiguousMargin,
    minAbsoluteFill: o.minAbsoluteFill,
  };
}

/** Validate a client calibration config (numbers 0..1). Returns null if invalid. */
export function validateCalibrationConfig(input: unknown): CalibrationConfig | null {
  if (!input || typeof input !== 'object') return null;
  const base = validPreset(input);
  if (!base) return null;
  const out: CalibrationConfig = { ...base };
  const presets = (input as Record<string, unknown>).presets;
  if (presets && typeof presets === 'object') {
    const parsed: Record<string, CalibrationPreset> = {};
    for (const [name, value] of Object.entries(presets as Record<string, unknown>)) {
      const p = validPreset(value);
      if (!p) return null;
      parsed[name] = p;
    }
    out.presets = parsed;
  }
  return out;
}

/** Get the active profile, seeding the default on first use. */
export async function ensureActiveCalibration(): Promise<CalibrationProfile> {
  const existing = await db.calibrationProfile.findFirst({ where: { active: true } });
  if (existing) return existing;
  return db.calibrationProfile.create({
    data: {
      name: 'افتراضي — قلم رصاص',
      active: true,
      configJson: JSON.stringify(defaultCalibrationConfig()),
    },
  });
}

/** Extract the OMRThresholds object the engine expects from a profile config. */
export function thresholdsFromConfig(configJson: string): CalibrationPreset {
  try {
    const cfg = JSON.parse(configJson) as CalibrationConfig;
    return {
      filled: cfg.filled ?? OMR_DEFAULT_THRESHOLDS.filled,
      empty: cfg.empty ?? OMR_DEFAULT_THRESHOLDS.empty,
      ambiguousMargin: cfg.ambiguousMargin ?? OMR_DEFAULT_THRESHOLDS.ambiguousMargin,
      minAbsoluteFill: cfg.minAbsoluteFill ?? OMR_DEFAULT_THRESHOLDS.minAbsoluteFill,
    };
  } catch {
    return { ...OMR_DEFAULT_THRESHOLDS };
  }
}
