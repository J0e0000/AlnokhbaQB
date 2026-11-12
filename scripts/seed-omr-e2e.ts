// ============================================================
// ALNOKHBA QB — seed the OMR E2E fixture exam/version into the DB.
// Run:  bun scripts/seed-omr-e2e.ts
//
// Materializes the exact ExamVersion the tests/omr-fixtures sheet QR points
// at (examVersionId cmug687vk0002kxvn7rhby9f7, templateId
// T-cmug687vk0002kxvn7rhby9f7) so the shipped fixture sheet scans through
// the REAL API (QR → version → template → grade → DB). Idempotent: safe to
// re-run, never touches unrelated data.
// ============================================================

import { readFileSync } from 'fs';
import path from 'path';
import { db } from '@/lib/db';

const FIXTURES = path.join(process.cwd(), 'tests', 'omr-fixtures');
const EXAM_ID = 'cmug687vg0000kxvn1co2tfkb';
const VERSION_ID = 'cmug687vk0002kxvn7rhby9f7';

async function main() {
  const documentJson = readFileSync(path.join(FIXTURES, 'document.json'), 'utf8');
  const answerKeyJson = readFileSync(path.join(FIXTURES, 'answer_key.json'), 'utf8');
  const template = JSON.parse(readFileSync(path.join(FIXTURES, 'template.json'), 'utf8'));

  const exam = await db.exam.upsert({
    where: { id: EXAM_ID },
    create: {
      id: EXAM_ID,
      title: 'امتحان تجريبي شامل — النخبة (E2E fixture)',
      status: 'PUBLISHED',
      documentJson,
      answerKeyJson,
      omrEnabled: true,
      currentVersion: 1,
    },
    update: {
      documentJson,
      answerKeyJson,
      omrEnabled: true,
      currentVersion: 1,
    },
  });

  const version = await db.examVersion.upsert({
    where: { id: VERSION_ID },
    create: {
      id: VERSION_ID,
      examId: exam.id,
      version: 1,
      title: 'E2E fixture version',
      documentJson,
      answerKeyJson,
      omrTemplateJson: JSON.stringify(template),
      publishedAt: new Date(),
    },
    update: {
      documentJson,
      answerKeyJson,
      omrTemplateJson: JSON.stringify(template),
    },
  });

  console.log(`[seed-omr-e2e] exam=${exam.id} version=${version.id} (template ${template.templateId})`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-omr-e2e] FAILED:', err);
    process.exit(1);
  });
