// ALNOKHBA QB — one-shot data migration SQLite → Postgres.
// Run: bun scripts/migrate-data.mjs "<postgres-direct-url>"
// Reads every model from the local SQLite db (custom.db, via the default
// @prisma client = sqlite) and re-inserts into Postgres (via the postgres
// client generated to src/generated/pg — see scripts/make-pg-schema.mjs).
// Preserves ids/cuids so exam QR codes, templates and audit trails stay valid.

import { PrismaClient as SqliteClient } from '@prisma/client';

const pgUrl = process.argv[2] || process.env.PG_URL || '';
if (!pgUrl.startsWith('postgres')) {
  console.error('usage: bun scripts/migrate-data.mjs "<postgres url>"');
  process.exit(1);
}

// postgres client is generated to src/generated/pg by make-pg-schema.mjs
const pgMod = await import('../src/generated/pg/client.js');
const PgClient = pgMod.PrismaClient ?? pgMod.default?.PrismaClient;
if (!PgClient) {
  console.error('postgres client not found at src/generated/pg — run make-pg-schema.mjs first');
  process.exit(1);
}

const sqlite = new SqliteClient({
  datasourceUrl: 'file:/home/z/my-project/db/custom.db',
});
const pg = new PgClient({ datasourceUrl: pgUrl });

// FK-safe insertion order
const MODELS = [
  'organization',
  'user',
  'taxonomyTerm',
  'bankDocument',
  'extractionJob',
  'extractedQuestion',
  'exam',
  'question',
  'examVersion',
  'examAttempt',
  'assignment',
  'assignmentSubmission',
  'student',
  'scan',
  'calibrationProfile',
  'auditLog',
];

function countRows(rows) {
  return rows.length;
}

async function main() {
  const summary = [];
  for (const model of MODELS) {
    const rows = await sqlite[model].findMany();
    let inserted = 0;
    if (rows.length) {
      // chunked createMany (Neon parameter limits are generous; 50 is safe)
      for (let i = 0; i < rows.length; i += 50) {
        const chunk = rows.slice(i, i + 50);
        const res = await pg[model].createMany({ data: chunk });
        inserted += res.count;
      }
    }
    summary.push(`${model}: ${countRows(rows)} read → ${inserted} written`);
  }
  console.log(summary.join('\n'));
  const checks = await Promise.all([
    pg.user.count(),
    pg.exam.count(),
    pg.examVersion.count(),
    pg.scan.count(),
  ]);
  console.log(`verify → users:${checks[0]} exams:${checks[1]} versions:${checks[2]} scans:${checks[3]}`);
}

main()
  .catch((err) => {
    console.error('MIGRATION FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sqlite.$disconnect().catch(() => {});
    await pg.$disconnect().catch(() => {});
  });
