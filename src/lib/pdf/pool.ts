// ============================================================
// ALNOKHBA QB — Puppeteer PDF engine (chrome-headless-shell pool)
// Real vector-text PDFs (NEVER raster screenshots for PDFs) +
// 300-dpi PNG raster used ONLY as OMR scan test fixtures.
// ============================================================

import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import puppeteer, { type Browser } from 'puppeteer-core';

// ---------- Chrome binary discovery ----------
// NEVER cache a hardcoded path at module scope: this server can be restarted
// under a different HOME (supervisor vs manual nohup), and puppeteer cache
// versions bump. Resolve lazily at launch time instead:
//   1. $CHROME_PATH / $PUPPETEER_EXECUTABLE_PATH (explicit overrides)
//   2. @sparticuz/chromium serverless bundle (Vercel/Lambda — read-only FS,
//      no distro browser, no Chrome shared libraries; this package ships a
//      lambda-built Chromium + its .so deps, extracted to /tmp on first use)
//   3. $PUPPETEER_CACHE_DIR (explicit cache root)
//   4. newest chrome-headless-shell under the PROJECT-BUNDLED <root>/chrome dir
//      (deploy artifacts ship it gzip-compressed — see materializeBundledChrome;
//      unpacked locally after `bun run chrome:install` — ~/.cache is
//      NOT part of the project and does not survive deployment)
//   5. newest chrome-headless-shell / chrome under legacy home cache roots
//   6. self-extract the bundled .gz files (once per process) and retry 4
//   7. one-time runtime download via @puppeteer/browsers (needs internet)
//   8. distro-installed browsers
const CACHE_ROOTS = (): string[] => {
  const roots: string[] = [];
  if (process.env.PUPPETEER_CACHE_DIR) roots.push(process.env.PUPPETEER_CACHE_DIR);
  const cwd = process.cwd();
  // dev (`next dev`) and `next start`: cwd == project root
  roots.push(path.join(cwd, 'chrome'));
  // standalone output: .next/standalone/server.js runs `process.chdir(__dirname)`
  // → cwd == <project>/.next/standalone, project root is two levels up
  if (cwd.endsWith('.next/standalone') || cwd.endsWith('.next\\standalone')) {
    roots.push(path.resolve(cwd, '..', '..', 'chrome'));
  }
  // legacy home-cache fallbacks (local sandbox installs)
  roots.push(path.join(homedir(), '.cache', 'puppeteer'));
  roots.push('/home/z/.cache/puppeteer');
  roots.push('/root/.cache/puppeteer');
  return roots;
};

/** Common distro-installed browser binaries (last-resort fallbacks). */
const SYSTEM_BROWSER_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

