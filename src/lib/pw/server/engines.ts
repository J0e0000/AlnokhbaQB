// Pagewise — server-side PDF engines.
//
// Every SERVER_TOOLS entry is a self-contained job function: it receives a job
// directory holding validated uploads under `${dir}/input/`, does its work and
// returns result files written into `${dir}/results/`. Scratch space lives in
// `${dir}/work/` and is wiped when the job function returns.
//
// Safety rules enforced throughout this file:
//   - No shell, no string-built commands: everything goes through execFile.
//   - Every binary call has a hard timeout (120 s default, 180 s office, 300 s OCR).
//   - HTML rendering enforces an SSRF guard: public http(s) hosts only, re-checked
//     for every intercepted request (redirects and subresources included).
//   - All thrown Errors are user-friendly: the UI shows them verbatim.
//
// Node runtime only — imported by API route handlers. Never import this file
// from client components.

import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { basename as pathBasename, join } from 'node:path';
import { promisify } from 'node:util';

import { PDFDocument } from 'pdf-lib';
import puppeteer, { type Browser, type HTTPRequest, type PaperFormat, type Page } from 'puppeteer-core';

import { pagesToPptxBuffer, pagesToXlsxBuffer, textToDocxBuffer, type DocxParagraph } from './docs';

// ---------------------------------------------------------------- shapes ----

export interface ServerInputFile {
  name: string;
  path: string;
  size: number;
  mime: string;
}

export interface ServerResultFile {
  name: string;
  path: string;
  info?: string;
}

export type ServerProgress = (message: string, percent?: number) => void;

export type ServerToolFn = (args: {
  /** Absolute job temp dir; final outputs go to `${dir}/results/`. */
  dir: string;
  /** Validated uploads saved under `${dir}/input/`. */
  files: ServerInputFile[];
  opts: Record<string, string | number | boolean>;
  onProgress: ServerProgress;
}) => Promise<ServerResultFile[]>;

// -------------------------------------------------------------- constants ----

const DEFAULT_TIMEOUT_MS = 120_000;
const OFFICE_TIMEOUT_MS = 180_000;
const OCR_TIMEOUT_MS = 300_000;

const MAX_OCR_PAGES = 60;
const MAX_DOCX_PARAGRAPHS = 800;
const MAX_XLSX_CELLS = 200_000;

const ARABIC_RE = /[\u0600-\u06FF]/;

/** Arabic traineddata shipped with the OMR mini service (not in system tessdata). */
const OMR_TESSDATA_DIR = '/home/z/my-project/mini-services/omr-engine/tessdata';
const SYSTEM_TESSDATA_ROOT = '/usr/share/tesseract-ocr';
const GS_ROOT = '/usr/share/ghostscript';

// ------------------------------------------------------------ small utils ----

const execFileAsync = promisify(execFile);

/** Error carrying the tool's stderr so callers can map it to friendly messages. */
class EngineError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'EngineError';
    this.stderr = stderr;
  }
}

interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run a binary with execFile (no shell) and a hard timeout. */
async function runBin(
  bin: string,
  args: string[],
  opts: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const res = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: opts.env,
    });
    return { stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      killed?: boolean;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8') ?? '';
    if (err.killed) {
      throw new EngineError(`${bin} timed out after ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`, stderr);
    }
    throw new EngineError(`${bin} failed (exit ${err.code ?? '?'})`, stderr);
  }
}

async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Keep only word chars, dot, dash and space; collapse everything else. */
function sanitizeName(raw: string): string {
  const s = raw.replace(/[^\w.\- ]+/g, '_').trim();
  return s.length > 0 ? s : 'file';
}

/** Original file name without extension, sanitized, sane length. */
function baseNameOf(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '');
  return sanitizeName(stem).slice(0, 80) || 'document';
}

async function requireSingleInput(files: ServerInputFile[], message: string): Promise<ServerInputFile> {
  const f = files[0];
  if (!f || files.length !== 1) throw new Error(message);
  try {
    await access(f.path);
  } catch {
    throw new Error('The uploaded file is no longer available on the server — please re-upload.');
  }
  return f;
}

