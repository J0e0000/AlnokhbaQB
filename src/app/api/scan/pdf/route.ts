// POST /api/scan/pdf — batch OMR processing for multi-page PDF uploads
// (e.g. a stack of 100 scanned sheets). Cursor-based: each call rasterizes
// and processes AT MOST `batchSize` pages (default 6), so a single request
// stays well inside serverless time budgets; the client loops with the
// returned cursor until done — with live per-page progress in the UI.
//
// Body: { pdfBase64, examVersionIdHint?, batchId?, fromPage?, batchSize?, pageChunk? }
//  • first call: page `fromPage` is processed once WITHOUT template → engine
//    QR-decodes the exam version (or `examVersionIdHint` is used) → org
//    ownership verified → template + answer key resolved for the whole batch.
//  • every page: engine /process with template → server-side grade →
//    idempotent persist (imageHash of the rendered page) → review routing.
//  • pageChunk mode (Vercel): the CLIENT slices the PDF per page with pdf-lib
//    and sends ONE single-page slice per request — whole-PDF bodies exceed the
//    platform's 4.5MB function payload cap on real scanned stacks. In this
//    mode pdfBase64 IS one page, `pageChunk.index` is its absolute page number
//    and `pageChunk.total` is the client-known page count.
// Response: { total, results[], nextFrom, done, batchId, examVersionId? }
//
// Auth/tenant: same as /api/scan (teacher+; scans scoped via exam org).

import { createHash, randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { audit } from '@/lib/auth';
import { gradeScan } from '@/lib/qb/grading';
import {
  isTransportError,
  pdfPages,
  processScan,
  type ProcessScanResult,
} from '@/lib/omr/client';
import type { OMRTemplate, QBAnswerKey, QBDocument, QBScannedAnswer } from '@/lib/qb/types';
import {
  ensureActiveCalibration,
  rateLimit,
  readJsonBody,
  scanMaxPdfBytes,
  scanMaxPdfPages,
  scanPdfDpi,
  serverError,
  stripDataUrl,
  thresholdsFromConfig,
} from '../../_lib/shared';
import { requireSession } from '../../_lib/auth-guard';
import { loadVersion, loadVersionHint } from '../../_lib/version';
import { persistScanImage } from '@/lib/omr/scan-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_TOTAL_PAGES = scanMaxPdfPages();
const DEFAULT_BATCH = 6;
const MAX_BATCH = 10;

function meanConfidence(answers: QBScannedAnswer[]): number {
  if (!answers.length) return 0;
  const sum = answers.reduce((acc, a) => acc + (Number.isFinite(a.confidence) ? a.confidence : 0), 0);
  return Math.round((sum / answers.length) * 1000) / 1000;
}

function normalizeStudentCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\s+/g, '');
  if (!digits || !/^\d{1,12}$/.test(digits)) return null;
  return digits;
}

/** Persist via disk + Vercel Blob (canonical on serverless) — see scan-store.ts. */
function saveScanImage(base64: string, scanId: string, kind: 'debug' | 'corrected'): Promise<string | null> {
  return persistScanImage(scanId, kind, base64);
}

interface PdfInput {
  base64: string;
  /** bytes kept for server-side validation (signature/pages/encryption) */
  bytes: Buffer;
  /** scalar fields accepted from either transport */
  fromPage: number;
  batchSize: number;
  pageChunk: { index: number; total: number | null } | null;
  hint: string | undefined;
  batchId: string;
}