/** Newest `linux-*` version dir containing the given binary layout. */
function newestBrowserBinary(cacheRoot: string, kind: 'chrome-headless-shell' | 'chrome'): string | null {
  const kindDir = path.join(cacheRoot, kind);
  if (!existsSync(kindDir)) return null;
  let versions: string[] = [];
  try {
    versions = readdirSync(kindDir).filter((v) => v.startsWith('linux-')).sort().reverse();
  } catch {
    return null;
  }
  const rel =
    kind === 'chrome-headless-shell'
      ? 'chrome-headless-shell-linux64/chrome-headless-shell'
      : 'chrome-linux64/chrome';
  for (const v of versions) {
    const candidate = path.join(kindDir, v, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const GLOBAL_KEY_CHROME = '__alnokhbaChromePath';
const globalForChrome = globalThis as unknown as {
  __alnokhbaChromePath?: string;
  /** extra launch args injected by the serverless runtime (sparticuz) */
  __alnokhbaChromeArgs?: string[];
  __alnokhbaChromeMaterialize?: Promise<boolean>;
  __alnokhbaChromeDownload?: Promise<boolean>;
};

/**
 * Serverless tier: on Vercel/Lambda there is no writable project FS, no
 * distro Chromium and none of the shared libraries a stock Chrome links
 * against (@sparticuz/chromium ships them and extracts everything to /tmp).
 * Returns null when not on a serverless platform or when the package is
 * unavailable — the normal discovery chain then proceeds as usual.
 */
async function resolveServerlessRuntime(): Promise<{ path: string; args: string[] } | null> {
  if (!process.env.VERCEL && !process.env.ALNOKHBA_SERVERLESS_CHROME) return null;
  try {
    const chromium = (await import('@sparticuz/chromium')).default;
    // Software rendering is enough for vector PDFs — skip shipping/extracting
    // SwiftShader (~250 MB of GPU emulation) to keep cold starts fast.
    try {
      chromium.setGraphicsMode = false;
    } catch {
      /* older versions expose a method instead of a setter */
    }
    const execPath = await chromium.executablePath();
    if (!execPath || !existsSync(execPath)) return null;
    return { path: execPath, args: [...chromium.args] };
  } catch (err) {
    console.warn(`[pdf-pool] serverless chromium unavailable: ${(err as Error).message}`);
    return null;
  }
}

function discoverChromeBinary(tried: string[]): string | null {
  for (const kind of ['chrome-headless-shell', 'chrome'] as const) {
    for (const root of CACHE_ROOTS()) {
      const found = newestBrowserBinary(root, kind);
      if (found) return found;
      tried.push(`${root}/${kind}/*`);
    }
  }
  return null;
}

/**
 * Self-extract the gzip-compressed browser shipped by `scripts/pack-chrome.mjs`
 * (deploy artifacts carry per-file `.gz` copies under
 * `<root>/chrome/chrome-headless-shell/linux-<ver>/chrome-headless-shell-linux64/`
 * instead of the 276 MB unpacked browser, to stay under deploy size limits).
 * Streams each file to `<name>.tmp-<pid>` then renames — safe under concurrent
 * first-renders and restarts. Runs at most once per process.
 */
async function materializeBundledChrome(): Promise<boolean> {
  if (globalForChrome.__alnokhbaChromeMaterialize) {
    return globalForChrome.__alnokhbaChromeMaterialize;
  }
  globalForChrome.__alnokhbaChromeMaterialize = (async () => {
    type Job = { gz: string; target: string };
    const jobs: Job[] = [];
    for (const root of CACHE_ROOTS()) {
      const shellBase = path.join(root, 'chrome-headless-shell');
      if (!existsSync(shellBase)) continue;
      let versions: string[] = [];
      try {
        versions = readdirSync(shellBase).filter((v) => v.startsWith('linux-'));
      } catch {
        continue;
      }
      for (const v of versions) {
        const binDir = path.join(shellBase, v, 'chrome-headless-shell-linux64');
        if (!existsSync(binDir)) continue;
        try {
          for (const f of readdirSync(binDir)) {
            if (f.endsWith('.gz')) {
              jobs.push({ gz: path.join(binDir, f), target: path.join(binDir, f.slice(0, -3)) });
            }
          }
        } catch {
          /* unreadable dir — skip */
        }
      }
    }
    if (jobs.length === 0) return false;
    console.info(`[pdf-pool] bundling found compressed — extracting browser (${jobs.length} files)…`);
    for (const { gz, target } of jobs) {
      const tmp = `${target}.tmp-${process.pid}`;
      try {
        if (existsSync(target) && statSync(target).size > 0) continue; // already materialized
        await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp));
        chmodSync(tmp, 0o755);
        renameSync(tmp, target);
      } catch (err) {
        console.warn(`[pdf-pool] extract failed for ${path.basename(gz)}: ${(err as Error).message}`);
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    }
    console.info('[pdf-pool] bundled browser extracted — retrying launch');
    return true;
  })();
  return globalForChrome.__alnokhbaChromeMaterialize;
}

/**
 * Last-resort one-time download via the @puppeteer/browsers CLI that ships
 * inside the traced node_modules of every deployment (verified in artifacts).
 * Keeps the deploy artifact small (173 MB — the proven-good size) while the
 * browser (~150 MB) is fetched once per container at first PDF render or via
 * the /api/health warm-up. Requires internet on the host.
 */
async function downloadChromeRuntime(): Promise<boolean> {
  if (globalForChrome.__alnokhbaChromeDownload) {
    return globalForChrome.__alnokhbaChromeDownload;
  }
  globalForChrome.__alnokhbaChromeDownload = (async () => {
    const cwd = process.cwd();
    const candidates = [
      path.join(cwd, 'node_modules', '@puppeteer', 'browsers', 'lib', 'main-cli.js'),
      path.join(cwd, '..', 'node_modules', '@puppeteer', 'browsers', 'lib', 'main-cli.js'),
      path.join(cwd, '..', '..', 'node_modules', '@puppeteer', 'browsers', 'lib', 'main-cli.js'),
    ];
    const cli = candidates.find((p) => existsSync(p));
    if (!cli) {
      console.warn('[pdf-pool] runtime install unavailable: @puppeteer/browsers CLI not found');
      return false;
    }
    console.info('[pdf-pool] no browser found — downloading chrome-headless-shell (one-time, ~150 MB)…');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [cli, 'install', 'chrome-headless-shell@stable', '--path', path.join(cwd, 'chrome')],
          { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }
        );
        let out = '';
        child.stdout.on('data', (c: Buffer) => {
          out += c.toString();
        });
        child.stderr.on('data', (c: Buffer) => {
          out += c.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`installer exited ${code}: ${out.slice(-500)}`));
        });
      });
      console.info('[pdf-pool] chrome-headless-shell downloaded');
      return true;
    } catch (err) {
      console.warn(`[pdf-pool] runtime download failed: ${(err as Error).message}`);
      console.warn('[pdf-pool] fix: set CHROME_PATH to an existing Chromium, or copy a chrome/ folder next to the server, or provide internet access');
      return false;
    }
  })();
  return globalForChrome.__alnokhbaChromeDownload;
}

