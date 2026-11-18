// GET /api/pw/health — which server engines are available (used by the UI).

import { NextResponse } from 'next/server';
import { engineAvailability } from '@/lib/pw/server/engines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ engines: engineAvailability(), ts: Date.now() });
}
