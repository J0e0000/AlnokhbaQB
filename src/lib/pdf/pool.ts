// ============================================================
// ALNOKHBA QB — Puppeteer PDF engine (chrome-headless-shell pool)
// Real vector-text PDFs (NEVER raster screenshots for PDFs) +
// 300-dpi PNG raster used ONLY as OMR scan test fixtures.
// ============================================================

import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import puppeteer, { type Browser } from 'puppeteer-core';

// ---------- Chrome binary discovery ----------
// NEVER cache a hardcoded path at module scope: this server can be restarted
// under a different HOME (supervisor vs manual nohup), and puppeteer cache
// versions bump. Resolve lazily at launch time instead:
//   1. $CHROME_PATH (explicit override)
//   2. $PUPPETEER_CACHE_DIR (explicit cache root)
//   3. newest chrome-headless-shell under the PROJECT-BUNDLED <root>/chrome dir
//      (ships with the code so deployments are self-contained — ~/.cache is
//      NOT part of the project and does not survive deployment)
//   4. newest chrome-headless-shell / chrome under legacy home cache roots
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
const globalForChrome = globalThis as unknown as { __alnokhbaChromePath?: string };

function chromeExecutablePath(): string {
  // resolved once per process; re-resolved automatically if the file vanishes
  if (globalForChrome[GLOBAL_KEY_CHROME] && existsSync(globalForChrome[GLOBAL_KEY_CHROME])) {
    return globalForChrome[GLOBAL_KEY_CHROME];
  }
  const tried: string[] = [];
  const override = process.env.CHROME_PATH;
  if (override) {
    if (existsSync(override)) {
      globalForChrome[GLOBAL_KEY_CHROME] = override;
      return override;
    }
    tried.push(override);
  }
  for (const kind of ['chrome-headless-shell', 'chrome'] as const) {
    for (const root of CACHE_ROOTS()) {
      const found = newestBrowserBinary(root, kind);
      if (found) {
        globalForChrome[GLOBAL_KEY_CHROME] = found;
        // one-time per process — makes deployment issues diagnosable from logs
        console.info(`[pdf-pool] Chrome resolved: ${found}`);
        return found;
      }
      tried.push(`${root}/${kind}/*`);
    }
  }
  throw new Error(
    `لم يتم العثور على متصفح Chrome — المسارات المفحوصة: ${tried.join(' ، ')} | Chrome binary not found (tried: ${tried.join(', ')}). الإصلاح: شغّل "bun run chrome:install" أو اضبط CHROME_PATH على مسار متصفح موجود.`
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

// On Vercel (serverless) there is no bundled Chrome — use @sparticuz/chromium.
async function launchOptions() {
  if (process.env.VERCEL) {
    const { default: chromium } = await import('@sparticuz/chromium');
    return {
      executablePath: await chromium.executablePath(),
      args: [...chromium.args, ...LAUNCH_ARGS],
      headless: 'shell' as const,
    };
  }
  return { executablePath: chromeExecutablePath(), args: LAUNCH_ARGS };
}

async function getBrowser(): Promise<Browser> {
  if (!state.browserPromise) {
    state.browserPromise = launchOptions()
      .then((opts) => puppeteer.launch(opts))
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
  // Sandbox escape hatch: some supervised dev environments police processes
  // that launch browsers and SIGKILL the whole dev server shortly after the
  // pool spawns chrome-headless-shell. Setting PDF_WARM_SKIP=1 skips only the
  // fire-and-forget pre-warm (lazy launch on real PDF requests still works),
  // keeping /api/health's payload and all API behavior unchanged.
  if (process.env.PDF_WARM_SKIP === '1') return;
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
