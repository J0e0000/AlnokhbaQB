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
  serverError,
  stripDataUrl,
  thresholdsFromConfig,
} from '../../_lib/shared';
import { requireSession } from '../../_lib/auth-guard';
import { loadVersion } from '../../_lib/version';
import { persistScanImage } from '@/lib/omr/scan-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_PAGES = 200;
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

export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    if (!rateLimit(`scanpdf:${g.session.id}`, 30, 60_000)) {
      return NextResponse.json(
        { error: 'عدد كبير من عمليات المعالجة — انتظر لحظة ثم أعد المحاولة' },
        { status: 429 }
      );
    }

    const body = await readJsonBody(req);
    const rawPdf = typeof body?.pdfBase64 === 'string' ? body.pdfBase64 : '';
    if (!rawPdf) {
      return NextResponse.json({ error: 'ملف PDF مطلوب (pdfBase64)' }, { status: 400 });
    }
    const { base64: pdfBase64 } = stripDataUrl(rawPdf);
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    if (pdfBytes.length > MAX_PDF_BYTES) {
      return NextResponse.json(
        { error: `حجم الملف كبير جدًا (الحد ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} ميجابايت)` },
        { status: 413 }
      );
    }
    // content sniff: real PDFs start with %PDF
    if (pdfBytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return NextResponse.json({ error: 'الملف ليس PDF صالحًا' }, { status: 415 });
    }

    const fromPage = Math.max(0, parseInt(String(body?.fromPage ?? '0'), 10) || 0);
    const batchSize = Math.max(
      1,
      Math.min(MAX_BATCH, parseInt(String(body?.batchSize ?? DEFAULT_BATCH), 10) || DEFAULT_BATCH)
    );
    // pageChunk mode: pdfBase64 is a single client-side slice
    const pageChunk =
      body?.pageChunk && typeof body.pageChunk === 'object'
        ? {
            index: Math.max(0, parseInt(String(body.pageChunk.index ?? '0'), 10) || 0),
            total: Math.max(1, parseInt(String(body.pageChunk.total ?? '0'), 10) || 0) || null,
          }
        : null;
    const hint = typeof body?.examVersionIdHint === 'string' ? body.examVersionIdHint : undefined;
    const batchId =
      typeof body?.batchId === 'string' && body.batchId.length <= 64
        ? body.batchId
        : randomUUID();

    // ---- calibration
    const profile = await ensureActiveCalibration();
    const thresholds = thresholdsFromConfig(profile.configJson);

    // ---- rasterize this chunk (pageChunk mode: the slice IS one page)
    const chunk = await pdfPages({
      pdfBase64,
      fromPage: pageChunk ? 0 : fromPage,
      maxPages: batchSize,
      dpi: 200,
    });
    if (!('pages' in chunk) || !Array.isArray((chunk as { pages?: unknown }).pages)) {
      const err = chunk as { error?: string; stage?: string };
      return NextResponse.json(
        { error: err.error ?? 'تعذر قراءة ملف PDF في محرك المعالجة', stage: err.stage },
        { status: 503 }
      );
    }
    const pages = chunk.pages;
    const total = pageChunk?.total ?? chunk.total;
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
      const loaded = await loadVersion(versionId);
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
      templateId: template?.templateId ?? null,
      ...(transportAbort
        ? { warning: 'انقطع الاتصال بمحرك المعالجة — أعد المحاولة للاستكمال من نفس الموضع' }
        : {}),
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
