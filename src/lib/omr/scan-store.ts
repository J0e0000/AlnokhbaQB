// ============================================================
// ALNOKHBA QB — scan image persistence (disk + Vercel Blob).
// Local/self-hosted → db/scans under the project cwd (persistent).
// Vercel → the serverless FS is READ-ONLY except /tmp and /tmp is
// EPHEMERAL per invocation, so disk copies die with the instance.
// When BLOB_READ_WRITE_TOKEN is present (Vercel Blob store
// connected to the project) the canonical copy is uploaded to
// Blob at a pathname mirroring the DB's relative path, and the
// serving route streams it back behind session auth. DB rows keep
// storing ONLY the relative path — identical shape on every host.
// ============================================================

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { scanRelPath, scansDir } from './scans-dir';

/** Vercel Blob is the canonical store when the store is connected. */
export function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN?.trim();
}

/** 'db/scans/<id>_<kind>.jpg' → Blob pathname 'scans/<id>_<kind>.jpg'. */
export function blobPathname(scanId: string, kind: 'debug' | 'corrected'): string {
  return `scans/${scanId}_${kind}.jpg`;
}

/** Best-effort local copy (persistent self-hosted/dev, ephemeral /tmp on Vercel). */
function writeLocal(scanId: string, kind: 'debug' | 'corrected', bytes: Buffer): void {
  try {
    const dir = scansDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${scanId}_${kind}.jpg`), bytes);
  } catch {
    /* disk is best-effort; Blob is the canonical store on Vercel */
  }
}

/**
 * Persist a scan JPEG (debug|corrected) and return the canonical
 * relative DB path — or null when the image could not be persisted
 * anywhere (the scan row then simply carries no image URL).
 */
export async function persistScanImage(
  scanId: string,
  kind: 'debug' | 'corrected',
  base64: string
): Promise<string | null> {
  const relPath = scanRelPath(scanId, kind);
  try {
    const bytes = Buffer.from(base64, 'base64');
    writeLocal(scanId, kind, bytes);
    if (blobConfigured()) {
      const { put } = await import('@vercel/blob');
      await put(blobPathname(scanId, kind), bytes, {
        access: 'public',
        contentType: 'image/jpeg',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    }
    return relPath;
  } catch {
    return null;
  }
}
