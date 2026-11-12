// ============================================================
// ALNOKHBA QB — omr-engine mini-service launcher/supervisor
// (Z.ai artifact deployment + local bundle runs).
//
// The engine itself is a Python stdlib HTTP server (server.py, port 3032).
// This wrapper exists ONLY because .zscripts/mini-services-build.sh requires
// an index.ts entrypoint to emit mini-service-omr-engine.js, and
// mini-services-start.sh runs that bundle. The Python runtime files
// (server.py, engine/, tessdata/, requirements.txt) are copied next to the
// bundle by mini-services-build.sh; their dependencies (cv2/numpy/pymupdf)
// are installed into the artifact's python-runtime site-packages by
// python-runtime-build.sh and exposed via PYTHONPATH by start.sh.
//
// Supervisor contract (production):
//   1. spawn `python3 -u server.py` (unbuffered → logs stream to the
//      platform log; python's own output stays visible for diagnostics)
//   2. WAIT for GET /health to return 200 before declaring readiness —
//      startup failure is loud and exits non-zero, never a silent half-start
//   3. restart the child on crash with a small backoff (bounded), so a
//      transient OpenCV crash heals itself instead of taking scans down
//   4. forward SIGTERM/SIGINT → SIGTERM to the child, then exit
//
// Binding stays on 127.0.0.1 — the Next.js server self-calls the engine on
// the same host, and loopback keeps the OMR_SHARED_SECRET requirement
// optional (server.py refuses non-loopback binds without a secret).
// ============================================================

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const LOG = '[omr-engine]';

// bun exposes import.meta.dir; the cast keeps tsc (Next's tsconfig) happy —
// same pattern as watch.ts in this folder.
const DIR = (import.meta as unknown as { dir: string }).dir;
const candidates = [
  // running from source (bun run dev / manual)
  path.join(DIR, 'server.py'),
  // running from the built bundle (mini-services-dist/mini-service-omr-engine.js)
  path.join(DIR, 'omr-engine', 'server.py'),
];
const serverPy = candidates.find((p) => existsSync(p));

if (!serverPy) {
  console.error(
    `${LOG} FATAL: server.py not found — looked in: ${candidates.join(', ')}`
  );
  process.exit(1);
}

const engineDir = path.dirname(serverPy);
const python = process.env.OMR_PYTHON?.trim() || 'python3';
const port = process.env.OMR_ENGINE_PORT?.trim() || '3032';
const healthUrl = `http://127.0.0.1:${port}/health`;

// ---- tunables (env-overridable, safe defaults) ----
const START_TIMEOUT_MS = Number(process.env.OMR_START_TIMEOUT_MS ?? 30_000);
const HEALTH_POLL_MS = 500;
const MAX_RESTARTS = 5; // within RESTART_WINDOW_MS, else give up loudly
const RESTART_WINDOW_MS = 60_000;
const RESTART_BACKOFF_MS = 1_000;

let child: ReturnType<typeof spawn> | null = null;
let stopping = false;
let restarts = 0;
const restartWindowStart = Date.now();

function logInfo(msg: string) {
  console.log(`${LOG} ${msg}`);
}
function logErr(msg: string) {
  console.error(`${LOG} ${msg}`);
}

/** Poll /health until it answers 200 or the timeout elapses. */
async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopping) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(healthUrl, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      /* child not up yet */
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function spawnChild(): ReturnType<typeof spawn> {
  const c = spawn(python, ['-u', 'server.py'], {
    cwd: engineDir,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  logInfo(`spawned ${python} -u server.py (pid=${c.pid}, dir=${engineDir}, port=${port})`);
  return c;
}

function fatalNotReady(): never {
  logErr(
    `FATAL: /health did not become ready within ${START_TIMEOUT_MS}ms at ${healthUrl}. ` +
      `Check the python stderr above — common causes: missing cv2/numpy/pymupdf ` +
      `(python-runtime build did not install mini-services/omr-engine/requirements.txt), ` +
      `port ${port} already in use (set OMR_ENGINE_PORT), or a crash loop (see restarts).`
  );
  try {
    child?.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  process.exit(1);
}

async function bootAndVerify(): Promise<void> {
  const startedAt = Date.now();
  const ok = await waitForHealth(START_TIMEOUT_MS);
  if (stopping) return;
  if (ok) {
    logInfo(`/health OK in ${Date.now() - startedAt}ms — engine ready on ${healthUrl}`);
    return;
  }
  fatalNotReady();
}

/** Shared crash handler — re-attached to every respawned child. */
function onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
  if (stopping) {
    logInfo('python exited (shutdown requested)');
    process.exit(0);
  }
  logErr(`python exited unexpectedly (code=${code} signal=${signal})`);
  // bounded-restart policy: heal transient crashes, give up on a crash loop
  if (Date.now() - restartWindowStart > RESTART_WINDOW_MS) {
    restarts = 0;
  }
  restarts += 1;
  if (restarts > MAX_RESTARTS) {
    logErr(
      `FATAL: ${restarts} crashes inside the restart window — crash loop suspected, ` +
        `giving up. Inspect the python stderr above for the root cause.`
    );
    process.exit(1);
  }
  logInfo(`restarting in ${RESTART_BACKOFF_MS}ms (restart ${restarts}/${MAX_RESTARTS})`);
  setTimeout(() => {
    if (stopping) return;
    child = spawnChild();
    child.on('exit', onChildExit);
  }, RESTART_BACKOFF_MS);
}

child = spawnChild();
child.on('exit', onChildExit);
void bootAndVerify();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    logInfo(`received ${sig} — shutting engine down cleanly`);
    try {
      child?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    // hard exit fallback if the child ignores SIGTERM
    setTimeout(() => process.exit(0), 4000).unref();
  });
}

// keep the event loop alive for as long as the python child runs
setInterval(() => {}, 1 << 30);