async function chromeExecutablePath(): Promise<string> {
  // resolved once per process; re-resolved automatically if the file vanishes
  if (globalForChrome[GLOBAL_KEY_CHROME] && existsSync(globalForChrome[GLOBAL_KEY_CHROME])) {
    return globalForChrome[GLOBAL_KEY_CHROME];
  }
  const tried: string[] = [];
  // explicit overrides first: CHROME_PATH (our convention), then the
  // puppeteer-standard PUPPETEER_EXECUTABLE_PATH (set in the Docker image)
  const overrides = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH];
  for (const override of overrides) {
    if (override) {
      if (existsSync(override)) {
        globalForChrome[GLOBAL_KEY_CHROME] = override;
        return override;
      }
      tried.push(override);
    }
  }
  // serverless platform → the lambda-built Chromium (+ its bundled libs)
  const serverless = await resolveServerlessRuntime();
  if (serverless) {
    globalForChrome[GLOBAL_KEY_CHROME] = serverless.path;
    globalForChrome.__alnokhbaChromeArgs = serverless.args;
    console.info(`[pdf-pool] Chrome resolved (serverless bundle): ${serverless.path}`);
    return serverless.path;
  }
  const found = discoverChromeBinary(tried);
  if (found) {
    globalForChrome[GLOBAL_KEY_CHROME] = found;
    // one-time per process — makes deployment issues diagnosable from logs
    console.info(`[pdf-pool] Chrome resolved: ${found}`);
    return found;
  }
  // nothing unpacked anywhere → try the compressed bundle shipped in the
  // deploy artifact (extract once, then re-discover)
  if (await materializeBundledChrome()) {
    const extracted = discoverChromeBinary(tried);
    if (extracted) {
      globalForChrome[GLOBAL_KEY_CHROME] = extracted;
      console.info(`[pdf-pool] Chrome resolved (extracted): ${extracted}`);
      return extracted;
    }
  }
  // still nothing → one-time runtime download via @puppeteer/browsers
  // (the CLI ships inside traced node_modules; needs internet on the host —
  // this is what makes platform deploys work without bloating the artifact)
  if (await downloadChromeRuntime()) {
    const downloaded = discoverChromeBinary(tried);
    if (downloaded) {
      globalForChrome[GLOBAL_KEY_CHROME] = downloaded;
      console.info(`[pdf-pool] Chrome resolved (downloaded): ${downloaded}`);
      return downloaded;
    }
  }
  // last resort: distro-installed browsers on PATH-adjacent locations
  for (const sysPath of SYSTEM_BROWSER_PATHS) {
    if (existsSync(sysPath)) {
      globalForChrome[GLOBAL_KEY_CHROME] = sysPath;
      console.info(`[pdf-pool] Chrome resolved (system): ${sysPath}`);
      return sysPath;
    }
    tried.push(sysPath);
  }
  throw new Error(
    `لم يتم العثور على متصفح Chrome — المسارات المفحوصة: ${tried.join(' ، ')} | Chrome binary not found (tried: ${tried.join(', ')}). الإصلاح: يحتاج الخادم اتصال إنترنت لتنزيل المتصفح تلقائيًا عند أول تصدير، أو اضبط CHROME_PATH على متصفح موجود، أو انسخ مجلد chrome/ بجانب الخادم.`
  );
}

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
];

