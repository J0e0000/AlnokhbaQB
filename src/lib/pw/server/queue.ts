// Pagewise server job queue — in-memory registry + per-job temp directories
// with a hard TTL, delete-on-download, rate limiting and magic-byte checks.
// Single-process by design (matches this deployment); no database needed.

import { mkdir, readdir, rm, stat } from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { SERVER_TOOLS, type ServerInputFile } from './engines';

const ROOT = path.join(os.tmpdir(), 'pagewise-jobs');
const TTL_MS = 60 * 60 * 1000; // jobs are deleted 1 hour after completion
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_CONCURRENT = 2;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_FILES = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_JOBS = 15; // per IP per hour
const RATE_MAX_ACTIVE = 3; // per IP concurrently

export interface JobResultMeta {
  name: string;
  path: string;
  size: number;
  info?: string;
  downloaded: boolean;
}

export interface JobRecord {
  id: string;
  tool: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
  createdAt: number;
  completedAt?: number;
  error?: string;
  results: JobResultMeta[];
  ip: string;
  dir: string;
  opts: Record<string, string | number | boolean>;
}

interface Store {
  jobs: Map<string, JobRecord>;
  queue: string[];
  running: number;
  rate: Map<string, number[]>;
  sweeper?: ReturnType<typeof setInterval>;
}

const g = globalThis as typeof globalThis & { __pwStore?: Store };

function store(): Store {
  if (!g.__pwStore) {
    g.__pwStore = { jobs: new Map(), queue: [], running: 0, rate: new Map() };
    g.__pwStore.sweeper = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    if (typeof g.__pwStore.sweeper.unref === 'function') g.__pwStore.sweeper.unref();
  }
  return g.__pwStore;
}

// ------------------------------------------------------------- validation --

type FileKind = 'pdf' | 'office' | 'html';

function magicKind(name: string, mime: string, buf: Buffer): FileKind | null {
  const ext = path.extname(name).toLowerCase();
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'office'; // zip-based OOXML/ODF
  if (
    buf.length >= 8 &&
    buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
  ) return 'office'; // legacy OLE (doc/xls/ppt)
  const head = buf.subarray(0, 512).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || mime === 'text/html' || ext === '.html' || ext === '.htm') return 'html';
  return null;
}

const TOOL_RULES: Record<string, { kinds: FileKind[]; maxFiles: number; maxBytes: number }> = {
  repair: { kinds: ['pdf'], maxFiles: 1, maxBytes: 100 * 1024 * 1024 },
  protect: { kinds: ['pdf'], maxFiles: 1, maxBytes: 100 * 1024 * 1024 },
  unlock: { kinds: ['pdf'], maxFiles: 1, maxBytes: 100 * 1024 * 1024 },
  'pdf-to-pdfa': { kinds: ['pdf'], maxFiles: 1, maxBytes: 100 * 1024 * 1024 },
  ocr: { kinds: ['pdf'], maxFiles: 1, maxBytes: 80 * 1024 * 1024 },
  'pdf-to-word': { kinds: ['pdf'], maxFiles: 1, maxBytes: 60 * 1024 * 1024 },
  'pdf-to-excel': { kinds: ['pdf'], maxFiles: 1, maxBytes: 60 * 1024 * 1024 },
  'pdf-to-ppt': { kinds: ['pdf'], maxFiles: 1, maxBytes: 60 * 1024 * 1024 },
  'office-to-pdf': { kinds: ['office'], maxFiles: 1, maxBytes: 60 * 1024 * 1024 },
  'html-to-pdf': { kinds: ['html'], maxFiles: 1, maxBytes: 5 * 1024 * 1024 },
};

export function validateFiles(tool: string, entries: { name: string; mime: string; buf: Buffer }[]): void {
  const rules = TOOL_RULES[tool];
  if (!rules) throw new Error('Unknown tool');
  if (entries.length === 0) throw new Error('No files were uploaded for this job');
  if (entries.length > rules.maxFiles) throw new Error(`This tool accepts at most ${rules.maxFiles} file${rules.maxFiles > 1 ? 's' : ''}`);
  const total = entries.reduce((s, e) => s + e.buf.length, 0);
  if (total > rules.maxBytes) throw new Error(`Files are too large — the limit for this tool is ${Math.round(rules.maxBytes / 1024 / 1024)} MB`);
  if (total > MAX_TOTAL_BYTES) throw new Error('Files are too large (60 MB limit)');
  for (const e of entries) {
    const kind = magicKind(e.name, e.mime, e.buf);
    if (!kind || !rules.kinds.includes(kind)) {
      throw new Error(
        `"${e.name}" does not look like an accepted ${rules.kinds.join('/')} file for this tool (checked by content, not just extension).`
      );
    }
  }
}

// -------------------------------------------------------------- rate limit --

