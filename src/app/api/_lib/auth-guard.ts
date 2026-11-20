// ============================================================
// ALNOKHBA QB — API auth guard helpers (server-only)
// Usage inside a route handler:
//   const g = await requireSession(req, 'teacher');
//   if ('error' in g) return g.error;
//   const session = g.session;
// ============================================================

import { NextResponse } from 'next/server';
import { getSession, roleAtLeast, rateLimit, clientIp, type Role, type SessionUser } from '@/lib/auth';

export interface GuardOk {
  session: SessionUser;
}
export interface GuardFail {
  error: NextResponse;
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'يجب تسجيل الدخول للمتابعة' }, { status: 401 });
}

export function forbidden(msg = 'ليس لديك صلاحية لتنفيذ هذا الإجراء'): NextResponse {
  return NextResponse.json({ error: msg }, { status: 403 });
}

export async function requireSession(min: Role = 'viewer', req?: Request): Promise<GuardOk | GuardFail> {
  const session = await getSession();
  if (!session) return { error: unauthorized() };
  if (!roleAtLeast(session.role, min)) return { error: forbidden() };
  if (req) {
    // per-user API rate limit (generous; auth routes have their own stricter limits)
    if (!rateLimit(`api:${session.uid}`, 600, 60_000)) {
      return { error: NextResponse.json({ error: 'عدد كبير من الطلبات — حاول بعد قليل' }, { status: 429 }) };
    }
    void clientIp(req);
  }
  return { session };
}

/** Writes a redirect-safe org id for create/update payloads. */
export function sessionOrgId(session: SessionUser): string | null {
  return session.orgId;
}
