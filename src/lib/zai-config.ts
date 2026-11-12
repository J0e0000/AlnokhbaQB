// ============================================================
// ALNOKHBA QB — z-ai SDK runtime config materializer.
// The SDK reads .z-ai-config from (1) process.cwd(), (2)
// os.homedir(), (3) /etc — none of which exist (or are writable)
// inside a Vercel serverless image. ZAI.create() therefore throws
// and every VLM-backed feature (OCR fallback) silently degrades.
// When the ZAI_CONFIG_JSON env var is set (same JSON schema as the
// config file: { baseUrl, apiKey }), materialize it into
// $HOME/.z-ai-config (os.tmpdir is the one writable dir) BEFORE
// the first create() — os.homedir() resolves $HOME on POSIX.
// No-op wherever a real config file already exists (local sandbox).
// ============================================================

import { existsSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_NAME = '.z-ai-config';

function looksValidConfig(raw: string): boolean {
  try {
    const cfg = JSON.parse(raw) as { baseUrl?: unknown; apiKey?: unknown };
    return typeof cfg.baseUrl === 'string' && !!cfg.baseUrl && typeof cfg.apiKey === 'string' && !!cfg.apiKey;
  } catch {
    return false;
  }
}

/** True when one of the SDK's default config paths already holds a valid config. */
function configExistsOnDisk(): boolean {
  const candidates = [
    path.join(process.cwd(), CONFIG_NAME),
    path.join(os.homedir(), CONFIG_NAME),
    '/etc/.z-ai-config',
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      if (looksValidConfig(readFileSync(p, 'utf8'))) return true;
    } catch {
      /* unreadable → treat as missing */
    }
  }
  return false;
}

const GLOBAL_KEY = '__alnokhbaZaiConfigState';
const globalForZai = globalThis as unknown as { __alnokhbaZaiConfigState?: boolean };

/**
 * Idempotent (once per process); call before every ZAI.create().
 * Returns true when a usable config is (or was made) available.
 */
export function ensureZaiConfig(): boolean {
  if (typeof globalForZai[GLOBAL_KEY] === 'boolean') return globalForZai[GLOBAL_KEY];
  let ok = false;
  try {
    if (configExistsOnDisk()) {
      ok = true;
    } else {
      const raw = process.env.ZAI_CONFIG_JSON?.trim();
      if (raw && looksValidConfig(raw)) {
        const home = os.tmpdir(); // the one writable dir on serverless
        writeFileSync(path.join(home, CONFIG_NAME), raw, { mode: 0o600 });
        process.env.HOME = home; // os.homedir() resolves $HOME on POSIX
        ok = true;
      }
    }
  } catch {
    ok = false;
  }
  globalForZai[GLOBAL_KEY] = ok;
  return ok;
}
