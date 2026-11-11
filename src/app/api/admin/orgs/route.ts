// GET /api/admin/orgs → super_admin only: all organisations with user counts

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSession } from '../../_lib/auth-guard';
import { serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const g = await requireSession('super_admin', req);
  if ('error' in g) return g.error;

  try {
    const orgs = await db.organization.findMany({
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { users: { select: { id: true, active: true } } },
    });
    return NextResponse.json({
      organizations: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        userCount: o.users.length,
        activeUsers: o.users.filter((u) => u.active).length,
      })),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
