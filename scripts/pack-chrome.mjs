// ============================================================
// pack-chrome.cjs — bundles the PDF-engine browser into the
// standalone deploy artifact WITHOUT ballooning its size.
//
// Why: the platform deploy artifact must stay small (~180 MB
// proved fine; 726 MB failed). The chrome-headless-shell binary
// is 209 MB raw but gzip-compresses to ~95 MB. So instead of
// copying the unpacked browser into .next/standalone/, we emit
// per-file `.gz` copies under
//   .next/standalone/chrome/chrome-headless-shell/linux-<ver>/
//       chrome-headless-shell-linux64/<file>.gz
// The runtime pool (src/lib/pdf/pool.ts) detects those on first
// PDF render, gunzips them once (atomically, +x on the binary)
// and proceeds — no network, no system chromium needed.
//
// Usage:  node scripts/pack-chrome.mjs   (from project root)
//   - no ./chrome dir → exits 0 silently (nothing to pack)
//   - output dir defaults to ./.next/standalone/chrome
// ============================================================

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { createGzip } from 'zlib';
import path from 'path';
import { pipeline } from 'stream/promises';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'chrome');
const DEST_DIR = process.argv[2] || path.join(ROOT, '.next', 'standalone', 'chrome');

// files the headless shell actually needs at runtime (LICENSE/
// ABOUT/deb.deps/manifests are metadata only — skipped)
const KEEP = (name) =>
  name === 'chrome-headless-shell' ||
  name === 'icudtl.dat' ||
  name === 'v8_context_snapshot.bin' ||
  name.endsWith('.pak') ||
  name.startsWith('lib');

async function gzipFile(src, dest) {
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dest));
}

async function main() {
  if (!existsSync(SRC_DIR)) {
    console.log('[pack-chrome] no ./chrome dir — skipping (run `bun run chrome:install` for local dev)');
    process.exit(0);
  }
  const shellDir = path.join(SRC_DIR, 'chrome-headless-shell');
  if (!existsSync(shellDir)) {
    console.log('[pack-chrome] no chrome-headless-shell under ./chrome — skipping');
    process.exit(0);
  }
  const versions = readdirSync(shellDir)
    .filter((v) => v.startsWith('linux-'))
    .sort()
    .reverse();
  if (versions.length === 0) {
    console.log('[pack-chrome] no linux-* version dirs — skipping');
    process.exit(0);
  }
  // pack ONLY the newest version (the pool picks the newest anyway)
  const version = versions[0];
  const binDir = path.join(shellDir, version, 'chrome-headless-shell-linux64');
  if (!existsSync(binDir)) {
    console.log(`[pack-chrome] unexpected layout under ${version} — skipping`);
    process.exit(0);
  }

  const outDir = path.join(DEST_DIR, 'chrome-headless-shell', version, 'chrome-headless-shell-linux64');
  rmSync(path.join(DEST_DIR, 'chrome-headless-shell'), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(binDir).filter((f) => statSync(path.join(binDir, f)).isFile() && KEEP(f));
  let raw = 0;
  let packed = 0;
  for (const f of files) {
    const src = path.join(binDir, f);
    const dst = path.join(outDir, `${f}.gz`);
    process.stdout.write(`[pack-chrome] ${f} … `);
    await gzipFile(src, dst);
    const s = statSync(src).size;
    const d = statSync(dst).size;
    raw += s;
    packed += d;
    console.log(`${(s / 1e6).toFixed(1)} MB → ${(d / 1e6).toFixed(1)} MB`);
  }
  const total = (mb) => `${(mb / 1e6).toFixed(1)} MB`;
  console.log(`[pack-chrome] ✓ ${version}: ${total(raw)} → ${total(packed)} → ${path.relative(ROOT, DEST_DIR)}`);
}

main().catch((err) => {
  console.error('[pack-chrome] FAILED:', err instanceof Error ? err.message : err);
  console.error('[pack-chrome] continuing build WITHOUT bundled browser (deployed app needs CHROME_PATH)');
  process.exit(0); // never break the deploy build over packaging
});
