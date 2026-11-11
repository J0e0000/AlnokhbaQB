// ALNOKHBA QB — build-time Prisma provider switch.
// The committed schema targets sqlite (local dev). On Vercel the project is
// wired to a real Postgres via DATABASE_URL, so the build rewrites the
// provider in-place (the build container copy is ephemeral; the repo copy
// stays sqlite) BEFORE `prisma generate` runs.
import { readFileSync, writeFileSync } from 'fs';

const SCHEMA = 'prisma/schema.prisma';
const url = (process.env.DATABASE_URL || '').trim();

if (url.startsWith('postgres') || url.startsWith('postgresql')) {
  const before = readFileSync(SCHEMA, 'utf8');
  if (before.includes('provider = "sqlite"')) {
    writeFileSync(SCHEMA, before.replace('provider = "sqlite"', 'provider = "postgresql"'));
    console.log('[prisma-provider] DATABASE_URL is postgres → schema provider switched to postgresql');
  } else {
    console.log('[prisma-provider] schema already on postgresql');
  }
} else {
  console.log('[prisma-provider] no postgres DATABASE_URL → keeping sqlite schema');
}