const MM_PER_INCH = 25.4;
const CSS_DPI = 96;

/** Max pages rendered concurrently on the shared browser. */
const MAX_CONCURRENT_PAGES = 2;

// Next.js compiles each route into its own module graph — a plain module-level
// singleton would be duplicated per route (and leak browsers). Hold ALL mutable
// state on globalThis (same pattern as src/lib/db.ts).
interface PoolState {
  browserPromise: Promise<Browser> | null;
  activePages: number;
  waiters: Array<() => void>;
}

const GLOBAL_KEY = '__alnokhbaPdfPoolState';
const globalForPool = globalThis as unknown as {
  __alnokhbaPdfPoolState?: PoolState;
};
const state: PoolState =
  globalForPool[GLOBAL_KEY] ?? { browserPromise: null, activePages: 0, waiters: [] };
globalForPool[GLOBAL_KEY] = state;

// ---------- simple semaphore (max N concurrent pages) ----------

async function acquirePageSlot(): Promise<void> {
  if (state.activePages < MAX_CONCURRENT_PAGES) {
    state.activePages++;
    return;
  }
  await new Promise<void>((resolve) => state.waiters.push(resolve));
  state.activePages++;
}

function releasePageSlot(): void {
  state.activePages = Math.max(0, state.activePages - 1);
  const next = state.waiters.shift();
  if (next) next();
}

// ---------- browser lifecycle ----------

async function getBrowser(): Promise<Browser> {
  if (!state.browserPromise) {
    state.browserPromise = chromeExecutablePath()
      .then((executablePath) =>
        puppeteer.launch({
          executablePath,
          args: globalForChrome.__alnokhbaChromeArgs ?? LAUNCH_ARGS,
        })
      )
      .then((browser) => {
        // any disconnect (crash / kill) → reset so the next call relaunches
        browser.on('disconnected', () => {
          state.browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        state.browserPromise = null;
        throw err;
      });
  }
  return state.browserPromise;
}

export function getBrowserHealth(): { running: boolean } {
  return { running: state.browserPromise !== null };
}

/**
 * Fire-and-forget browser pre-warm.
 * The first PDF after a server restart otherwise pays the full cold-start
 * (chrome launch ≈ 2-5s) inside the user's request — during which the user
 * sees a frozen button and may click again. Called non-blocking from
 * /api/health so the app shell's mount health-check warms the pool.
 * Failures are swallowed here on purpose: the real render call surfaces them.
 */
export function warmBrowser(): void {
  getBrowser().catch(() => {
    /* warm-up failure is non-fatal — renderPdf reports the real error */
  });
}

async function withPage<T>(fn: (page: import('puppeteer-core').Page) => Promise<T>): Promise<T> {
  await acquirePageSlot();
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    releasePageSlot();
  }
}

async function loadHtml(
  page: import('puppeteer-core').Page,
  html: string,
  settleMs: number
): Promise<void> {
  await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
  // fonts + images may stream in after 'load' — wait for the network to go
  // quiet (best effort) and for web fonts to be ready before paint-to-PDF.
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 15_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, settleMs));
}

