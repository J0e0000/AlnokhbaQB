// POST /api/auth/register { name, email, password, organizationName }
// Open registration creates a NEW organisation with the registrant as its
// org_admin. Users inside an existing organisation are added by an admin.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  audit,
  clientIp,
  createSessionToken,
  hashPassword,
  rateLimit,
  SESSION_COOKIE_OPTS,
  type Role,
} from '@/lib/auth';
import { readJsonBody } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  organizationName: z.string().min(2).max(160),
});

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'بيانات غير مكتملة — الاسم والبريد وكلمة مرور (٨ أحرف على الأقل) واسم المؤسسة مطلوبة' },
      { status: 400 }
    );
  }

  const ip = clientIp(req);
  if (!rateLimit(`register:${ip}`, 5, 300_000)) {
    return NextResponse.json({ error: 'محاولات كثيرة — حاول بعد قليل' }, { status: 429 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: 'هذا البريد مسجل بالفعل' }, { status: 409 });
  }

  const org = await db.organization.create({
    data: { name: parsed.data.organizationName.trim() },
  });

  const user = await db.user.create({
    data: {
      email,
      name: parsed.data.name.trim(),
      passwordHash: hashPassword(parsed.data.password),
      role: 'org_admin',
      organizationId: org.id,
    },
    include: { organization: true },
  });

  const sessionUser = {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    orgId: user.organizationId,
    orgName: user.organization?.name ?? null,
  };

  const token = await createSessionToken(sessionUser);
  const res = NextResponse.json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
        organizationName: user.organization?.name ?? null,
        locale: user.locale,
      },
    },
    { status: 201 }
  );
  res.cookies.set('anqb_session', token, SESSION_COOKIE_OPTS);
  await audit({
    session: sessionUser,
    action: 'register',
    entity: 'organization',
    entityId: org.id,
    meta: { organization: org.name },
    req,
  });
  return res;
}
