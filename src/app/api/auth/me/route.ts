// GET /api/auth/me → current session user (or { user: null })

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null });

  // Always re-read from DB so role/org changes take effect without re-login
  const user = await db.user.findUnique({
    where: { id: session.uid },
    include: { organization: true },
  });

  if (!user || !user.active) {
    return NextResponse.json({ user: null });
  }

  return NextResponse.json({
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
}