/** Page count via qpdf, pdfinfo as fallback; null when unknown. */
async function pdfPageCount(pdfPath: string): Promise<number | null> {
  try {
    const { stdout } = await runBin('qpdf', ['--show-npages', pdfPath], { timeoutMs: 30_000 });
    const n = Number.parseInt(stdout.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // fall through to pdfinfo
  }
  try {
    const { stdout } = await runBin('pdfinfo', [pdfPath], { timeoutMs: 30_000 });
    const m = /^Pages:\s+(\d+)\s*$/m.exec(stdout);
    const n = m ? Number.parseInt(m[1], 10) : Number.NaN;
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // unknown page count
  }
  return null;
}

function truncateLine(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

/** Shared scaffolding: results + work dirs, guaranteed cleanup of scratch. */
async function withJobDirs(
  dir: string,
  fn: (ctx: { resultsDir: string; workDir: string }) => Promise<ServerResultFile[]>
): Promise<ServerResultFile[]> {
  const resultsDir = await ensureDir(join(dir, 'results'));
  const workDir = await ensureDir(join(dir, 'work'));
  try {
    return await fn({ resultsDir, workDir });
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // scratch cleanup is best effort
    }
  }
}

// -------------------------------------------------------------- guards ----

/** Fail fast (with a friendly message) when the queue forgets the job dir. */
function assertUsableDir(dir: string): void {
  if (!dir) {
    throw new Error('Internal error: no job directory was provided for this operation.');
  }
}

// ============================================================== 1. repair ====

async function runRepair(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir, workDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one PDF file to repair.');
    const base = baseNameOf(input.name);
    const outName = `${base}_repaired.pdf`;
    const finalPath = join(resultsDir, outName);
    const qpdfOut = join(workDir, 'qpdf_out.pdf');
    const gsOut = join(workDir, 'gs_out.pdf');

    args.onProgress('Checking PDF structure...', 15);
    let wasValid = false;
    try {
      await runBin('qpdf', ['--check', input.path], { timeoutMs: DEFAULT_TIMEOUT_MS });
      wasValid = true;
    } catch {
      wasValid = false; // warnings or errors — both mean the file needs a rebuild
    }

    args.onProgress('Rebuilding PDF structure with qpdf...', 40);
    let repaired = false;
    try {
      await runBin('qpdf', ['--qdf', '--object-streams=disable', input.path, qpdfOut], {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      repaired = await fileExists(qpdfOut);
    } catch {
      repaired = false;
    }

    if (repaired) {
      await rename(qpdfOut, finalPath);
    } else {
      args.onProgress('Trying the Ghostscript recovery path...', 60);
      try {
        await runBin('gs', ['-o', gsOut, '-sDEVICE=pdfwrite', '-dPDFSETTINGS=/prepress', input.path], {
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
        if (await fileExists(gsOut)) {
          await rename(gsOut, finalPath);
          repaired = true;
        }
      } catch {
        repaired = false;
      }
    }

    if (!repaired || !(await fileExists(finalPath))) {
      throw new Error('This file could not be repaired — it may be beyond recovery.');
    }

    const pages = await pdfPageCount(finalPath);
    const pagesLabel = pages !== null ? `${pages} pages` : 'unknown page count';
    args.onProgress('Repair complete.', 100);
    return [
      {
        name: outName,
        path: finalPath,
        info: wasValid ? `Rebuilt structure · ${pagesLabel}` : `Recovered ${pagesLabel}`,
      },
    ];
  });
}

// ============================================================= 2. protect ====

async function runProtect(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one PDF file to protect.');
    const password = String(args.opts.password ?? '');
    if (password.trim().length < 4) {
      throw new Error('Enter a password of at least 4 characters');
    }
    const ownerPassword = args.opts.ownerPassword ? String(args.opts.ownerPassword) : password;
    const base = baseNameOf(input.name);
    const outName = `${base}_protected.pdf`;
    const outPath = join(resultsDir, outName);

    args.onProgress('Encrypting with AES-256...', 40);
    try {
      // Flag form (qpdf >= 11.7) so any password text is accepted verbatim.
      await runBin(
        'qpdf',
        [
          '--encrypt',
          `--user-password=${password}`,
          `--owner-password=${ownerPassword}`,
          '--bits=256',
          '--',
          input.path,
          outPath,
        ],
        { timeoutMs: DEFAULT_TIMEOUT_MS }
      );
    } catch {
      throw new Error('Could not encrypt this PDF — please try again with a different file.');
    }
    if (!(await fileExists(outPath))) {
      throw new Error('Could not encrypt this PDF — please try again with a different file.');
    }

    args.onProgress('Encryption complete.', 100);
    return [{ name: outName, path: outPath, info: 'AES-256 encrypted' }];
  });
}

// ============================================================== 3. unlock ====

async function runUnlock(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one PDF file to unlock.');
    const password = String(args.opts.password ?? '');
    const base = baseNameOf(input.name);
    const outName = `${base}_unlocked.pdf`;
    const outPath = join(resultsDir, outName);

    args.onProgress('Decrypting PDF...', 40);
    try {
      // `--password=` with an empty value means "no password", which is allowed.
      await runBin('qpdf', [`--password=${password}`, '--decrypt', input.path, outPath], {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch (e) {
      if (e instanceof EngineError && /invalid password|password/i.test(e.stderr)) {
        throw new Error('Wrong password — could not decrypt this PDF.');
      }
      throw new Error('Could not decrypt this PDF — the file may be corrupted.');
    }
    if (!(await fileExists(outPath))) {
      throw new Error('Could not decrypt this PDF — the file may be corrupted.');
    }

    args.onProgress('Decryption complete.', 100);
    return [{ name: outName, path: outPath, info: 'Password removed' }];
  });
}

// ========================================================= 4. pdf-to-pdfa ====

/** Locate srgb.icc shipped with any installed Ghostscript version. */
async function findSrgbIcc(): Promise<string> {
  let versions: string[] = [];
  try {
    versions = (await readdir(GS_ROOT)).sort().reverse();
  } catch {
    versions = [];
  }
  for (const v of versions) {
    const candidate = join(GS_ROOT, v, 'iccprofiles', 'srgb.icc');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next version
    }
  }
  throw new Error('PDF/A engine is missing its ICC profile on this server.');
}

const FALLBACK_PDFA_DEF = [
  '%!',
  '% Generated by Pagewise — OutputIntent scaffolding for PDF/A conversion.',
  '/ICCProfile (PLACEHOLDER_ICC) def',
  '',
  '[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark',
  '[{icc_PDFA} <</N 3>> /PUT pdfmark',
  '[{icc_PDFA} ICCProfile (r) file /PUT pdfmark',
  '',
  '[/_objdef {OutputCondition_PDFA} /type /dict /OBJ pdfmark',
  '[{OutputCondition_PDFA} <<',
  '  /Type /OutputIntent',
  '  /S /GTS_PDFA1',
  '  /DestOutputProfile {icc_PDFA}',
  '  /OutputConditionIdentifier (sRGB IEC61966-2.1)',
  '  /Info (sRGB IEC61966-2.1)',
  '>> /PUT pdfmark',
  '',
  '[{Catalog} <</OutputIntents [ {OutputCondition_PDFA} ]>> /PUT pdfmark',
].join('\n');

/**
 * Produce PDFA_def.ps for the gs run: prefer Ghostscript's shipped template with
 * the ICC path patched in, fall back to a minimal built-in version.
 */
async function buildPdfaDef(psPath: string, iccPath: string): Promise<void> {
  let content = '';
  try {
    const versions = (await readdir(GS_ROOT)).sort().reverse();
    for (const v of versions) {
      try {
        content = await readFile(join(GS_ROOT, v, 'lib', 'PDFA_def.ps'), 'utf8');
        break;
      } catch {
        // try next version
      }
    }
  } catch {
    content = '';
  }
  if (!content) content = FALLBACK_PDFA_DEF;
  content = content.replace(/^\/ICCProfile\s*\(([^)]*)\)/m, `/ICCProfile (${iccPath})`);
  await writeFile(psPath, content, 'utf8');
}

