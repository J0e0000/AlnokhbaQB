// ============================================================
// ALNOKHBA QB — scan image storage directory resolver.
// Local/self-hosted → db/scans under the project cwd (persistent).
// Vercel → serverless filesystem is READ-ONLY except /tmp, so scan
// JPEGs (debug/corrected) land in /tmp/alnokhba-scans (ephemeral by
// design — the DB only ever stores the relative path, and the serving
// route resolves the SAME directory via this helper).
// ============================================================

import path from 'path';

export function scansDir(): string {
  if (process.env.VERCEL) return '/tmp/alnokhba-scans';
  return path.join(process.cwd(), 'db', 'scans');
}

/** Relative path stored in the DB (identical format on every host). */
export function scanRelPath(scanId: string, kind: 'debug' | 'corrected'): string {
  return `db/scans/${scanId}_${kind}.jpg`;
}
