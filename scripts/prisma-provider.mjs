// ALNOKHBA QB — build-time Prisma provider switch.
// The committed schema targets sqlite (local dev). When the build runs with a
// postgres DATABASE_URL (Vercel go-live), the schema provider is rewritten
// in-place BEFORE `prisma generate` — the build container copy is ephemeral,
// the repo copy stays sqlite. Also injects directUrl for the pooled+direct
// Supabase setup when DIRECT_URL is provided.
import { readFileSync, writeFileSync } from 'fs';

const SCHEMA = 'prisma/schema.prisma';
const url = (process.env.DATABASE_URL || '').trim();

if (url.startsWith('postgres') || url.startsWith('postgresql')) {
  let schema = readFileSync(SCHEMA, 'utf8');
  if (schema.includes('provider = "sqlite"')) {
    schema = schema.replace('provider = "sqlite"', 'provider = "postgresql"');
    console.log('[prisma-provider] DATABASE_URL is postgres → provider switched to postgresql');
  } else {
    console.log('[prisma-provider] schema already on postgresql');
  }
  const directUrl = (process.env.DIRECT_URL || '').trim();
  if (directUrl && !schema.includes('directUrl')) {
    schema = schema.replace(
      /(datasource db \{[^}]*url\s*=\s*env\("DATABASE_URL"\))/,
      '$1\n  directUrl = env("DIRECT_URL")'
    );
    console.log('[prisma-provider] DIRECT_URL set → directUrl injected into the datasource');
  }
  writeFileSync(SCHEMA, schema);
} else {
  console.log('[prisma-provider] no postgres DATABASE_URL → keeping sqlite schema');
}
