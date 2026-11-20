// ============================================================
// ALNOKHBA QB — Supabase Storage helpers (SERVER ONLY)
//
// Service-role client for the private "uploads" bucket. The service key
// never leaves the server: the browser gets a SHORT-LIVED signed upload
// URL and uploads directly (bypassing Vercel's 4.5 MB function payload
// limit), then posts only the storage path.
//
// Fail-open design: when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not
// configured the callers fall back to the legacy local-disk flow, so a
// deploy without the env vars behaves exactly as before.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_BUCKET = 'uploads';

/** Storage-mode cap: direct uploads bypass the function payload limit. */
export const STORAGE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

export function storageConfigured(): boolean {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return typeof url === 'string' && url.length > 0 && typeof key === 'string' && key.length > 0;
}

// single global instance (mirrors src/lib/db.ts)
const globalForSupabase = globalThis as unknown as { supabaseAdmin?: SupabaseClient };

export function supabaseAdmin(): SupabaseClient {
  if (!storageConfigured()) throw new Error('Supabase storage is not configured');
  if (!globalForSupabase.supabaseAdmin) {
    globalForSupabase.supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return globalForSupabase.supabaseAdmin;
}

/** Object path for a submission: assignments/<assignmentId>/<unique>/<file> */
export function submissionObjectPath(assignmentId: string, fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `assignments/${assignmentId}/${unique}/${safe}`;
}

/** True when the path belongs to this assignment's subtree (client-supplied guard). */
export function isOwnSubmissionPath(assignmentId: string, path: string): boolean {
  return path.startsWith(`assignments/${assignmentId}/`);
}

/** Best-effort: create the private bucket when missing (service role can). */
export async function ensureBucket(): Promise<void> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.storage.listBuckets();
    if (data?.some((b) => b.name === SUPABASE_BUCKET)) return;
    await sb.storage.createBucket(SUPABASE_BUCKET, {
      public: false,
      fileSizeLimit: STORAGE_MAX_BYTES,
    });
  } catch {
    // already exists / not permitted → the presign call below surfaces a
    // clear error instead of hiding it here
  }
}

/** Delete a stored submission object (best-effort, for resubmissions). */
export async function removeSubmissionObject(path: string): Promise<void> {
  try {
    await supabaseAdmin().storage.from(SUPABASE_BUCKET).remove([path]);
  } catch {
    /* stale object left behind is harmless */
  }
}
