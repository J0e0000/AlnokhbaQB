// ============================================================
// ALNOKHBA QB — shared-password session tokens (HMAC-SHA256)
//
// Token shape: base64url(payload) + "." + base64url(HMAC(payload))
//   payload = { iat, exp } epoch seconds; exp = iat + 7 days.
//
// Uses ONLY Web Crypto (crypto.subtle) so the same verifier runs in
// proxy.ts and in route handlers regardless of runtime. The signature
// check goes through crypto.subtle.verify, which compares in constant
// time.
// ============================================================

export const SESSION_COOKIE = 'qb_session';
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

/** True when the shared-password gate has everything it needs. */
export function authConfigured(): boolean {
  const p = process.env.APP_PASSWORD;
  const s = process.env.SESSION_SECRET;
  return typeof p === 'string' && p.length > 0 && typeof s === 'string' && s.length >= 32;
}

function toB64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const norm = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET ?? '';
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Mint a fresh session token (login route only). */
export async function createSessionToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = toB64url(
    new TextEncoder().encode(JSON.stringify({ iat: now, exp: now + SESSION_TTL_SEC })),
  );
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), new TextEncoder().encode(payload));
  return `${payload}.${toB64url(sig)}`;
}

/** Verify a presented session token (signature + expiry). */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token || !authConfigured()) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const validSig = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(),
      fromB64url(sig),
      new TextEncoder().encode(payload),
    );
    if (!validSig) return false;
    const json = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { exp?: number };
    return typeof json.exp === 'number' && json.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
