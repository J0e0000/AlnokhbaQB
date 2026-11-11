// POST /api/auth/login { email, password } → session cookie + user

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  audit,
  clientIp,
  createSessionToken,
  rateLimit,
  SESSION_COOKIE_OPTS,
  verifyPassword,
  type Role,
} from '@/lib/auth';
import { readJsonBody } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' }, { status: 400 });
  }

  const ip = clientIp(req);
  const email = parsed.data.email.trim().toLowerCase();

  if (!rateLimit(`login:${ip}`, 12, 60_000) || !rateLimit(`login:${email}`, 12, 60_000)) {
    return NextResponse.json(
      { error: 'محاولات كثيرة — انتظر دقيقة ثم أعد المحاولة' },
      { status: 429 }
    );
  }

  const user = await db.user.findUnique({
    where: { email },
    include: { organization: true },
  });

  if (!user || !user.active || !verifyPassword(parsed.data.password, user.passwordHash)) {
    await audit({ action: 'login.failed', entity: 'user', meta: { email }, req });
    return NextResponse.json(
      { error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' },
      { status: 401 }
    );
  }

  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const sessionUser = {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    orgId: user.organizationId,
    orgName: user.organization?.name ?? null,
  };

  const token = await createSessionToken(sessionUser);
  const res = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organizationId,
      organizationName: user.organization?.name ?? null,
      locale: user.locale,
    },
  });
  res.cookies.set('anqb_session', token, SESSION_COOKIE_OPTS);
  await audit({ session: sessionUser, action: 'login', entity: 'user', entityId: user.id, req });
  return res;
}
