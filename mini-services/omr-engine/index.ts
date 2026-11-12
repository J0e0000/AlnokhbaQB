// ============================================================
// ALNOKHBA QB — omr-engine mini-service launcher (Z.ai deployment).
//
// The engine itself is a Python stdlib HTTP server (server.py, port 3032).
// This wrapper exists ONLY because .zscripts/mini-services-build.sh requires
// an index.ts entrypoint to emit mini-service-omr-engine.js, and
// mini-services-start.sh runs that bundle. The Python runtime files
// (server.py, engine/, tessdata/) are copied next to the bundle by
// mini-services-build.sh.
//
// Binding stays on 127.0.0.1 — the Next.js server self-calls the engine on
// the same host, and loopback keeps the OMR_SHARED_SECRET requirement
// optional (server.py refuses non-loopback binds without a secret).
// ============================================================

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const candidates = [
  // running from source (bun run dev / manual)
  path.join(import.meta.dir, 'server.py'),
  // running from the built bundle (mini-services-dist/mini-service-omr-engine.js)
  path.join(import.meta.dir, 'omr-engine', 'server.py'),
];
const serverPy = candidates.find((p) => existsSync(p));

if (!serverPy) {
  console.error('[omr-engine] server.py not found — looked in:', candidates.join(', '));
  process.exit(1);
}

const python = process.env.OMR_PYTHON?.trim() || 'python3';

const child = spawn(python, [serverPy], {
  cwd: path.dirname(serverPy),
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

child.on('exit', (code, signal) => {
  console.error(`[omr-engine] python exited (code=${code} signal=${signal})`);
  process.exit(code ?? 1);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

// keep the event loop alive for as long as the python child runs
setInterval(() => {}, 1 << 30);
