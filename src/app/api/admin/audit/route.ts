// GET /api/admin/audit?limit=&action= → recent audit entries (org-scoped; super_admin sees all)

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSession } from '../../_lib/auth-guard';
import { serverError } from '../../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const g = await requireSession('org_admin', req);
  if ('error' in g) return g.error;

  try {
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '150', 10) || 150, 300);
    const action = url.searchParams.get('action');

    const entries = await db.auditLog.findMany({
      where: {
        ...(g.session.role === 'super_admin' ? {} : { organizationId: g.session.orgId }),
        ...(action ? { action } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return NextResponse.json({
      entries: entries.map((e) => {
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(e.metaJson || '{}');
        } catch { /* ignore */ }
        return {
          id: e.id,
          action: e.action,
          entity: e.entity,
          entityId: e.entityId,
          userEmail: e.userEmail,
          meta,
          ip: e.ip,
          createdAt: e.createdAt,
        };
      }),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