async function runPdfToPdfa(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir, workDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one PDF file to convert.');
    const levelRaw = Number.parseInt(String(args.opts.level ?? '2'), 10);
    const level = levelRaw === 1 || levelRaw === 3 ? levelRaw : 2;
    const iccPath = await findSrgbIcc();

    const defPs = join(workDir, 'PDFA_def.ps');
    await buildPdfaDef(defPs, iccPath);

    const base = baseNameOf(input.name);
    const outName = `${base}_pdfa${level}b.pdf`;
    const outPath = join(resultsDir, outName);
    const gsOut = join(workDir, 'pdfa_out.pdf');

    args.onProgress(`Converting to PDF/A-${level}b with Ghostscript...`, 40);
    try {
      await runBin(
        'gs',
        [
          `-dPDFA=${level}`,
          '-dBATCH',
          '-dNOPAUSE',
          '-dNOOUTERSAVE',
          '-dPDFACompatibilityPolicy=1',
          '-sColorConversionStrategy=UseDeviceIndependentColor',
          '-sDEVICE=pdfwrite',
          `-sOutputFile=${gsOut}`,
          defPs,
          input.path,
        ],
        { timeoutMs: DEFAULT_TIMEOUT_MS }
      );
    } catch (e) {
      if (e instanceof EngineError && e.message.includes('timed out')) {
        throw new Error('PDF/A conversion timed out — try a smaller document.');
      }
      throw new Error('Ghostscript could not convert this PDF to PDF/A — the file may use unsupported features.');
    }

    if (!(await fileExists(gsOut))) {
      throw new Error('PDF/A conversion produced no usable output — the source file may be corrupted.');
    }
    await rename(gsOut, outPath);

    const pages = await pdfPageCount(outPath);
    const info = pages !== null ? `PDF/A-${level}b · ${pages} pages` : `PDF/A-${level}b`;
    args.onProgress('PDF/A conversion complete.', 100);
    return [{ name: outName, path: outPath, info }];
  });
}

// ======================================================== 5. office-to-pdf ===

