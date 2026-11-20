// ============================================================
// ALNOKHBA QB — Auth core (server-only)
// JWT (jose, HS256, httpOnly cookie) + bcrypt password hashing
// + role hierarchy + audit log helper + in-memory rate limiting.
// ============================================================

import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';

export const SESSION_COOKIE = 'anqb_session';
const ALG = 'HS256';
const SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET || 'alnokhba-qb-dev-secret-change-me-please-32ch'
);

export type Role = 'super_admin' | 'org_admin' | 'teacher' | 'viewer';
export const ROLES: Role[] = ['viewer', 'teacher', 'org_admin', 'super_admin'];

export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  teacher: 1,
  org_admin: 2,
  super_admin: 3,
};

export const ROLE_LABEL_AR: Record<Role, string> = {
  super_admin: 'مدير النظام',
  org_admin: 'مدير المؤسسة',
  teacher: 'معلم / محرر',
  viewer: 'مشاهد',
};

export interface SessionUser {
  uid: string;
  email: string;
  name: string;
  role: Role;
  orgId: string | null;
  orgName: string | null;
}

// ---------- passwords ----------

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

export function verifyPassword(pw: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(pw, hash);
  } catch {
    return false;
  }
}

// ---------- tokens ----------

export async function createSessionToken(u: SessionUser): Promise<string> {
  return await new SignJWT({ email: u.email, name: u.name, role: u.role, orgId: u.orgId, orgName: u.orgName })
    .setProtectedHeader({ alg: ALG })
    .setSubject(u.uid)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET);
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (!payload.sub || typeof payload.role !== 'string') return null;
    return {
      uid: payload.sub,
      email: (payload.email as string) ?? '',
      name: (payload.name as string) ?? '',
      role: payload.role as Role,
      orgId: (payload.orgId as string | null) ?? null,
      orgName: (payload.orgName as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionUser | null> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return await verifySessionToken(token);
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
};

// ---------- roles ----------

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Prisma `where` value for organization scoping.
 * super_admin sees everything (undefined = no filter).
 * Everyone else is pinned to their organisation (null → unassigned rows).
 */
export function orgFilter(session: SessionUser): string | null | undefined {
  if (session.role === 'super_admin') return undefined;
  return session.orgId;
}

// ---------- audit ----------

export interface AuditEntry {
  session?: SessionUser | null;
  action: string;
  entity: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  req?: Request;
  organizationId?: string | null;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: entry.session?.uid ?? null,
        userEmail: entry.session?.email ?? null,
        organizationId: entry.organizationId ?? entry.session?.orgId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        metaJson: JSON.stringify(entry.meta ?? {}),
        ip:
          entry.req?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
          entry.req?.headers.get('x-real-ip') ??
          null,
      },
    });
  } catch (e) {
    console.error('[audit] failed to write entry', e);
  }
}

// ---------- rate limiting (in-memory fixed window) ----------

interface Bucket {
  count: number;
  reset: number;
}

const g = globalThis as unknown as { __anqbRate?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = g.__anqbRate ?? (g.__anqbRate = new Map());

/** Returns true when allowed; false = over the limit. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}
