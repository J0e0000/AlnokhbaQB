// Dev wrapper: spawns the Python engine and restarts it when .py files change.
import { spawn } from 'child_process';
import { existsSync, watch } from 'fs';
import path from 'path';

const DIR = (import.meta as unknown as { dir: string }).dir;

// Resolve the Python interpreter that actually has cv2/numpy installed.
// Order: explicit PYTHON_BIN → $HOME/.venv/bin/python3 (sandbox venv) → PATH python3.
// Production (Docker) does not use this file — it runs `python server.py`.
function resolvePythonBin(): string {
  const explicit = process.env.PYTHON_BIN?.trim();
  if (explicit) return explicit;
  const home = process.env.HOME?.trim();
  if (home) {
    for (const candidate of [
      `${home}/.venv/bin/python3`,
      `${home}/.local/share/uv/python/cpython-3.12.16-linux-x86_64-gnu/bin/python3`,
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'python3';
}

let child: ReturnType<typeof spawn> | null = null;
let restarting = false;

function start() {
  child = spawn(resolvePythonBin(), ['-u', path.join(DIR, 'server.py')], {
    cwd: DIR,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (!restarting) {
      console.error(`[omr-engine] python exited (code=${code}) — restarting in 1s`);
      setTimeout(start, 1000);
    }
  });
}

start();

watch(
  DIR,
  { recursive: true },
  (() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return (_e, filename) => {
      if (!filename || !String(filename).endsWith('.py')) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        console.log(`[omr-engine] ${String(filename)} changed — restarting python`);
        restarting = true;
        child?.kill('SIGTERM');
        setTimeout(() => {
          restarting = false;
          start();
        }, 400);
      }, 300);
    };
  })()
);