async function runOfficeToPdf(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir, workDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one document file to convert.');
    const loDir = join(workDir, 'lo');
    await ensureDir(loDir);

    const base = baseNameOf(input.name);
    const finalName = `${base}.pdf`;
    const finalPath = join(resultsDir, finalName);
    // soffice always writes <input stem>.pdf into --outdir, named after the
    // FILE ON DISK (which carries the job index prefix), not the metadata name.
    const stem = pathBasename(input.path).replace(/\.[^.]+$/, '');
    const expectedPath = join(workDir, `${stem}.pdf`);

    const convert = (target: string): Promise<{ stdout: string; stderr: string }> =>
      runBin(
        'soffice',
        [
          '--headless',
          '--norestore',
          `-env:UserInstallation=${encodeURI(`file://${loDir}`)}`,
          '--convert-to',
          target,
          '--outdir',
          workDir,
          input.path,
        ],
        { timeoutMs: OFFICE_TIMEOUT_MS, env: { ...process.env, HOME: workDir } }
      );

    args.onProgress('Converting document with LibreOffice...', 35);
    let done = false;
    if (args.opts.quality === 'high') {
      const filter =
        'pdf:writer_pdf_Export:{"ReduceImageResolution":{"type":"boolean","value":false},"MaxImageResolution":{"type":"long","value":1200}}';
      try {
        await convert(filter);
        done = await fileExists(expectedPath);
      } catch {
        done = false;
      }
    }
    if (!done) {
      try {
        await convert('pdf');
      } catch {
        // handled by the existence check below
      }
      done = await fileExists(expectedPath);
    }
    if (!done) {
      // Last resort: accept any PDF soffice managed to produce in the work dir.
      try {
        const produced = (await readdir(workDir)).filter((f) => f.toLowerCase().endsWith('.pdf'));
        if (produced.length > 0) {
          await rename(join(workDir, produced[0]), finalPath);
          args.onProgress('Conversion complete.', 100);
          return [{ name: finalName, path: finalPath, info: 'Converted with LibreOffice' }];
        }
      } catch {
        /* fall through to error */
      }
      throw new Error('The office converter could not process this file — is it a valid document?');
    }

    await rename(expectedPath, finalPath);
    args.onProgress('Conversion complete.', 100);
    return [{ name: finalName, path: finalPath, info: 'Converted with LibreOffice' }];
  });
}

// ========================================================= 6. html-to-pdf ====

let cachedChromePath: string | null | undefined;

/**
 * Locate a Chromium binary for puppeteer-core: CHROME_PATH first, then the
 * Playwright browser cache (full chromium and headless-shell variants),
 * for $HOME and /root. Result is cached at module scope.
 */
function findChromePathSync(): string | null {
  if (cachedChromePath !== undefined) return cachedChromePath;
  const candidates: string[] = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  const bases = Array.from(new Set([process.env.HOME || '/root', '/root']));
  for (const base of bases) {
    const cacheDir = join(base, '.cache', 'ms-playwright');
    let entries: string[] = [];
    try {
      entries = readdirSync(cacheDir);
    } catch {
      continue;
    }
    const chromiumDirs = entries.filter((e) => /^chromium-/.test(e)).sort().reverse();
    for (const d of chromiumDirs) {
      candidates.push(join(cacheDir, d, 'chrome-linux', 'chrome'));
      candidates.push(join(cacheDir, d, 'chrome-linux64', 'chrome'));
    }
    const shellDirs = entries.filter((e) => /^chromium_headless_shell-/.test(e)).sort().reverse();
    for (const d of shellDirs) {
      candidates.push(join(cacheDir, d, 'chrome-linux', 'chrome-headless-shell'));
      candidates.push(join(cacheDir, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    }
  }

  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) {
        cachedChromePath = c;
        return c;
      }
    } catch {
      // try next candidate
    }
  }
  cachedChromePath = null;
  return null;
}

// ---- SSRF guard ---------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return true; // malformed -> fail closed
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return isPrivateIPv4(mapped[1]); // IPv4-mapped
  if (s === '::' || s === '::1') return true; // unspecified / loopback
  if (/^f[c-d]/.test(s)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link local
  return false;
}

function isBlockedIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/** Resolve every address of a hostname; public only if ALL resolved IPs are public. */
async function isPublicHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    return false; // unresolvable -> fail closed
  }
  if (addrs.length === 0) return false;
  return addrs.every((a) => !isBlockedIp(a.address));
}

function isTimeoutError(e: unknown): boolean {
  if (e instanceof Error) {
    return e.name === 'TimeoutError' || /timeout|timed out/i.test(e.message);
  }
  return false;
}

