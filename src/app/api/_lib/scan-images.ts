/**
 * Sheet images stored on a Scan row.
 *
 * `/api/scan` writes `debugImage` / `correctedImage` into diagnosticsJson: a
 * `/api/scans/<id>/images/<kind>` URL when the host can write to db/scans, or a
 * full data URL on serverless (read-only filesystem). Rows written before the
 * rework used `*ImagePath` for the file variant, so both names are read.
 */

export type SheetKind = 'debug' | 'corrected';

const STORED_KEYS: Record<SheetKind, string[]> = {
  debug: ['debugImage', 'debugImagePath'],
  corrected: ['correctedImage', 'correctedImagePath'],
};

/** Value an <img src> can load, or null when the row has no sheet image. */
export function sheetImageUrl(
  scanId: string,
  diagnostics: Record<string, unknown>,
  kind: SheetKind
): string | null {
  for (const key of STORED_KEYS[kind]) {
    const value = diagnostics[key];
    if (typeof value !== 'string' || !value) continue;
    return value.startsWith('data:') ? value : `/api/scans/${scanId}/images/${kind}`;
  }
  return null;
}
