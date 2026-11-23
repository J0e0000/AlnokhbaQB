// ============================================================
// ALNOKHBA QB — regression test: sheet images reach the review UI
// (bun test tests/scan-images.test.ts)
//
// /api/scan persisted `debugImage`/`correctedImage` but GET /api/scans/:id
// looked for `debugImagePath`/`correctedImagePath`, so the review dialog
// silently showed no sheet at all — the teacher approved grades blind.
// ============================================================

import { describe, expect, test } from 'bun:test';
import { sheetImageUrl } from '@/app/api/_lib/scan-images';

const ID = 'cmwt7x30q006nwyf8hrmavfu5';

describe('sheetImageUrl', () => {
  test('file-backed host → API route', () => {
    const diag = { debugImage: `/api/scans/${ID}/images/debug` };
    expect(sheetImageUrl(ID, diag, 'debug')).toBe(`/api/scans/${ID}/images/debug`);
  });

  test('serverless host → inline data URL passes through untouched', () => {
    const dataUrl = 'data:image/jpeg;base64,AAAA';
    expect(sheetImageUrl(ID, { correctedImage: dataUrl }, 'corrected')).toBe(dataUrl);
  });

  test('legacy *ImagePath rows still resolve', () => {
    const diag = { debugImagePath: 'db/scans/x_debug.jpg' };
    expect(sheetImageUrl(ID, diag, 'debug')).toBe(`/api/scans/${ID}/images/debug`);
  });

  test('no image stored → null (viewer shows its empty state)', () => {
    expect(sheetImageUrl(ID, {}, 'debug')).toBeNull();
    expect(sheetImageUrl(ID, { debugImage: '' }, 'corrected')).toBeNull();
  });

  test('kinds never cross over', () => {
    const diag = { debugImage: `/api/scans/${ID}/images/debug` };
    expect(sheetImageUrl(ID, diag, 'corrected')).toBeNull();
  });
});