async function runHtmlToPdf(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir }) => {
    const chromePath = findChromePathSync();
    if (!chromePath) throw new Error('No Chromium binary found for the HTML renderer.');

    const source = String(args.opts.source ?? 'url');
    const format: PaperFormat = String(args.opts.pageSize ?? 'A4') === 'Letter' ? 'Letter' : 'A4';
    const landscape = String(args.opts.orientation ?? 'portrait') === 'landscape';

    let outName: string;
    let gotoUrl: string | undefined;
    let htmlContent: string | undefined;

    if (source === 'file') {
      const input = await requireSingleInput(args.files, 'Upload exactly one HTML file to convert.');
      try {
        htmlContent = await readFile(input.path, 'utf8');
      } catch {
        throw new Error('The uploaded HTML file could not be read.');
      }
      outName = `${baseNameOf(input.name)}_web.pdf`;
    } else {
      const rawUrl = String(args.opts.url ?? '').trim();
      if (!rawUrl) throw new Error('Enter the URL of the page to convert.');
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new Error('That URL is not valid — include the full address, e.g. https://example.com.');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http and https URLs are supported.');
      }
      if (!(await isPublicHost(parsed.hostname))) {
        throw new Error('This URL points to a private or local address and is blocked for security.');
      }
      gotoUrl = parsed.toString();
      outName = `page_${sanitizeName(parsed.hostname)}.pdf`;
    }
    const outPath = join(resultsDir, outName);

    args.onProgress('Starting the browser engine...', 15);
    let browser: Browser | undefined;
    let mainFrameBlocked = false;

    try {
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: /headless/i.test(chromePath) ? 'shell' : true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      const page: Page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setRequestInterception(true);

      // Re-validate every request: catches redirects and subresources.
      page.on('request', (req: HTTPRequest) => {
        void (async () => {
          try {
            let url: URL;
            try {
              url = new URL(req.url());
            } catch {
              await req.abort();
              return;
            }
            if (url.protocol === 'data:' || url.protocol === 'about:') {
              await req.continue();
              return;
            }
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
              await req.abort(); // blocks file://, blob:// and anything exotic
              return;
            }
            if (!(await isPublicHost(url.hostname))) {
              if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
                mainFrameBlocked = true;
              }
              await req.abort();
              return;
            }
            await req.continue();
          } catch {
            try {
              await req.abort();
            } catch {
              // request already handled
            }
          }
        })();
      });

      if (gotoUrl) {
        args.onProgress('Loading the page...', 35);
        try {
          await page.goto(gotoUrl, { waitUntil: 'networkidle2', timeout: 45_000 });
        } catch (e) {
          if (mainFrameBlocked) {
            throw new Error('This URL points to a private or local address and is blocked for security.');
          }
          if (isTimeoutError(e)) {
            throw new Error('The page took too long to load — try again or pick a lighter page.');
          }
          throw new Error('Could not load the page — it may be unreachable or blocking automated access.');
        }
      } else if (htmlContent !== undefined) {
        args.onProgress('Rendering the uploaded HTML...', 35);
        try {
          await page.setContent(htmlContent, { waitUntil: 'load', timeout: 30_000 });
        } catch (e) {
          if (isTimeoutError(e)) {
            throw new Error('The HTML file took too long to render (30 s limit).');
          }
          throw new Error('Could not render the uploaded HTML file.');
        }
      } else {
        throw new Error('Choose a URL or upload an HTML file to convert.');
      }

      args.onProgress('Printing to PDF...', 75);
      await page.pdf({
        path: outPath,
        printBackground: true,
        format,
        landscape,
        margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
      });
    } finally {
      try {
        await browser?.close();
      } catch {
        // browser cleanup is best effort
      }
    }

    if (!(await fileExists(outPath))) {
      throw new Error('The PDF could not be generated from this page.');
    }
    args.onProgress('PDF ready.', 100);
    return [
      {
        name: outName,
        path: outPath,
        info: source === 'file' ? 'Rendered from uploaded HTML' : 'Rendered from web page',
      },
    ];
  });
}

// ========================================================= 7. pdf-to-word ====

function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length >= 80) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  const allCaps = letters.length >= 2 && t === t.toUpperCase();
  return allCaps || t.endsWith(':');
}

/** Merge extracted lines into paragraphs: blank lines and indented lines break. */
function paragraphsFromText(text: string): DocxParagraph[] {
  const paras: DocxParagraph[] = [];
  let buf = '';
  const flush = (): void => {
    const t = buf.trim();
    if (t && paras.length < MAX_DOCX_PARAGRAPHS) {
      paras.push({ text: t, rtl: ARABIC_RE.test(t) });
    }
    buf = '';
  };
  for (const line of text.split(/\r?\n/)) {
    if (paras.length >= MAX_DOCX_PARAGRAPHS) break;
    if (!line.trim()) {
      flush();
      continue;
    }
    const trimmed = line.trim();
    if (isHeadingLine(line)) {
      flush();
      paras.push({ text: trimmed, heading: true, rtl: ARABIC_RE.test(trimmed) });
      continue;
    }
    if (/^[ \t]{2,}/.test(line)) {
      flush();
      if (trimmed) paras.push({ text: trimmed, rtl: ARABIC_RE.test(trimmed) });
      continue;
    }
    buf = buf ? `${buf} ${trimmed}` : trimmed;
  }
  flush();
  return paras.slice(0, MAX_DOCX_PARAGRAPHS);
}

