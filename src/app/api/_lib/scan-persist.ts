// Shared persistence helpers for the scan routes (version sheets + fixed
// sheets). Keeping them here avoids duplicating the "write the preview JPEG
// where the filesystem allows, otherwise inline it" rule.
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

import type { QBScannedAnswer } from '@/lib/qb/types';

export const SCANS_DIR = path.join(process.cwd(), 'db', 'scans');

export function decodeImage(
  base64: string,
  scanId: string,
  kind: 'debug' | 'corrected'
): string | null {
  try {
    mkdirSync(SCANS_DIR, { recursive: true });
    const filePath = path.join(SCANS_DIR, `${scanId}_${kind}.jpg`);
    writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return `db/scans/${scanId}_${kind}.jpg`;
  } catch {
    return `data:image/jpeg;base64,${base64}`;
  }
}

export function imagesPayload(
  scanId: string,
  debugPath: string | null,
  correctedPath: string | null
) {
  const asUrl = (stored: string | null, kind: 'debug' | 'corrected') =>
    !stored ? null : stored.startsWith('data:') ? stored : `/api/scans/${scanId}/images/${kind}`;
  return {
    debugImage: asUrl(debugPath, 'debug'),
    correctedImage: asUrl(correctedPath, 'corrected'),
  };
}

export function meanConfidence(answers: QBScannedAnswer[]): number {
  if (!answers.length) return 0;
  const sum = answers.reduce(
    (acc, a) => acc + (Number.isFinite(a.confidence) ? a.confidence : 0),
    0
  );
  return Math.round((sum / answers.length) * 1000) / 1000;
}

export function normalizeStudentCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\s+/g, '');
  if (!digits || !/^\d{1,10}$/.test(digits)) return null;
  return digits;
}