function intField(raw: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Read the PDF from EITHER a multipart/form-data upload (binary `pdf` file —
 * preferred: no base64 overhead, works past the JSON body limits on
 * self-hosted runs) or the legacy JSON body (`pdfBase64`). Applies the
 * shared size cap + %PDF signature check and returns raw bytes, base64
 * and the request's scalar fields.
 */
async function readPdfInput(req: Request): Promise<
  { ok: true; input: PdfInput } | { ok: false; status: number; error: string }
> {
  const maxBytes = scanMaxPdfBytes();
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return { ok: false, status: 400, error: 'تعذر قراءة البيانات المرفوعة (multipart)' };
    }
    const file = form.get('pdf');
    if (!(file instanceof File)) {
      return { ok: false, status: 400, error: 'ملف PDF مطلوب (الحقل pdf)' };
    }
    if (file.size > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: `حجم الملف كبير جدًا (الحد ${Math.round(maxBytes / 1024 / 1024)} ميجابايت)`,
      };
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return { ok: false, status: 415, error: 'الملف ليس PDF صالحًا' };
    }
    const chunkRaw = form.get('pageChunk');
    let pageChunk: PdfInput['pageChunk'] = null;
    if (typeof chunkRaw === 'string' && chunkRaw.trim()) {
      try {
        const parsed = JSON.parse(chunkRaw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          pageChunk = {
            index: intField(parsed.index, 0, 0, 100000),
            total: intField(parsed.total, 0, 0, 100000) || null,
          };
        }
      } catch {
        /* malformed pageChunk → treated as absent */
      }
    }
    const batchIdRaw = form.get('batchId');
    return {
      ok: true,
      input: {
        base64: bytes.toString('base64'),
        bytes,
        fromPage: intField(form.get('fromPage'), 0, 0, 100000),
        batchSize: intField(form.get('batchSize'), DEFAULT_BATCH, 1, MAX_BATCH),
        pageChunk,
        hint: typeof form.get('examVersionIdHint') === 'string' ? (form.get('examVersionIdHint') as string) : undefined,
        batchId:
          typeof batchIdRaw === 'string' && batchIdRaw.length > 0 && batchIdRaw.length <= 64
            ? batchIdRaw
            : randomUUID(),
      },
    };
  }

  // legacy JSON path (kept for old clients + the engine-side E2E script)
  const body = await readJsonBody(req);
  const rawPdf = typeof body?.pdfBase64 === 'string' ? body.pdfBase64 : '';
  if (!rawPdf) {
    return { ok: false, status: 400, error: 'ملف PDF مطلوب (الحقل pdf أو pdfBase64)' };
  }
  const { base64 } = stripDataUrl(rawPdf);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `حجم الملف كبير جدًا (الحد ${Math.round(maxBytes / 1024 / 1024)} ميجابايت)`,
    };
  }
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, status: 415, error: 'الملف ليس PDF صالحًا' };
  }
  return {
    ok: true,
    input: {
      base64,
      bytes,
      fromPage: intField(body?.fromPage, 0, 0, 100000),
      batchSize: intField(body?.batchSize, DEFAULT_BATCH, 1, MAX_BATCH),
      pageChunk:
        body?.pageChunk && typeof body.pageChunk === 'object'
          ? {
              index: intField((body.pageChunk as Record<string, unknown>).index, 0, 0, 100000),
              total: intField((body.pageChunk as Record<string, unknown>).total, 0, 0, 100000) || null,
            }
          : null,
      hint: typeof body?.examVersionIdHint === 'string' ? body.examVersionIdHint : undefined,
      batchId:
        typeof body?.batchId === 'string' && body.batchId.length <= 64
          ? body.batchId
          : randomUUID(),
    },
  };
}

/**
 * Server-side structural PDF validation BEFORE the engine runs:
 * page count cap + encryption + gross corruption (pdf-lib parse).
 * Returns the page count, or an HTTP-mappable rejection.
 */
async function validatePdfStructure(bytes: Buffer): Promise<
  { ok: true; pageCount: number } | { ok: false; status: number; error: string }
