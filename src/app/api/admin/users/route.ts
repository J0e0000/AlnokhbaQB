// Admin — users
// GET  /api/admin/users            → org_admin+: own org; super_admin: all (orgs preloaded)
// POST /api/admin/users            → create user (role ≤ own ceiling; org_admin pinned to own org)

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { audit, hashPassword, ROLES } from '@/lib/auth';
import { requireSession } from '../../_lib/auth-guard';
import { serverError, readJsonBody, zodMessage } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  role: z.enum(ROLES).default('teacher'),
  organizationId: z.string().max(64).nullish(),
});

export async function GET(req: Request) {
  const g = await requireSession('org_admin', req);
  if ('error' in g) return g.error;

  try {
    const isSuper = g.session.role === 'super_admin';
    const users = await db.user.findMany({
      where: isSuper ? {} : { organizationId: g.session.orgId },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { organization: { select: { name: true } } },
    });
    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        active: u.active,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        organizationId: u.organizationId,
        organizationName: u.organization?.name ?? null,
      })),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function POST(req: Request) {
  const g = await requireSession('org_admin', req);
  if ('error' in g) return g.error;

  const body = await readJsonBody(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }

  const isSuper = g.session.role === 'super_admin';
  let organizationId = parsed.data.organizationId ?? null;

  // permission ceilings
  if (!isSuper) {
    organizationId = g.session.orgId; // org_admin always creates inside own org
    if (parsed.data.role === 'super_admin') {
      return NextResponse.json({ error: 'لا يمكنك إنشاء مدير نظام' }, { status: 403 });
    }
  } else if (parsed.data.role === 'super_admin') {
    organizationId = null; // super admins are org-less
  }

  try {
    const email = parsed.data.email.trim().toLowerCase();
    const exists = await db.user.findUnique({ where: { email } });
    if (exists) return NextResponse.json({ error: 'هذا البريد مسجل بالفعل' }, { status: 409 });

    const user = await db.user.create({
      data: {
        email,
        name: parsed.data.name.trim(),
        passwordHash: hashPassword(parsed.data.password),
        role: parsed.data.role,
        organizationId,
      },
    });

    await audit({
      session: g.session,
      action: 'user.create',
      entity: 'user',
      entityId: user.id,
      meta: { email: user.email, role: user.role },
      req,
    });

    return NextResponse.json(
      { id: user.id, email: user.email, name: user.name, role: user.role, organizationId: user.organizationId },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
