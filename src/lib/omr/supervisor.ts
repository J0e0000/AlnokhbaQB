// ============================================================
// ALNOKHBA QB — OMR engine local supervisor (dev / self-hosted)
// The engine is a Python/OpenCV sidecar on 127.0.0.1:3032. In the
// sandbox/dev boot it is normally launched by `bun run watch.ts`
// (mini-services/omr-engine). When it is NOT running (fresh boot
// order, crashed watcher, manual self-host without a supervisor),
// the app can spawn it itself as a detached child of the Next.js
// server process — which is exactly the lifetime we want.
//
// NEVER active on Vercel: serverless has no persistent process
// model; there the engine is omr-service/ (Python runtime) routed
// at /api/omr via vercel.json, or an external OMR_ENGINE_URL.
// ============================================================

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const ENGINE_PORT = 3032;

/** Base URL of the engine: explicit OMR_ENGINE_URL wins, else the local sidecar. */
export function engineBaseUrl(): string {
  return (
    process.env.OMR_ENGINE_URL?.trim()?.replace(/\/+$/, '') ||
    `http://127.0.0.1:${ENGINE_PORT}`
  );
}

const healthUrl = () => `${engineBaseUrl()}/health`;

let spawned: ChildProcess | null = null;

function supervisorEnabled(): boolean {
  // explicit opt-out always wins
  if (process.env.OMR_SUPERVISOR === '0') return false;
  // Vercel serverless: no persistent child processes, engine is external
  if (process.env.VERCEL) return false;
  // explicit external engine URL → not ours to manage
  if (process.env.OMR_ENGINE_URL?.trim()) return false;
  return true;
}

/**
 * Resolve the Python interpreter that has cv2/numpy installed.
 * Order: PYTHON_BIN → $HOME/.venv/bin/python3 → PATH python3.
 * Mirrors mini-services/omr-engine/watch.ts.
 */
export function resolvePythonBin(): string {
  const explicit = process.env.PYTHON_BIN?.trim();
  if (explicit) return explicit;
  const home = process.env.HOME?.trim();
  if (home && existsSync(`${home}/.venv/bin/python3`)) {
    return `${home}/.venv/bin/python3`;
  }
  return 'python3';
}

export async function engineHealthy(timeoutMs = 2500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(healthUrl(), { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Spawn the python sidecar detached from the request lifecycle. */
function spawnEngine(): ChildProcess | null {
  const dir = path.join(process.cwd(), 'mini-services', 'omr-engine');
  const entry = path.join(dir, 'server.py');
  if (!existsSync(entry)) return null;
  const child = spawn(resolvePythonBin(), ['-u', entry], {
    cwd: dir,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, OMR_ENGINE_HOST: '127.0.0.1', OMR_ENGINE_PORT: String(ENGINE_PORT) },
  });
  child.unref();
  child.on('error', () => {
    spawned = null;
  });
  child.on('exit', () => {
    if (spawned === child) spawned = null;
  });
  spawned = child;
  return child;
}

export interface SupervisorResult {
  ok: boolean;
  engineUrl: string;
  action: 'already-running' | 'spawned' | 'spawn-failed' | 'disabled';
  detail?: string;
}

/**
 * Ensure the local engine sidecar is up: probe → (spawn → wait → probe).
 * Returns a supervisor-neutral result; the API route decides the status code.
 */
export async function ensureEngine(): Promise<SupervisorResult> {
  const engineUrl = engineBaseUrl();
  if (!supervisorEnabled()) {
    return { ok: await engineHealthy(), engineUrl, action: 'disabled' };
  }
  if (await engineHealthy()) {
    return { ok: true, engineUrl, action: 'already-running' };
  }
  const child = spawnEngine();
  if (!child) {
    return {
      ok: false,
      engineUrl,
      action: 'spawn-failed',
      detail: `engine entry not found at ${entryPath()}`,
    };
  }
  // cold start: python + cv2 + numpy import takes several seconds
  for (let waited = 0; waited < 30_000; waited += 700) {
    await new Promise((r) => setTimeout(r, 700));
    if (await engineHealthy(1500)) {
      return { ok: true, engineUrl, action: 'spawned' };
    }
  }
  return {
    ok: false,
    engineUrl,
    action: 'spawn-failed',
    detail: 'engine did not become healthy within 30s (check python cv2/numpy availability)',
  };
}

function entryPath(): string {
  return path.join(process.cwd(), 'mini-services', 'omr-engine', 'server.py');
}