async function runPdfToWord(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir, workDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one PDF file to convert.');
    const layout = String(args.opts.layout ?? 'layout') !== 'flow';
    const txtPath = join(workDir, 'extracted.txt');

    args.onProgress(layout ? 'Extracting text with layout preserved...' : 'Extracting text in reading order...', 25);
    try {
      await runBin(
        'pdftotext',
        layout
          ? ['-layout', '-enc', 'UTF-8', input.path, txtPath]
          : ['-enc', 'UTF-8', input.path, txtPath],
        { timeoutMs: DEFAULT_TIMEOUT_MS }
      );
    } catch {
      throw new Error('Could not extract text from this PDF — it may be corrupted or contain only images.');
    }

    const text = await readFile(txtPath, 'utf8');
    const paragraphs = paragraphsFromText(text);
    if (paragraphs.length === 0) {
      throw new Error('No text could be extracted — this PDF may be scanned. Try the OCR tool first.');
    }

    args.onProgress(`Building the Word document (${paragraphs.length} paragraphs)...`, 70);
    const buffer = await textToDocxBuffer(paragraphs);
    const outName = `${baseNameOf(input.name)}.docx`;
    const outPath = join(resultsDir, outName);
    await writeFile(outPath, buffer);

    args.onProgress('Word document ready.', 100);
    return [{ name: outName, path: outPath, info: `${paragraphs.length} paragraphs` }];
  });
}

// ======================================================= 8. pdf-to-excel =====

async function runPdfToExcel(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir, workDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one PDF file to convert.');
    const pages = await pdfPageCount(input.path);
    if (pages === null) {
      throw new Error('Could not read this PDF — it may be corrupted.');
    }

    const sheets: string[][][] = [];
    let totalCells = 0;
    let capped = false;

    for (let p = 1; p <= pages; p++) {
      args.onProgress(`Extracting page ${p} of ${pages}...`, 10 + Math.round((p / pages) * 60));
      const txtPath = join(workDir, `page-${p}.txt`);
      let text = '';
      try {
        await runBin(
          'pdftotext',
          ['-layout', '-f', String(p), '-l', String(p), '-enc', 'UTF-8', input.path, txtPath],
          { timeoutMs: DEFAULT_TIMEOUT_MS }
        );
        text = await readFile(txtPath, 'utf8');
      } catch {
        text = ''; // unreadable page -> empty sheet
      }

      const rows: string[][] = [];
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const row = line.split(/\s{2,}|\t/).map((cell) => cell.trim());
        if (row.every((cell) => cell.length === 0)) continue; // drop empty rows
        if (totalCells + row.length > MAX_XLSX_CELLS) {
          capped = true;
          break;
        }
        rows.push(row);
        totalCells += row.length;
      }
      sheets.push(rows);
      if (capped) break;
    }

    args.onProgress('Building the Excel workbook...', 80);
    const buffer = pagesToXlsxBuffer(sheets);
    const outName = `${baseNameOf(input.name)}.xlsx`;
    const outPath = join(resultsDir, outName);
    await writeFile(outPath, buffer);

    const info = `${sheets.length} sheets (one per page)${capped ? ' · large document, output truncated' : ''}`;
    args.onProgress('Excel workbook ready.', 100);
    return [{ name: outName, path: outPath, info }];
  });
}

// ========================================================= 9. pdf-to-ppt =====