export function checkRateLimit(ip: string): void {
  const s = store();
  const now = Date.now();
  const arr = (s.rate.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_JOBS) {
    throw new Error('Hourly job limit reached (15/h). Please try again later.');
  }
  const active = [...s.jobs.values()].filter((j) => j.ip === ip && (j.status === 'running' || j.status === 'queued')).length;
  if (active >= RATE_MAX_ACTIVE) {
    throw new Error('You already have several jobs running — wait for them to finish.');
  }
  arr.push(now);
  s.rate.set(ip, arr);
}

// ------------------------------------------------------------------ queue --

export interface CreateJobInput {
  tool: string;
  ip: string;
  entries: { name: string; mime: string; buf: Buffer }[];
  opts: Record<string, string | number | boolean>;
}

export async function createJob(input: CreateJobInput): Promise<JobRecord> {
  const s = store();
  if (!SERVER_TOOLS[input.tool]) throw new Error('Unknown tool');
  validateFiles(input.tool, input.entries);

  const id = randomUUID();
  const dir = path.join(ROOT, id);
  const inputDir = path.join(dir, 'input');
  const resultsDir = path.join(dir, 'results');
  await mkdir(inputDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  const files: ServerInputFile[] = [];
  for (let i = 0; i < input.entries.length; i++) {
    const e = input.entries[i];
    const safe = e.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || `file${i}`;
    const p = path.join(inputDir, `${i}_${safe}`);
    await (await import('fs/promises')).writeFile(p, e.buf);
    files.push({ name: safe, path: p, size: e.buf.length, mime: e.mime });
  }

  const job: JobRecord = {
    id,
    tool: input.tool,
    status: 'queued',
    progress: 0,
    message: 'Queued',
    createdAt: Date.now(),
    results: [],
    ip: input.ip,
    dir,
    opts: input.opts,
  };
  s.jobs.set(id, job);
  s.queue.push(id);
  void pump();
  return job;
}

async function pump(): Promise<void> {
  const s = store();
  while (s.running < MAX_CONCURRENT && s.queue.length > 0) {
    const id = s.queue.shift();
    if (!id) break;
    const job = s.jobs.get(id);
    if (!job) continue;
    s.running++;
    void runJob(job).finally(() => {
      s.running--;
      void pump();
    });
  }
}

async function runJob(job: JobRecord): Promise<void> {
  const s = store();
  job.status = 'running';
  job.message = 'Starting…';
  job.progress = 2;
  try {
    const inputDir = path.join(job.dir, 'input');
    const names = await readdir(inputDir);
    const files: ServerInputFile[] = [];
    for (const n of names) {
      const p = path.join(inputDir, n);
      const st = await stat(p);
      files.push({ name: n.replace(/^\d+_/, ''), path: p, size: st.size, mime: '' });
    }
    const resultsDir = path.join(job.dir, 'results');
    const fn = SERVER_TOOLS[job.tool];
    const out = await fn({
      dir: job.dir,
      files,
      opts: job.opts,
      onProgress: (message, percent) => {
        job.message = message;
        job.progress = Math.max(0, Math.min(99, Math.round(percent ?? job.progress)));
      },
    });
    const results: JobResultMeta[] = [];
    for (const r of out) {
      const st = await stat(r.path);
      results.push({ name: path.basename(r.name), path: r.path, size: st.size, info: r.info, downloaded: false });
    }
    if (results.length === 0) throw new Error('The engine produced no output');
    job.results = results;
    job.status = 'done';
    job.progress = 100;
    job.message = 'Done';
    job.completedAt = Date.now();
  } catch (err) {
    job.status = 'error';
    job.error = err instanceof Error ? err.message : 'The job failed unexpectedly';
    job.completedAt = Date.now();
  }
}

export async function getJob(id: string): Promise<JobRecord | undefined> {
  return store().jobs.get(id);
}

export function jobStatusView(job: JobRecord) {
  return {
    id: job.id,
    tool: job.tool,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    results: job.results.map((r) => ({ name: r.name, size: r.size, info: r.info })),
  };
}

/** Read one result file; marks it downloaded and cleans up once all are fetched. */
export async function readResult(jobId: string, fileName: string): Promise<{ job: JobRecord; meta: JobResultMeta; data: Buffer } | null> {
  const job = store().jobs.get(jobId);
  if (!job || job.status !== 'done') return null;
  const meta = job.results.find((r) => r.name === fileName);
  if (!meta) return null;
  try {
    const { readFile } = await import('fs/promises');
    const data = await readFile(meta.path);
    meta.downloaded = true;
    if (job.results.every((r) => r.downloaded)) {
      await removeJob(jobId);
    }
    return { job, meta, data };
  } catch {
    return null;
  }
}

export async function removeJob(id: string): Promise<void> {
  const s = store();
  const job = s.jobs.get(id);
  if (!job) return;
  s.jobs.delete(id);
  await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
}

async function sweep(): Promise<void> {
  const s = store();
  const now = Date.now();
  for (const job of [...s.jobs.values()]) {
    const expired = job.completedAt && now - job.completedAt > TTL_MS;
    const stale = !job.completedAt && now - job.createdAt > 3 * TTL_MS;
    if (expired || stale) await removeJob(job.id);
  }
}
