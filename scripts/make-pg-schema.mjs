// ALNOKHBA QB — generate a TEMPORARY postgres-typed Prisma client to
// src/generated/pg (schema copy with provider=postgresql), without touching
// the default sqlite client in node_modules. Used by the one-shot data
// migration (scripts/migrate-data.mjs). Safe to delete afterwards.
import { copyFileSync, readFileSync, writeFileSync, rmSync } from 'fs';

const SRC = 'prisma/schema.prisma';
const TMP = 'prisma/schema.pg.prisma';

let s = readFileSync(SRC, 'utf8');
s = s.replace('provider = "sqlite"', 'provider = "postgresql"');
s = s.replace(
  /generator client \{[^}]*\}/,
  `generator client {\n  provider = "prisma-client-js"\n  output   = "../src/generated/pg"\n}`
);
writeFileSync(TMP, s);
console.log('[make-pg-schema] wrote', TMP);