// ---------- local font inlining ----------
// Chromium blocks file:// subresources on setContent pages (about:blank origin)
// → "Not allowed to load local resource". Both canonical renderers embed
// @font-face url('file://<cwd>/public/fonts/*.woff2'), so the pool rewrites
// those URLs to base64 data: URLs before render (cached per file). This keeps
// text vector + brand fonts (Tajawal/Amiri) embedded in every PDF.

const FONT_URL_RE = /url\('(file:\/\/[^']*\/public\/fonts\/[^']*\.woff2)'\)/g;
const FONT_MIME = 'font/woff2';

const globalForFonts = globalThis as unknown as {
  __alnokhbaFontDataCache?: Map<string, string>;
};
const fontCache = globalForFonts.__alnokhbaFontDataCache ?? new Map<string, string>();
globalForFonts.__alnokhbaFontDataCache = fontCache;

function inlineLocalFonts(html: string): string {
  return html.replace(FONT_URL_RE, (_match, fileUrl: string) => {
    try {
      const cached = fontCache.get(fileUrl);
      if (cached) return `url('${cached}')`;
      const p = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
      const fontsRoot = path.join(process.cwd(), 'public', 'fonts');
      const resolved = path.resolve(p);
      if (!resolved.startsWith(fontsRoot + path.sep) || !resolved.endsWith('.woff2')) {
        return _match; // outside the fonts dir → leave untouched (will fall back)
      }
      const b64 = readFileSync(resolved).toString('base64');
      const dataUrl = `data:${FONT_MIME};base64,${b64}`;
      fontCache.set(fileUrl, dataUrl);
      return `url('${dataUrl}')`;
    } catch {
      return _match;
    }
  });
}

// ---------- public render API ----------

export interface RenderSizeOpts {
  widthMm: number;
  heightMm: number;
}

/** Vector PDF from the canonical HTML — the ONLY path for exam/OMR PDFs. */
export async function renderPdf(
  html: string,
  opts: RenderSizeOpts
): Promise<Buffer> {
  return withPage(async (page) => {
    await loadHtml(page, inlineLocalFonts(html), 150);
    const pdf = await page.pdf({
      width: `${opts.widthMm}mm`,
      height: `${opts.heightMm}mm`,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });
    return Buffer.from(pdf);
  });
}

export interface RenderPngOpts extends RenderSizeOpts {
  /** raster density (default 300 — matches OMR engine referenceDpi) */
  dpi?: number;
  /** 0-based page index to capture (pages stack vertically) */
  clipPage?: number;
}

/**
 * PNG screenshot at `dpi`/96 deviceScaleFactor — used ONLY for OMR sheet
 * test fixtures (what the scanner would "see"), never for PDFs.
 */
export async function renderPng(
  html: string,
  opts: RenderPngOpts
): Promise<Buffer> {
  const dpi = opts.dpi ?? 300;
  const scale = dpi / CSS_DPI;
  const pxW = Math.round((opts.widthMm / MM_PER_INCH) * CSS_DPI);
  const pxH = Math.round((opts.heightMm / MM_PER_INCH) * CSS_DPI);
  const clipPage = Math.max(0, opts.clipPage ?? 0);

  return withPage(async (page) => {
    await page.setViewport({
      width: pxW,
      height: pxH,
      deviceScaleFactor: scale,
    });
    await loadHtml(page, inlineLocalFonts(html), 300);
    const png = await page.screenshot({
      type: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: clipPage * pxH, width: pxW, height: pxH },
    });
    return Buffer.from(png);
  });
}

/** CSS-pixel size of a mm box at 96dpi (shared by tooling/tests). */
export function mmToCssPx(mmValue: number): number {
  return Math.round((mmValue / MM_PER_INCH) * CSS_DPI);
}
