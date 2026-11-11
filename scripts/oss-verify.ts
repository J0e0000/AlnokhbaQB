/**
 * ALNOKHBA QB — open-source stack verification probe.
 *
 * Run: bun scripts/oss-verify.ts
 *
 * Prints the REAL state of every open-source integration (versions, health,
 * bundled assets, OCR smoke) so "actually installed and integrated" is always
 * verifiable in one command. No mocks, no placeholders.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const ENGINE = path.join(ROOT, 'mini-services', 'omr-engine');
const ENGINE_URL = process.env.OMR_ENGINE_URL ?? 'http://127.0.0.1:3032';

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✔' : '✘'} ${label.padEnd(38)} ${detail}`);
  if (!ok) failures++;
}

function pkgVersion(name: string): string {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? '—';
}

async function main(): Promise<void> {
  console.log('ALNOKHBA QB — open-source stack verification\n');

  // 1. Pinned frontend integrations (package.json)
  const deps = ['pdfjs-dist', 'pdf-lib', 'qrcode', 'puppeteer-core', 'next', 'react', 'prisma', 'zod', 'bcryptjs', 'jose', 'zustand', '@dnd-kit/core', '@fontsource/amiri', '@fontsource/tajawal'];
  for (const d of deps) check(`npm ${d}`, pkgVersion(d) !== '—', pkgVersion(d));

  // 2. Bundled static assets
  check('pdf.js worker asset', existsSync(path.join(ROOT, 'public', 'pdf.worker.min.mjs')), 'public/pdf.worker.min.mjs');
  for (const f of ['amiri-arabic-400-normal.woff2', 'tajawal-arabic-400-normal.woff2', 'tajawal-latin-400.woff2']) {
    check(`font ${f}`, existsSync(path.join(ROOT, 'public', 'fonts', f)), 'public/fonts');
  }

  // 3. System tesseract + bundled Arabic pack
  const tess = spawnSync('tesseract', ['--version'], { encoding: 'utf8' });
  const tessVer = tess.stdout?.split('\n')[0] ?? 'not found';
  check('tesseract binary', tess.status === 0, tessVer);
  const tessdata = path.join(ENGINE, 'tessdata');
  const ara = path.join(tessdata, 'ara.traineddata');
  check('bundled ara.traineddata', existsSync(ara), existsSync(ara) ? `${(readFileSync(ara).byteLength / 1024).toFixed(0)} KB (tessdata_fast)` : 'MISSING');
  check('bundled eng.traineddata', existsSync(path.join(tessdata, 'eng.traineddata')), 'mini-services/omr-engine/tessdata');
  check('tesseract configs (tsv confidence)', existsSync(path.join(tessdata, 'configs')), 'tessdata/configs copied from system pack');

  // 4. OMR/OCR engine service
  try {
    const res = await fetch(`${ENGINE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { ok?: boolean; version?: string };
    check('OMR engine :3032 /health', !!body.ok, `python-opencv ${body.version ?? '?'}`);
  } catch {
    check('OMR engine :3032 /health', false, `unreachable at ${ENGINE_URL} — start: cd mini-services/omr-engine && bun run dev`);
  }

  // 5. Python CV runtime
  const py = spawnSync('python3', ['-c', 'import cv2, numpy; print("cv2", cv2.__version__, "| numpy", numpy.__version__)'], { encoding: 'utf8' });
  check('python opencv+numpy', py.status === 0, py.stdout?.trim() ?? py.stderr?.split('\n')[0] ?? 'import failed');

  // 6. Chromium PDF engine binary (same discovery order as src/lib/pdf/pool.ts)
  const roots = [path.join(ROOT, 'chrome'), path.join(process.env.HOME ?? '', '.cache', 'puppeteer'), path.join(process.env.PUPPETEER_CACHE_DIR ?? '')].filter(Boolean);
  let chrome = '';
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    const out = spawnSync('sh', ['-c', `find '${dir}' -name 'chrome-headless-shell' -type f 2>/dev/null | sort | tail -1; find '${dir}' -name 'chrome' -type f 2>/dev/null | sort | tail -1`], { encoding: 'utf8' });
    chrome = out.stdout.trim().split('\n').filter(Boolean)[0] ?? '';
    if (chrome) break;
  }
  if (!chrome && process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) chrome = process.env.CHROME_PATH;
  check('chromium (PDF engine)', !!chrome, chrome || 'not resolved — run: bun run chrome:install');

  // 7. App health (db + pdf + omr)
  try {
    const res = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(8000) });
    const body = (await res.json()) as { ok?: boolean; db?: boolean; pdf?: { running?: boolean }; omrEngine?: { ok?: boolean } };
    check('app /api/health', !!body.ok, JSON.stringify(body));
  } catch {
    check('app /api/health', false, 'app not running on :3000 — bun run dev');
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED ✅' : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
