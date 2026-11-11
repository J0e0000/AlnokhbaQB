// PATCH /api/admin/users/[id] { name?, role?, active?, password? }
// org_admin: only users inside own org, never super_admin rows, roles ≤ org_admin.
// super_admin: anyone except demoting/limiting themselves.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { audit, hashPassword, ROLES } from '@/lib/auth';
import { requireSession } from '../../../_lib/auth-guard';
import { serverError, readJsonBody, zodMessage } from '../../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await requireSession('org_admin', req);
  if ('error' in g) return g.error;
  const { id } = await ctx.params;

  const body = await readJsonBody(req);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

  try {
    const target = await db.user.findUnique({ where: { id }, include: { organization: true } });
    if (!target) return NextResponse.json({ error: 'المستخدم غير موجود' }, { status: 404 });

    const isSuper = g.session.role === 'super_admin';
    if (!isSuper) {
      if (target.organizationId !== g.session.orgId) {
        return NextResponse.json({ error: 'غير موجود أو لا تملك صلاحية الوصول' }, { status: 404 });
      }
      if (target.role === 'super_admin') {
        return NextResponse.json({ error: 'لا يمكنك تعديل مدير النظام' }, { status: 403 });
      }
      if (parsed.data.role === 'super_admin') {
        return NextResponse.json({ error: 'لا يمكنك منح دور مدير النظام' }, { status: 403 });
      }
    }
    if (target.id === g.session.uid && (parsed.data.active === false || (parsed.data.role && parsed.data.role !== 'super_admin' && isSuper))) {
      return NextResponse.json({ error: 'لا يمكنك تعطيل نفسك' }, { status: 400 });
    }

    const user = await db.user.update({
      where: { id: target.id },
      data: {
        name: parsed.data.name ?? undefined,
        role: parsed.data.role ?? undefined,
        active: parsed.data.active ?? undefined,
        passwordHash: parsed.data.password ? hashPassword(parsed.data.password) : undefined,
      },
    });

    await audit({
      session: g.session,
      action: 'user.update',
      entity: 'user',
      entityId: user.id,
      meta: { role: user.role, active: user.active, passwordChanged: Boolean(parsed.data.password) },
      req,
    });

    return NextResponse.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
