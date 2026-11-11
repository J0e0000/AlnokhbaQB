// ============================================================
// ALNOKHBA QB — proxy (Next.js 16 convention, Node runtime)
// Authenticates every /api/* request (except public endpoints)
// with the session JWT. Page requests fall through — the client
// app shows the login view when unauthenticated.
// (renamed from middleware.ts — Node-native proxy is also REQUIRED
// for Vercel Services mode, which rejects Edge runtime output)
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const SESSION_COOKIE = 'anqb_session';
const PUBLIC_API = new Set<string>([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/me',
  '/api/health',
]);

const SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET || 'alnokhba-qb-dev-secret-change-me-please-32ch'
);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_API.has(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await jwtVerify(token, SECRET);
      return NextResponse.next();
    } catch {
      // fall through to 401
    }
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول للمتابعة' }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
