// ============================================================
// ALNOKHBA QB — one-shot data mover: SQLite → Postgres (go-live)
//
//   bun scripts/export-sqlite.ts export   # db/custom.db → db/data-export.json
//   bun scripts/export-sqlite.ts import   # db/data-export.json → DATABASE_URL
//
// The export mode runs against the sqlite client (the committed schema).
// Run the import AFTER the provider is switched to postgresql (set
// DATABASE_URL/DIRECT_URL so scripts/prisma-provider.mjs rewrites the
// schema, then `prisma generate`) — e.g. on the postgres-migration branch
// or once the build-time switch is active. Tables are written in FK-safe
// order with createMany({ skipDuplicates: true }).
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({ log: ['error'] });
const EXPORT_FILE = 'db/data-export.json';

// FK-safe order: parents before children.
const TABLES = [
  'exam',
  'examVersion',
  'student',
  'question',
  'calibrationProfile',
  'assignment',
  'assignmentSubmission',
  'examAttempt',
  'scan',
] as const;

type TableKey = (typeof TABLES)[number];
type Row = Record<string, unknown>;

const DATE_SUFFIX_RE = /(At|_at)$|expiresAt|submittedAt|usedAt|dueAt|publishedAt|startedAt|windowStart|createdAt|updatedAt/;

function reviveDates(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && DATE_SUFFIX_RE.test(k) ? new Date(v) : v;
  }
  return out;
}

async function exportData() {
  const dump: Record<string, Row[]> = {};
  for (const table of TABLES) {
    const model = (db as unknown as Record<string, { findMany: (args?: unknown) => Promise<Row[]> }>)[table];
    // eslint-disable-next-line no-await-in-loop
    dump[table] = await model.findMany({});
  }
  const payload = { exportedAt: new Date().toISOString(), tables: dump };
  const counts = TABLES.map((t) => `${t}=${dump[t].length}`).join(' ');
  writeFileSync(EXPORT_FILE, JSON.stringify(payload, null, 1), 'utf8');
  console.log(`[export-sqlite] wrote ${EXPORT_FILE} — ${counts}`);
}

async function importData() {
  const payload = JSON.parse(readFileSync(EXPORT_FILE, 'utf8')) as {
    exportedAt: string;
    tables: Record<string, Row[]>;
  };
  for (const table of TABLES) {
    const rows = payload.tables[table] ?? [];
    if (rows.length === 0) {
      console.log(`[import] ${table}: 0 rows — skipped`);
      continue;
    }
    const model = (db as unknown as Record<string, { createMany: (args: unknown) => Promise<{ count: number }> }>)[table];
    // eslint-disable-next-line no-await-in-loop
    const res = await model.createMany({
      data: rows.map(reviveDates),
      skipDuplicates: true,
    });
    console.log(`[import] ${table}: ${res.count}/${rows.length} rows inserted`);
  }
  console.log(`[import] done (export originated ${payload.exportedAt})`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'export') await exportData();
  else if (mode === 'import') await importData();
  else {
    console.error('usage: bun scripts/export-sqlite.ts <export|import>');
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('[export-sqlite] failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