> {
  let doc: import('pdf-lib').PDFDocument;
  try {
    doc = await (await import('pdf-lib')).PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    const msg = err instanceof Error ? err.message : String(err);
    if (name === 'EncryptedPDFError' || /encrypt/i.test(msg)) {
      return {
        ok: false,
        status: 422,
        error: 'الملف محمي بكلمة مرور — أزل التشفير ثم أعد الرفع',
      };
    }
    return {
      ok: false,
      status: 422,
      error: 'الملف تالف أو غير قابل للقراءة — أعد مسحه أو تصديره بصيغة PDF قياسية',
    };
  }
  const pageCount = doc.getPageCount();
  if (pageCount <= 0) {
    return { ok: false, status: 422, error: 'الملف لا يحتوي على أي صفحات' };
  }
  if (pageCount > MAX_TOTAL_PAGES) {
    return {
      ok: false,
      status: 413,
      error: `عدد صفحات الملف ${pageCount} يتجاوز الحد المسموح (${MAX_TOTAL_PAGES})`,
    };
  }
  return { ok: true, pageCount };
}

export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    if (!rateLimit(`scanpdf:${g.session.uid}`, 30, 60_000)) {
      return NextResponse.json(
        { error: 'عدد كبير من عمليات المعالجة — انتظر لحظة ثم أعد المحاولة' },
        { status: 429 }
      );
    }

    const pdfInput = await readPdfInput(req);
    if (!pdfInput.ok) {
      return NextResponse.json({ error: pdfInput.error }, { status: pdfInput.status });
    }
    const { base64: pdfBase64, ...fields } = pdfInput.input;
    // Structural validation (pages/encryption/corruption) BEFORE engine CPU:
    // cheap pdf-lib parse, precise Arabic errors, correct HTTP statuses.
    const structure = await validatePdfStructure(pdfInput.input.bytes);
    if (!structure.ok) {
      return NextResponse.json({ error: structure.error }, { status: structure.status });
    }

    const fromPage = fields.fromPage;
    const batchSize = fields.batchSize;
    // pageChunk mode: pdfBase64 is a single client-side slice
    const pageChunk = fields.pageChunk;
    const hint = fields.hint;
    const batchId = fields.batchId;

    // ---- calibration
    const profile = await ensureActiveCalibration();
    const thresholds = thresholdsFromConfig(profile.configJson);

    // ---- rasterize this chunk (pageChunk mode: the slice IS one page)
    // DPI defaults to 300 — the engine's canonical warp resolution — so small
    // bubbles keep their geometry; SCAN_PDF_DPI can lower it for slow hosts.
    const chunk = await pdfPages({
      pdfBase64,
      fromPage: pageChunk ? 0 : fromPage,
      maxPages: batchSize,
      dpi: scanPdfDpi(),
    });
    if (!('pages' in chunk) || !Array.isArray((chunk as { pages?: unknown }).pages)) {
      const err = chunk as { error?: string; stage?: string };
      // engine 'pdf' stage = bad input (encrypted/corrupt/empty) → 422;
      // transport stages (engine down/timeout) → 503 for client retries.
      const badInput = err.stage === 'pdf' || err.stage === 'engineProtocol';
      return NextResponse.json(
        {
          error: err.error ?? 'تعذر قراءة ملف PDF في محرك المعالجة',
          stage: err.stage,
        },
        { status: badInput ? 422 : 503 }
      );
    }
    const pages = chunk.pages;
    const total = pageChunk?.total ?? Math.max(chunk.total, structure.pageCount);
    if (total > MAX_TOTAL_PAGES) {
      return NextResponse.json(
        { error: `عدد صفحات الملف ${total} يتجاوز الحد المسموح (${MAX_TOTAL_PAGES})` },
        { status: 413 }
      );
    }

    // ---- template resolution (once per batch)
    let template: OMRTemplate | null = null;
    let versionDoc: QBDocument | null = null;
    let versionKey: QBAnswerKey = {};
    let resolvedVersionId: string | null = null;

    const buildEngineKey = (doc: QBDocument, key: QBAnswerKey) => {
      const answerKeyByNumber: Record<string, string> = {};
      const marksMap: Record<string, number> = {};
      for (const q of doc.questions) {
        const letter = key[q.id];
        if (letter) answerKeyByNumber[String(q.number)] = letter;
        marksMap[String(q.number)] = q.marks;
      }
      return { answerKeyByNumber, marksMap };
    };

    const resolveVersion = async (viaPageB64: string | null): Promise<boolean> => {
      let versionId = hint ?? null;
      if (!versionId && viaPageB64) {
        const ident = await processScan({
          imageBase64: viaPageB64,
          template: null,
          thresholds,
          debug: false,
        });
        if (isTransportError(ident)) return false;
        if (ident.ok && ident.qr?.examVersionId) versionId = ident.qr.examVersionId;
      }
      if (!versionId) return false;
      // hint may be an ExamVersion id (new clients) or an Exam id (legacy picker)
      const loaded = await loadVersionHint(versionId);
      if (!loaded || !loaded.omrTemplate) return false;
      if (
        g.session.role !== 'super_admin' &&
        loaded.row.exam.organizationId !== g.session.orgId
      ) {
        return false; // another org's version → behave like unknown QR
      }
      template = loaded.omrTemplate;
      versionDoc = loaded.document;
      versionKey = loaded.answerKey;
      resolvedVersionId = loaded.row.id;
      return true;
    };

    interface PageResult {
      index: number;
      scanId: string | null;
      duplicate?: boolean;
      ok: boolean;
      error?: string;
      stage?: string;
      studentCode?: string | null;
      studentName?: string | null;
      score?: number | null;
      maxScore?: number | null;
      needsReview?: boolean;
      transportAbort?: boolean;
    }
    const results: PageResult[] = [];

    for (let i = 0; i < pages.length; i++) {
      const pageIndexAbs = pageChunk ? pageChunk.index + i : fromPage + i;
      const pageB64 = pages[i];
      const imageHash = createHash('sha256').update(pageB64).digest('hex');
      const entry: PageResult = { index: pageIndexAbs, scanId: null, ok: false };
      void entry;

      try {
        // idempotent: identical rendered page already finalized → reuse
        const dup = await db.scan.findFirst({
          where: { imageHash, status: { in: ['PROCESSED', 'REVIEWED'] } },
          select: { id: true, studentCode: true, gradeJson: true },
        });
        if (dup) {
          const g0 = JSON.parse(dup.gradeJson || '{}') as { score?: number; maxScore?: number };
          results.push({
            index: pageIndexAbs,
            scanId: dup.id,
            duplicate: true,
            ok: true,
            studentCode: dup.studentCode,
            score: g0.score ?? null,
            maxScore: g0.maxScore ?? null,
          });
          continue;
        }

        if (!template && !(await resolveVersion(pageB64))) {
          // unresolved on this page → record and keep going (later pages may QR)
          results.push({
            index: pageIndexAbs,
            scanId: null,
            ok: false,
            stage: 'noMatchingVersion',
            error: 'لا توجد نسخة امتحان مطابقة — تأكد من وضوح رمز QR أو اختر النسخة يدويًا',
          });
          continue;
        }

        const { answerKeyByNumber, marksMap } = buildEngineKey(versionDoc!, versionKey);
        const res: ProcessScanResult = await processScan({
          imageBase64: pageB64,
          template: template!,
          answerKey: answerKeyByNumber,
          marksMap,
          thresholds,
          debug: true,
        });
        if (isTransportError(res)) {
          // engine down mid-batch → abort chunk, client resumes by cursor
          results.push({
            index: pageIndexAbs,
            scanId: null,
            ok: false,
            stage: res.stage,
            error: res.error,
            transportAbort: true,
          });
          break;
        }

        // page belongs to another version (mixed stack) → record failure
        if (!res.ok) {
          const failed = await db.scan.create({
            data: {
              examId: template!.examId,
              examVersionId: template!.examVersionId,
              answersJson: JSON.stringify({ answers: res.answers ?? [] }),
              gradeJson: '{}',
              overridesJson: '{}',
              status: 'FAILED',
              overallConfidence: meanConfidence(res.answers ?? []),
              diagnosticsJson: JSON.stringify({
                error: res.error,
                engineStage: res.stage,
                batchId,
                pageIndex: pageIndexAbs,
              }),
              imageHash,
              batchId,
              pageIndex: pageIndexAbs,
            },
          });
          results.push({
            index: pageIndexAbs,
            scanId: failed.id,
            ok: false,
            stage: res.stage,
            error: res.error,
          });
          continue;
        }

        const answers: QBScannedAnswer[] = res.answers ?? [];
        const grade = gradeScan({
          document: versionDoc!,
          answerKey: versionKey,
          answers,
          overrides: {},
        });
        const studentCode = normalizeStudentCode(res.studentId?.digits);
        const student = studentCode
          ? await db.student.findUnique({ where: { code: studentCode } })
          : null;
        const overallConfidence = meanConfidence(answers);
        const needsReview =
          grade.ambiguous.length > 0 ||
          (studentCode !== null && !student) ||
          overallConfidence < 0.6;

        const scan = await db.scan.create({
          data: {
            examId: template!.examId,
            examVersionId: template!.examVersionId,
            studentCode,
            studentId: student?.id ?? null,
            answersJson: JSON.stringify({ answers, studentId: res.studentId ?? null }),
            gradeJson: JSON.stringify(grade),
            overridesJson: '{}',
            status: 'PROCESSED',
            overallConfidence,
            diagnosticsJson: '{}',
            imageHash,
            batchId,
            pageIndex: pageIndexAbs,
            reviewStatus: needsReview ? 'PENDING' : 'NONE',
          },
        });
        const debugPath = res.debugImage
          ? await saveScanImage(stripDataUrl(res.debugImage).base64, scan.id, 'debug')
          : null;
        const correctedPath = res.correctedImage
          ? await saveScanImage(stripDataUrl(res.correctedImage).base64, scan.id, 'corrected')
          : null;
        if (debugPath || correctedPath) {
          await db.scan.update({
            where: { id: scan.id },
            data: {
              diagnosticsJson: JSON.stringify({
                batchId,
                pageIndex: pageIndexAbs,
                ...(debugPath ? { debugImagePath: debugPath } : {}),
                ...(correctedPath ? { correctedImagePath: correctedPath } : {}),
              }),
            },
          });
        }

        results.push({
          index: pageIndexAbs,
          scanId: scan.id,
          ok: true,
          studentCode,
          studentName: student?.name ?? null,
          score: grade.score,
          maxScore: grade.maxScore,
          needsReview,
        });
      } catch (pageErr) {
        results.push({
          index: pageIndexAbs,
          scanId: null,
          ok: false,
          error: pageErr instanceof Error ? pageErr.message : 'خطأ غير متوقع في معالجة الصفحة',
        });
      }
    }

    const processedAny = results.some((r) => r.ok || r.scanId);
    if (processedAny) {
      await audit({
        session: g.session,
        action: 'scan.batch',
        entity: 'scan',
        entityId: batchId,
        meta: { fromPage, toPage: fromPage + pages.length - 1, total, resolvedVersionId },
        req,
      });
    }

    const transportAbort = results.some((r) => r.transportAbort);
    const nextFrom = pageChunk ? pageChunk.index + pages.length : fromPage + pages.length;
    return NextResponse.json({
      batchId,
      total,
      results,
      nextFrom,
      done: !transportAbort && nextFrom >= total,
      examVersionId: resolvedVersionId ?? hint ?? null,
      // `template` is assigned inside the resolveVersion closure; TS's
      // flow analysis narrows the outer binding to never here — the cast
      // documents the runtime reality (it IS an OMRTemplate or null).
      templateId: (template as OMRTemplate | null)?.templateId ?? null,
      ...(transportAbort
        ? { warning: 'انقطع الاتصال بمحرك المعالجة — أعد المحاولة للاستكمال من نفس الموضع' }
        : {}),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