async function runPdfToPpt(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir, workDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one PDF file to convert.');
    const txtPath = join(workDir, 'slides.txt');

    args.onProgress('Extracting text page by page...', 30);
    try {
      await runBin('pdftotext', ['-raw', '-enc', 'UTF-8', input.path, txtPath], {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch {
      throw new Error('Could not extract text from this PDF — it may be corrupted or contain only images.');
    }

    const text = await readFile(txtPath, 'utf8');
    let pages = text.split('\f');
    // pdftotext terminates the output with a form feed — the trailing chunk is
    // not a real page.
    if (pages.length > 0 && pages[pages.length - 1] === '') pages.pop();

    const slides = pages.map((pageText, idx) => {
      const lines = pageText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const title = lines.length > 0 ? truncateLine(lines[0], 120) : `Page ${idx + 1}`;
      const body = truncateLine(lines.slice(1).join('\n'), 3000);
      return { title, body };
    });

    if (slides.length === 0) {
      throw new Error('No text could be extracted from this PDF — try the OCR tool first.');
    }

    args.onProgress(`Building ${slides.length} slides...`, 75);
    const buffer = await pagesToPptxBuffer(slides);
    const outName = `${baseNameOf(input.name)}.pptx`;
    const outPath = join(resultsDir, outName);
    await writeFile(outPath, buffer);

    args.onProgress('PowerPoint ready.', 100);
    return [{ name: outName, path: outPath, info: `${slides.length} slides` }];
  });
}

// ================================================================ 10. ocr ====

async function listTesseractLangs(): Promise<Set<string>> {
  try {
    const { stdout } = await runBin('tesseract', ['--list-langs'], { timeoutMs: 30_000 });
    return new Set(
      stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^list of available languages/i.test(l))
    );
  } catch {
    return new Set();
  }
}

/**
 * Build a private tessdata dir when a requested language is missing system-wide
 * (e.g. Arabic). Returns an env with TESSDATA_PREFIX set, or undefined when the
 * system defaults already cover the request.
 */
async function prepareTessdata(workDir: string, needed: string[]): Promise<NodeJS.ProcessEnv | undefined> {
  const sysLangs = await listTesseractLangs();
  const missing = needed.filter((l) => !sysLangs.has(l));
  if (missing.length === 0) return undefined;

  const tessDir = join(workDir, 'tessdata');
  await ensureDir(tessDir);

  // Seed with the system tessdata tree (eng, osd, configs, pdf.ttf, ...).
  let sysDir: string | null = null;
  try {
    const versions = (await readdir(SYSTEM_TESSDATA_ROOT)).sort().reverse();
    for (const v of versions) {
      const cand = join(SYSTEM_TESSDATA_ROOT, v, 'tessdata');
      try {
        const st = await stat(cand);
        if (st.isDirectory()) {
          sysDir = cand;
          break;
        }
      } catch {
        // try next version
      }
    }
  } catch {
    sysDir = null;
  }
  if (sysDir) {
    try {
      await cp(sysDir, tessDir, { recursive: true });
    } catch {
      // best effort — the per-language copies below still apply
    }
  }

  for (const lang of missing) {
    const friendly =
      lang === 'ara'
        ? 'Arabic OCR data is not available on this server.'
        : `OCR data for "${lang}" is not available on this server.`;
    try {
      await copyFile(join(OMR_TESSDATA_DIR, `${lang}.traineddata`), join(tessDir, `${lang}.traineddata`));
      await access(join(tessDir, `${lang}.traineddata`));
    } catch {
      throw new Error(friendly);
    }
  }
  return { ...process.env, TESSDATA_PREFIX: tessDir };
}

/** Numeric suffix compare so page-2.png sorts before page-10.png. */
function pageImageCompare(a: string, b: string): number {
  const na = Number.parseInt(/(\d+)(?=\.png$)/.exec(a)?.[1] ?? '0', 10);
  const nb = Number.parseInt(/(\d+)(?=\.png$)/.exec(b)?.[1] ?? '0', 10);
  return na - nb || a.localeCompare(b);
}

