import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

/**
 * Resolve the Prisma datasource at runtime so every deployment target works
 * with the SAME codebase:
 *
 *  - external PostgreSQL (Vercel Postgres / Neon / any pg:// URL):
 *      passed through — pooled Neon endpoints (-pooler.) additionally get
 *      `pgbouncer=true` so Prisma disables prepared statements that a
 *      transaction-mode pooler cannot replay.
 *
 *  - self-hosted (dev sandbox / VPS standalone / Docker):
 *      DATABASE_URL from the environment (.env) — file: SQLite —
 *      passed through untouched.
 *
 *  - serverless (Vercel & friends, detected via VERCEL=1):
 *      SQLite fallback: the runtime FS is READ-ONLY and ephemeral, so the
 *      bundled seed database (db/custom.db) is materialized into /tmp once
 *      per instance. With a real postgres DATABASE_URL this branch is never
 *      reached — production data lives in Postgres.
 */
function resolveDatasourceUrl(): string | undefined {
  let url = process.env.DATABASE_URL
  if (url && !url.startsWith('file:')) {
    // Neon/Vercel pooled endpoint → hint Prisma for transaction-mode pooling
    if (url.includes('-pooler.') && !url.includes('pgbouncer=')) {
      url += (url.includes('?') ? '&' : '?') + 'pgbouncer=true&connect_timeout=15'
    }
    return url
  }

  if (process.env.VERCEL) {
    const tmpDb = '/tmp/alnokhba.db'
    try {
      if (!fs.existsSync(tmpDb) || fs.statSync(tmpDb).size === 0) {
        const bundled = path.join(process.cwd(), 'db', 'custom.db')
        if (fs.existsSync(bundled)) {
          fs.copyFileSync(bundled, tmpDb)
        }
      }
    } catch {
      /* bootstrap failure surfaces as a real Prisma error on first query */
    }
    return `file:${tmpDb}`
  }

  return url || undefined
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const datasourceUrl = resolveDatasourceUrl()

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
    ...(datasourceUrl ? { datasourceUrl } : {}),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
