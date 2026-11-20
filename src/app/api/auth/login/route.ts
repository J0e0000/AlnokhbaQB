// POST /api/auth/login — shared-password gate
// Body: { password }. On success sets qb_session = HMAC-SHA256-signed
// {iat, exp=7d} token cookie (httpOnly, secure, sameSite=lax, path=/).

import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import {
  authConfigured,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
} from '@/lib/auth/session';
import { clientIp, rateLimit } from '@/lib/auth/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_TRIES = 5; // per IP per window

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export async function POST(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      {
        error:
          'خدمة الدخول غير مهيأة — اضبط APP_PASSWORD و SESSION_SECRET (٣٢ حرفًا على الأقل) على الخادم',
      },
      { status: 503 },
    );
  }

  const rl = await rateLimit(`login:${clientIp(req)}`, LOGIN_MAX_TRIES, LOGIN_WINDOW_MS);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `محاولات دخول كثيرة — حاول مجددًا بعد ${Math.ceil(rl.retryAfterSec / 60)} دقيقة` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  let password = '';
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body?.password === 'string') password = body.password;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400 });
  }

  // Constant-time comparison: hash both sides to a fixed length first so the
  // comparison can leak neither the password value nor its length.
  const presented = sha256(password);
  const expected = sha256(process.env.APP_PASSWORD ?? '');
  const ok = presented.length === expected.length && timingSafeEqual(presented, expected);

  if (!ok) {
    return NextResponse.json({ error: 'كلمة المرور غير صحيحة' }, { status: 401 });
  }

  const token = await createSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  });
  return res;
}
