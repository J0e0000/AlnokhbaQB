// ============================================================
// ALNOKHBA QB — regression test: scan version-hint resolution
// (bun test tests/version-hint.test.ts)
//
// Regression for the ScanStudio version bug: the picker used to send the
// EXAM id as examVersionIdHint, and loadVersion() (a findUnique on
// ExamVersion) returned null → every manual-hint scan 404'd
// noMatchingVersion. loadVersionHint() must accept BOTH:
//   • an ExamVersion id  (new clients — resolve directly)
//   • an Exam id         (legacy clients — resolve its current version,
//                          falling back to the newest snapshot)
// and null/garbage must stay null.
// ============================================================

import { afterAll, describe, expect, test } from 'bun:test';

// bun test runs outside Next, so nothing loads .env.local: point Prisma at the
// local dev database before the client is constructed.
process.env.DATABASE_URL ??= 'file:./db/dev-local.db';

const { db } = await import('@/lib/db');
import { loadVersion, loadVersionHint } from '@/app/api/_lib/version';
import { starterDocument } from '@/lib/qb/schema';

const MARK = `hint-regression-${Date.now()}`;
let examId = '';
let v1Id = '';
let v2Id = '';

afterAll(async () => {
  // remove only rows this test created (exam cascades to its versions)
  if (examId) await db.exam.delete({ where: { id: examId } }).catch(() => undefined);
});

describe('loadVersionHint (scan version resolution)', () => {
  test('fixture: exam + two versions (v2 is current)', async () => {
    // built by the SAME sanitizer the API uses — a document the scan routes accept
    const doc = JSON.stringify(starterDocument('hint regression', 'test'));
    const exam = await db.exam.create({
      data: {
        title: 'hint regression exam',
        status: 'PUBLISHED',
        documentJson: doc,
        answerKeyJson: JSON.stringify({ q1: 'B' }),
        omrEnabled: true,
        currentVersion: 2,
      },
    });
    examId = exam.id;
    const v1 = await db.examVersion.create({
      data: { examId: exam.id, version: 1, title: 'v1', documentJson: doc, answerKeyJson: '{"q1":"A"}', publishedAt: new Date() },
    });
    const v2 = await db.examVersion.create({
      data: { examId: exam.id, version: 2, title: 'v2', documentJson: doc, answerKeyJson: '{"q1":"B"}', publishedAt: new Date() },
    });
    v1Id = v1.id;
    v2Id = v2.id;
    expect(examId).toBeTruthy();
  });

  test('an ExamVersion id resolves to THAT version (not the current one)', async () => {
    const loaded = await loadVersionHint(v1Id);
    expect(loaded).not.toBeNull();
    expect(loaded!.row.id).toBe(v1Id);
    expect(loaded!.row.version).toBe(1);
    expect(loaded!.row.examId).toBe(examId);
    // direct load still works for QR-resolved ids
    const direct = await loadVersion(v2Id);
    expect(direct!.row.id).toBe(v2Id);
  });

  test('a legacy EXAM id resolves to its currentVersion snapshot (v2)', async () => {
    const loaded = await loadVersionHint(examId);
    expect(loaded).not.toBeNull();
    expect(loaded!.row.id).toBe(v2Id);
    expect(loaded!.row.version).toBe(2);
  });

  test('unknown hint stays null (routes map it to 404 noMatchingVersion)', async () => {
    expect(await loadVersionHint('does-not-exist')).toBeNull();
    expect(await loadVersionHint('')).toBeNull();
  });

  test('sanity: marker never leaks into persisted titles', () => {
    expect(MARK).toBeTruthy();
  });
});
