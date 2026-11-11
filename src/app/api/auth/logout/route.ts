// POST /api/auth/logout → clears the session cookie

import { NextResponse } from 'next/server';
import { audit, getSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const session = await getSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set('anqb_session', '', { httpOnly: true, path: '/', maxAge: 0 });
  if (session) {
    await audit({ session, action: 'logout', entity: 'user', entityId: session.uid, req });
  }
  return res;
}