async function runOcr(args: { dir: string; files: ServerInputFile[]; opts: Record<string, string | number | boolean>; onProgress: ServerProgress }): Promise<ServerResultFile[]> {
  assertUsableDir(args.dir);
  return withJobDirs(args.dir, async ({ resultsDir, workDir }) => {
    const input = await requireSingleInput(args.files, 'Upload exactly one PDF file to OCR.');
    const langRaw = String(args.opts.language ?? 'eng');
    const lang = langRaw === 'ara' || langRaw === 'eng+ara' ? langRaw : 'eng';
    const output = String(args.opts.output ?? 'pdf') === 'text' ? 'text' : 'pdf';
    const base = baseNameOf(input.name);

    // Enforce the page cap before any heavy rendering work.
    const pageCount = await pdfPageCount(input.path);
    if (pageCount !== null && pageCount > MAX_OCR_PAGES) {
      throw new Error('OCR is limited to 60 pages per job — split the document first.');
    }

    // Resolve language data once (may build a private tessdata dir for Arabic).
    const needed = lang === 'eng+ara' ? ['eng', 'ara'] : [lang];
    const tesseractEnv = await prepareTessdata(workDir, needed);

    args.onProgress('Rendering pages to images...', 10);
    const prefix = join(workDir, 'page');
    try {
      await runBin('pdftoppm', ['-png', '-r', '200', input.path, prefix], { timeoutMs: OCR_TIMEOUT_MS });
    } catch {
      throw new Error('Could not render the PDF pages — the file may be corrupted.');
    }

    const pageImages = (await readdir(workDir))
      .filter((f) => /^page-.*\.png$/.test(f))
      .sort(pageImageCompare);
    if (pageImages.length === 0) {
      throw new Error('Could not render the PDF pages — the file may be corrupted.');
    }
    if (pageImages.length > MAX_OCR_PAGES) {
      throw new Error('OCR is limited to 60 pages per job — split the document first.');
    }

    const langLabel = lang === 'eng' ? 'English' : lang === 'ara' ? 'Arabic' : 'English + Arabic';
    const perPagePdfs: string[] = [];
    const perPageTxts: string[] = [];

    for (let i = 0; i < pageImages.length; i++) {
      const img = join(workDir, pageImages[i]);
      const outbase = join(workDir, `ocr-${i + 1}`);
      args.onProgress(
        `Recognizing page ${i + 1} of ${pageImages.length}...`,
        15 + Math.round(((i + 1) / pageImages.length) * 70)
      );
      try {
        await runBin(
          'tesseract',
          [img, outbase, '-l', lang, '--psm', 'auto', output === 'pdf' ? 'pdf' : 'txt'],
          { timeoutMs: OCR_TIMEOUT_MS, env: tesseractEnv }
        );
      } catch (e) {
        if (e instanceof EngineError && e.message.includes('timed out')) {
          throw new Error(`OCR timed out on page ${i + 1} — the page may be too dense.`);
        }
        throw new Error(`OCR failed on page ${i + 1} — recognition could not complete.`);
      }
      const produced = output === 'pdf' ? `${outbase}.pdf` : `${outbase}.txt`;
      if (!(await fileExists(produced))) {
        throw new Error(`OCR failed on page ${i + 1} — recognition could not complete.`);
      }
      if (output === 'pdf') perPagePdfs.push(produced);
      else perPageTxts.push(produced);
    }

    if (output === 'pdf') {
      args.onProgress('Assembling the searchable PDF...', 92);
      const merged = await PDFDocument.create();
      for (const p of perPagePdfs) {
        try {
          const bytes = await readFile(p);
          const src = await PDFDocument.load(bytes);
          const copied = await merged.copyPages(src, src.getPageIndices());
          for (const pg of copied) merged.addPage(pg);
        } catch {
          throw new Error('Assembling the searchable PDF failed — recognition output was unreadable.');
        }
      }
      const outBytes = await merged.save();
      const outName = `${base}_ocr.pdf`;
      const outPath = join(resultsDir, outName);
      await writeFile(outPath, outBytes);
      args.onProgress('OCR complete.', 100);
      return [{ name: outName, path: outPath, info: `${perPagePdfs.length} pages, ${langLabel}` }];
    }

    args.onProgress('Collecting text output...', 92);
    const chunks: string[] = [];
    for (const t of perPageTxts) {
      chunks.push((await readFile(t, 'utf8')).trimEnd());
    }
    const outName = `${base}_ocr.txt`;
    const outPath = join(resultsDir, outName);
    await writeFile(outPath, `${chunks.join('\n\n')}\n`, 'utf8');
    args.onProgress('OCR complete.', 100);
    return [{ name: outName, path: outPath, info: `${perPageTxts.length} pages of text` }];
  });
}

// ---------------------------------------------------------------- registry ----

export const SERVER_TOOLS: Record<string, ServerToolFn> = {
  repair: runRepair,
  protect: runProtect,
  unlock: runUnlock,
  'pdf-to-pdfa': runPdfToPdfa,
  'office-to-pdf': runOfficeToPdf,
  'html-to-pdf': runHtmlToPdf,
  'pdf-to-word': runPdfToWord,
  'pdf-to-excel': runPdfToExcel,
  'pdf-to-ppt': runPdfToPpt,
  ocr: runOcr,
};

let binAvailabilityCache: Map<string, boolean> | undefined;

/** Sync PATH scan for a binary (cheap, cached at module scope). */
function hasBin(bin: string): boolean {
  if (!binAvailabilityCache) binAvailabilityCache = new Map<string, boolean>();
  const hit = binAvailabilityCache.get(bin);
  if (hit !== undefined) return hit;
  let found = false;
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    try {
      if (statSync(join(dir, bin)).isFile()) {
        found = true;
        break;
      }
    } catch {
      // not here — keep scanning
    }
  }
  binAvailabilityCache.set(bin, found);
  return found;
}

/** Cheap sync health probe for the /api/pw/health endpoint. */
export function engineAvailability(): Record<string, boolean> {
  return {
    soffice: hasBin('soffice'),
    qpdf: hasBin('qpdf'),
    gs: hasBin('gs'),
    tesseract: hasBin('tesseract'),
    pdftotext: hasBin('pdftotext'),
    puppeteer: findChromePathSync() !== null,
  };
}
