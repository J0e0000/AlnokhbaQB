// ============================================================
// ALNOKHBA QB — Cloudflare backend configuration
//
// One place that answers "is Cloudflare wired up, and for what?".
// Everything is env-gated: with no credentials the app keeps its
// previous behaviour (local OCR engine, Supabase/disk storage),
// so a missing token degrades instead of breaking.
//
//   CLOUDFLARE_ACCOUNT_ID     account that owns Workers AI + R2
//   CLOUDFLARE_API_TOKEN      token with "Workers AI: Read" (and R2 if used)
//   CLOUDFLARE_AI_OCR_MODEL   optional, defaults to mistral-small-3.1
//   R2_BUCKET                 bucket name for library originals
//   R2_ACCESS_KEY_ID          R2 API token id (S3 credentials)
//   R2_SECRET_ACCESS_KEY      R2 API token secret
//   R2_ENDPOINT               optional, defaults to
//                             https://<account>.r2.cloudflarestorage.com
// ============================================================

// mistral-small-3.1 reads Arabic well and needs no per-model licence
// acceptance; llama-3.2-vision is gated behind a prompt of 'agree'.
export const DEFAULT_OCR_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

export interface CloudflareAiConfig {
  accountId: string;
  apiToken: string;
  ocrModel: string;
}

export function cloudflareAiConfig(): CloudflareAiConfig | null {
  const accountId = env('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = env('CLOUDFLARE_API_TOKEN');
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken, ocrModel: env('CLOUDFLARE_AI_OCR_MODEL') || DEFAULT_OCR_MODEL };
}

export function cloudflareAiConfigured(): boolean {
  return cloudflareAiConfig() !== null;
}

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function r2Config(): R2Config | null {
  const accessKeyId = env('R2_ACCESS_KEY_ID');
  const secretAccessKey = env('R2_SECRET_ACCESS_KEY');
  const bucket = env('R2_BUCKET');
  if (!accessKeyId || !secretAccessKey || !bucket) return null;
  const endpoint =
    env('R2_ENDPOINT') ||
    (env('CLOUDFLARE_ACCOUNT_ID')
      ? `https://${env('CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com`
      : '');
  if (!endpoint) return null;
  return { endpoint: endpoint.replace(/\/+$/, ''), bucket, accessKeyId, secretAccessKey };
}

export function r2Configured(): boolean {
  return r2Config() !== null;
}

/** Where library originals actually live right now — surfaced in the health check. */
export function storageBackend(): 'r2' | 'supabase' | 'disk' {
  if (r2Configured()) return 'r2';
  if (env('SUPABASE_URL') && env('SUPABASE_SERVICE_ROLE_KEY')) return 'supabase';
  return 'disk';
}
