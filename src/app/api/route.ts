import { NextResponse } from "next/server";
import { requireSession } from "./_lib/auth-guard";

export async function GET(req: Request) {
  const g = await requireSession('viewer', req);
  if ('error' in g) return g.error;
  return NextResponse.json({ message: "Hello, world!" });
}
