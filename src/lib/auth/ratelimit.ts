// ============================================================
// ALNOKHBA QB — Prisma-backed fixed-window rate limiter
//
// No external service: one row per "<scope>:<client>" key in the
// RateLimitBucket table; the counter resets when the window elapses.
// Stale rows are swept best-effort on window rotation. The limiter
// fails OPEN on database errors so it can never take the app down.
// ============================================================

import { db } from '@/lib/db';

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** Best-effort client IP (Vercel sets x-forwarded-for; fall back to x-real-ip). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = new Date();
  try {
    const bucket = await db.rateLimitBucket.findUnique({ where: { key } });

    if (!bucket || now.getTime() - bucket.windowStart.getTime() >= windowMs) {
      const staleBefore = new Date(now.getTime() - 6 * 60 * 60 * 1000);
      await Promise.all([
        db.rateLimitBucket.upsert({
          where: { key },
          create: { key, count: 1, windowStart: now },
          update: { count: 1, windowStart: now },
        }),
        db.rateLimitBucket
          .deleteMany({ where: { windowStart: { lt: staleBefore } } })
          .catch(() => undefined),
      ]);
      return { ok: true, remaining: limit - 1, retryAfterSec: 0 };
    }

    if (bucket.count >= limit) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000),
      );
      return { ok: false, remaining: 0, retryAfterSec };
    }

    const updated = await db.rateLimitBucket.update({
      where: { key },
      data: { count: { increment: 1 } },
    });
    return { ok: true, remaining: Math.max(0, limit - updated.count), retryAfterSec: 0 };
  } catch {
    return { ok: true, remaining: limit, retryAfterSec: 0 };
  }
}
