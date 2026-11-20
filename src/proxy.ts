// ============================================================
// ALNOKHBA QB — proxy (Next.js 16 file convention, Node runtime)
//
// Shared-password gate. Every /api/* request and every page request
// needs a valid qb_session cookie, except:
//   • /login                 (the gate page itself)
//   • /api/auth/*            (login/logout)
//   • /api/health            (public — the route strips internals itself)
//
// Unauthenticated /api/* → 401 JSON; pages → redirect to /login.
// FAIL-OPEN: when APP_PASSWORD/SESSION_SECRET are not set yet the gate
// is open so a deploy never locks the owner out before the env vars
// exist. Set both env vars to activate the gate.
//
// Matcher note: all of /_next is excluded (not just _next/static and
// _next/image) — dev-mode HMR endpoints and build assets carry no app
// data and must never be caught by the redirect.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { authConfigured, verifySessionToken, SESSION_COOKIE } from '@/lib/auth/session';

const PUBLIC_PATHS = new Set(['/login']);
const PUBLIC_API_PREFIXES = ['/api/auth/', '/api/health'];

export async function proxy(req: NextRequest) {
  if (!authConfigured()) return NextResponse.next(); // fail-open until env vars exist

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'غير مصرح' }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = `next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next|favicon.ico).*)'],
};
