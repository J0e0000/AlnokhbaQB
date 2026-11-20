// Dev wrapper: spawns the Python engine and restarts it when .py files change.
import { spawn } from 'child_process';
import { watch } from 'fs';
import path from 'path';

const DIR = (import.meta as unknown as { dir: string }).dir;
let child: ReturnType<typeof spawn> | null = null;
let restarting = false;

function start() {
  child = spawn('python3', ['-u', path.join(DIR, 'server.py')], {
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
