// POST /api/scan { imageBase64 | pdfBase64+pageIndex, examVersionIdHint?,
//                   manualMarkers?, debug?, idempotencyKey? }
//            OR multipart/form-data (binary `image` file + scalar fields) —
//            the preferred transport: no base64 overhead, correct sizes.
// Full OMR scan pipeline:
//   1. load (or seed) the active CalibrationProfile → thresholds
//   2. engine /process WITHOUT template (engine QR-decodes the sheet)
//   3. resolve ExamVersion from QR/hint → verify templateId → re-run /process
//      WITH template + answerKey (max 2 engine calls, no loops)
//      • manualMarkers ([[x,y]×4 TL,TR,BR,BL px]) + hint → single call using
//        the user-clicked corner fallback (legacy nokhba-qb calibration port)
//   4. grade SERVER-SIDE via gradeScan (engine grade is advisory only)
//   5. persist Scan (answers, grade, confidence, diagnostics; debug/corrected
//      JPEGs go to db/scans/<scanId>_*.jpg — only PATHS are stored in DB)
//   6. link Student by decoded student code; uncertain identity/answers →
//      reviewStatus=PENDING (never auto-finalized)
//   7. idempotent retries: imageHash (+ optional client idempotencyKey) returns
//      the existing PROCESSED scan instead of creating a duplicate
// Engine down → clean 503. Unknown QR → 404. Template mismatch → 409.

import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { audit } from '@/lib/auth';
import { gradeScan } from '@/lib/qb/grading';
import {
  isTransportError,
  processScan,
  type ProcessScanResult,
} from '@/lib/omr/client';
import type {
  OMRTemplate,
  QBAnswerKey,
  QBDocument,
  QBScannedAnswer,
} from '@/lib/qb/types';
import {
  ensureActiveCalibration,
  imageSignature,
  rateLimit,
  readJsonBody,
  scanMaxImageBytes,
  serverError,
  stripDataUrl,
  thresholdsFromConfig,
} from '../_lib/shared';
import { persistScanImage } from '@/lib/omr/scan-store';
import { requireSession } from '../_lib/auth-guard';
import { loadVersion, loadVersionHint } from '../_lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Server-to-server OMR processing runs TWO engine calls (identity + full);
// each is CPU-bound OpenCV. 60s covers the slowest serverless CPU class.
export const maxDuration = 60;

/** Persist via disk + Vercel Blob (canonical on serverless) — see scan-store.ts. */
function decodeImage(base64: string, scanId: string, kind: 'debug' | 'corrected'): Promise<string | null> {
  return persistScanImage(scanId, kind, base64);
}

function normalizeStudentCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\s+/g, '');
  if (!digits || !/^\d{1,10}$/.test(digits)) return null; // empty / unclear / garbage
  return digits;
}

function meanConfidence(answers: QBScannedAnswer[]): number {
  if (!answers.length) return 0;
  const sum = answers.reduce((acc, a) => acc + (Number.isFinite(a.confidence) ? a.confidence : 0), 0);
  return Math.round((sum / answers.length) * 1000) / 1000;
}

/**
 * Validate the manual 4-corner fallback points ([[x,y] ×4, order TL,TR,BR,BL,
 * in ORIGINAL image pixels) — port of the legacy nokhba-qb corner-tap
 * calibration. Returns null when absent/invalid.
 */
function parseManualMarkers(raw: unknown): number[][] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const pts: number[][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x, y] = p as unknown[];
    if (
      typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 20000 ||
      typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 20000
    ) {
      return null;
    }
    pts.push([x, y]);
  }
  return pts;
}

function imagesPayload(scanId: string, debugPath: string | null, correctedPath: string | null) {
  return {
    debugImage: debugPath ? `/api/scans/${scanId}/images/debug` : null,
    correctedImage: correctedPath ? `/api/scans/${scanId}/images/corrected` : null,
  };
}

/** Parse stored diagnostics JSON defensively (never throw on legacy rows). */
function safeParseDiag(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Human-readable Arabic message for engine transport failures.
 *  The raw client error (English, e.g. "OMR engine unreachable — is the
 *  service running?") is kept in `details.rawError` for support. */
function transportArabic(stage: string, rawError: string): string {
  switch (stage) {
    case 'engineUnreachable':
      return 'محرك المسح الضوئي (OMR) غير متصل حاليًا. تتم إعادة تشغيله تلقائيًا — انتظر لحظات وحاول مسح الورقة مرة أخرى.';
    case 'timeout':
      return 'استغرق تحليل الورقة وقتًا أطول من المسموح — حاول مرة أخرى، وإن تكرر الأمر استخدم صورة أوضح أو أصغر حجمًا.';
    case 'engineHttpError':
      return 'واجه محرك المسح الضوئي خطأً داخليًا — حاول مرة أخرى.';
    case 'engineProtocol':
      return 'رد غير صالح من محرك المسح الضوئي — حاول مرة أخرى.';
    default:
      return rawError;
  }
}

interface ScanInput {
  /** raw base64 (no data: prefix) of the sheet image or single-page PDF */
  base64: string;
  isPdf: boolean;
  pageIndex: number | null;
  hint?: string;
  manualMarkers: number[][] | null;
  idempotencyKey: string | null;
}

/**
 * Accept the sheet from EITHER a multipart/form-data upload (binary `image`
 * file — preferred transport: ~33% smaller than base64 JSON and no JSON
 * escaping cost) or the legacy JSON body. Returns raw base64 + all fields.
 */
async function readScanInput(req: Request): Promise<
  { ok: true; input: ScanInput } | { ok: false; status: number; error: string }
> {
  const maxImageBytes = scanMaxImageBytes();
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return { ok: false, status: 400, error: 'تعذر قراءة البيانات المرفوعة (multipart)' };
    }
    const file = form.get('image');
    if (!(file instanceof File)) {
      return { ok: false, status: 400, error: 'صورة الورقة مطلوبة (الحقل image)' };
    }
    if (file.size > maxImageBytes) {
      return {
        ok: false,
        status: 413,
        error: `حجم الصورة كبير جدًا (الحد ${Math.round(maxImageBytes / 1024 / 1024)} ميجابايت)`,
      };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!imageSignature(bytes)) {
      return {
        ok: false,
        status: 415,
        error: 'الملف ليس صورة صالحة — استخدم JPEG أو PNG',
      };
    }
    const markersRaw = form.get('manualMarkers');
    let manualMarkers: number[][] | null = null;
    if (typeof markersRaw === 'string' && markersRaw.trim()) {
      try {
        manualMarkers = parseManualMarkers(JSON.parse(markersRaw));
      } catch {
        manualMarkers = null;
      }
    }
    const hintRaw = form.get('examVersionIdHint');
    const keyRaw = form.get('idempotencyKey');
    return {
      ok: true,
      input: {
        base64: Buffer.from(bytes).toString('base64'),
        isPdf: false,
        pageIndex: null,
        hint: typeof hintRaw === 'string' && hintRaw ? hintRaw : undefined,
        manualMarkers,
        idempotencyKey:
          typeof keyRaw === 'string' && keyRaw.length >= 8 && keyRaw.length <= 128
            ? keyRaw
            : null,
      },
    };
  }

  // legacy JSON body (base64 data-URL or bare base64)
  const body = await readJsonBody(req);
  const rawImage = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
  const rawPdf = typeof body?.pdfBase64 === 'string' ? body.pdfBase64 : '';
  if (!rawImage && !rawPdf) {
    return {
      ok: false,
      status: 400,
      error: 'صورة الورقة أو ملف PDF مطلوب (الحقل image أو imageBase64/pdfBase64)',
    };
  }
  const isPdf = !rawImage && !!rawPdf;
  const sourceB64 = isPdf ? rawPdf : rawImage;
  const { base64 } = stripDataUrl(sourceB64);
  if (!isPdf && base64.length / 4 * 3 > maxImageBytes) {
    return {
      ok: false,
      status: 413,
      error: `حجم الصورة كبير جدًا (الحد ${Math.round(maxImageBytes / 1024 / 1024)} ميجابايت)`,
    };
  }
  return {
    ok: true,
    input: {
      base64,
      isPdf,
      pageIndex: isPdf ? Math.max(0, Math.min(2000, Number(body?.pageIndex) || 0)) : null,
      hint: typeof body?.examVersionIdHint === 'string' ? body.examVersionIdHint : undefined,
      manualMarkers: parseManualMarkers(body?.manualMarkers),
      idempotencyKey:
        typeof body?.idempotencyKey === 'string' &&
        body.idempotencyKey.length >= 8 &&
        body.idempotencyKey.length <= 128
          ? body.idempotencyKey
          : null,
    },
  };
}

export async function POST(req: Request) {
  try {
    const g = await requireSession('teacher', req);
    if ('error' in g) return g.error;
    if (!rateLimit(`scan:${g.session.uid}`, 60, 60_000)) {
      return NextResponse.json(
        { error: 'عدد كبير من عمليات المسح — انتظر لحظة ثم أعد المحاولة' },
        { status: 429 }
      );
    }
    const input = await readScanInput(req);
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: input.status });
    }
    const sourceBase64 = input.input.base64;
    const imageHash = createHash('sha256').update(sourceBase64).digest('hex');
    const isPdf = input.input.isPdf;
    const pageIndex = input.input.pageIndex;
    const idempotencyKey = input.input.idempotencyKey;
    // idempotent retry: same bytes already finalized → return that scan
    if (idempotencyKey) {
      const existing = await db.scan.findUnique({ where: { idempotencyKey } });
      if (existing && (existing.status === 'PROCESSED' || existing.status === 'REVIEWED')) {
        return NextResponse.json({
          scanId: existing.id,
          duplicate: true,
          status: existing.status,
          reviewStatus: existing.reviewStatus,
          grade: JSON.parse(existing.gradeJson || '{}'),
          answers: (JSON.parse(existing.answersJson || '{"answers":[]}').answers ?? []) as QBScannedAnswer[],
          overallConfidence: existing.overallConfidence ?? 0,
          diagnostics: safeParseDiag(existing.diagnosticsJson),
          studentCode: existing.studentCode,
          studentId: existing.studentId,
        });
      }
    }
    const hint = input.input.hint;
    const manualMarkers = input.input.manualMarkers;

    // ---- 1. calibration thresholds (seeds the default profile on first call)
    const profile = await ensureActiveCalibration();
    const thresholds = thresholdsFromConfig(profile.configJson);

    // ---- 2. first engine call
    // Manual-corner mode with an explicit version skips the QR identity call:
    // the user's clicked corners + the selected version are the full contract
    // (this is the legacy fallback for photos the auto-detector cannot read).
    let engineCalls = 0;
    let result: ProcessScanResult;
    let versionDoc: QBDocument | null = null;
    let versionKey: QBAnswerKey = {};
    let template: OMRTemplate | null = null;

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

    if (manualMarkers && hint) {
      // hint may be an ExamVersion id (new clients) or an Exam id (legacy picker)
      const loaded = await loadVersionHint(hint);
      if (!loaded || !loaded.omrTemplate) {
        return NextResponse.json(
          { error: 'لا توجد نسخة امتحان مطابقة', stage: 'noMatchingVersion' },
          { status: 404 }
        );
      }
      if (
        g.session.role !== 'super_admin' &&
        loaded.row.exam.organizationId !== g.session.orgId
      ) {
        return NextResponse.json(
          { error: 'لا توجد نسخة امتحان مطابقة', stage: 'noMatchingVersion' },
          { status: 404 }
        );
      }
      template = loaded.omrTemplate;
      versionDoc = loaded.document;
      versionKey = loaded.answerKey;
      const { answerKeyByNumber, marksMap } = buildEngineKey(versionDoc, versionKey);
      result = await processScan({
        imageBase64: isPdf ? undefined : sourceBase64,
        pdfBase64: isPdf ? sourceBase64 : undefined,
        pageIndex: pageIndex ?? undefined,
        template,
        answerKey: answerKeyByNumber,
        marksMap,
        thresholds,
        debug: true,
        manualMarkers,
      });
      engineCalls++;
    } else {
      result = await processScan({
        imageBase64: isPdf ? undefined : sourceBase64,
        pdfBase64: isPdf ? sourceBase64 : undefined,
        pageIndex: pageIndex ?? undefined,
        template: null,
        thresholds,
        debug: true,
        manualMarkers,
      });
      engineCalls++;
    }

    if (isTransportError(result)) {
      return NextResponse.json(
        {
          error: transportArabic(result.stage, result.error),
          stage: result.stage,
          details: result.details ?? null,
          rawError: result.error,
        },
        { status: 503 }
      );
    }

    // ---- 3. resolve version + template, then the (final) second engine call
    const needsTemplate =
      (result.ok && (result.needsTemplate === true || !!result.qr)) ||
      (!result.ok && !result.answers?.length && !!hint);

    if (needsTemplate || (hint && !template)) {
      const qrVersionId =
        hint || (result.ok ? result.qr?.examVersionId : undefined) || undefined;
      const qrTemplateId = result.ok ? result.qr?.templateId : undefined;

      if (!qrVersionId) {
        return NextResponse.json(
          { error: 'لا توجد نسخة امتحان مطابقة لرمز QR', stage: 'noMatchingVersion' },
          { status: 404 }
        );
      }
      // A client-supplied hint may be an EXAM id (legacy picker) → tolerant
      // resolution; a QR-decoded id is always an ExamVersion id → strict load.
      const loaded = hint ? await loadVersionHint(qrVersionId) : await loadVersion(qrVersionId);
      if (!loaded) {
        return NextResponse.json(
          { error: 'لا توجد نسخة امتحان مطابقة لرمز QR', stage: 'noMatchingVersion' },
          { status: 404 }
        );
      }
      if (
        g.session.role !== 'super_admin' &&
        loaded.row.exam.organizationId !== g.session.orgId
      ) {
        // another organisation's version → behave exactly like an unknown QR
        return NextResponse.json(
          { error: 'لا توجد نسخة امتحان مطابقة لرمز QR', stage: 'noMatchingVersion' },
          { status: 404 }
        );
      }
      template = loaded.omrTemplate;
      if (template && qrTemplateId && template.templateId !== qrTemplateId) {
        return NextResponse.json(
          {
            error: 'الورقة لا تطابق نسخة الامتحان (template mismatch)',
            stage: 'templateMismatch',
            expected: template.templateId,
            got: qrTemplateId,
          },
          { status: 409 }
        );
      }
      versionDoc = loaded.document;
      versionKey = loaded.answerKey;

      // build engine-side key/ marks keyed by question NUMBER
      const { answerKeyByNumber, marksMap } = buildEngineKey(versionDoc, versionKey);

      if (engineCalls < 2) {
        const second = await processScan({
          imageBase64: isPdf ? undefined : sourceBase64,
          pdfBase64: isPdf ? sourceBase64 : undefined,
          pageIndex: pageIndex ?? undefined,
          template,
          answerKey: answerKeyByNumber,
          marksMap,
          thresholds,
          debug: true,
          manualMarkers,
        });
        engineCalls++;
        if (isTransportError(second)) {
          return NextResponse.json(
            {
              error: transportArabic(second.stage, second.error),
              stage: second.stage,
              details: second.details ?? null,
              rawError: second.error,
            },
            { status: 503 }
          );
        }
        result = second;
      }
    }

    const scanMeta = {
      engineCalls,
      thresholds,
      templateId: template?.templateId ?? null,
    };

    // ---- engine-level failure → persist FAILED + surface diagnostics
    if (!result.ok) {
      const scan = await db.scan.create({
        data: {
          examId: template?.examId ?? null,
          examVersionId: template?.examVersionId ?? null,
          answersJson: JSON.stringify({ answers: result.answers ?? [] }),
          gradeJson: '{}',
          overridesJson: '{}',
          status: 'FAILED',
          overallConfidence: meanConfidence(result.answers ?? []),
          diagnosticsJson: JSON.stringify({
            error: result.error,
            engineStage: result.stage,
            ...scanMeta,
          }),
        },
      });
      const debugPath = result.debugImage
        ? await decodeImage(stripDataUrl(result.debugImage).base64, scan.id, 'debug')
        : null;
      const correctedPath = result.correctedImage
        ? await decodeImage(stripDataUrl(result.correctedImage).base64, scan.id, 'corrected')
        : null;
      return NextResponse.json(
        {
          scanId: scan.id,
          error: result.error || 'فشل محرك التعرف على الورقة',
          stage: result.stage,
          diagnostics: {
            ...(result.diagnostics ?? {}),
            ...imagesPayload(scan.id, debugPath, correctedPath),
          },
          status: 'FAILED',
        },
        { status: 409 }
      );
    }

    // ---- success, but still no version context → cannot grade
    if (!versionDoc || !template) {
      return NextResponse.json(
        {
          error: 'لا توجد نسخة امتحان مطابقة لرمز QR',
          stage: 'noMatchingVersion',
          diagnostics: result.diagnostics ?? null,
        },
        { status: 404 }
      );
    }

    // ---- 4. SERVER-side grading (engine grade is advisory only)
    const answers: QBScannedAnswer[] = result.answers ?? [];
    const grade = gradeScan({
      document: versionDoc,
      answerKey: versionKey,
      answers,
      overrides: {},
    });

    // ---- 5. persist (idempotent on identical bytes)
    const studentCode = normalizeStudentCode(result.studentId?.digits);
    const student = studentCode
      ? await db.student.findUnique({ where: { code: studentCode } })
      : null;
    const overallConfidence = meanConfidence(answers);

    // Identity/answer uncertainty routes to manual review — never silently
    // finalized: unknown student code, ambiguous answers, low confidence.
    const ambiguousCount = grade.ambiguous.length;
    const needsReview =
      ambiguousCount > 0 ||
      (studentCode !== null && !student) ||
      overallConfidence < 0.6;
    const reviewStatus = needsReview ? 'PENDING' : 'NONE';

    if (!idempotencyKey) {
      const dup = await db.scan.findFirst({
        where: {
          imageHash,
          examVersionId: template.examVersionId,
          status: { in: ['PROCESSED', 'REVIEWED'] },
        },
        select: { id: true },
      });
      if (dup) {
        const dupRow = await db.scan.findUnique({ where: { id: dup.id } });
        return NextResponse.json({
          scanId: dup.id,
          duplicate: true,
          status: 'PROCESSED',
          reviewStatus: dupRow?.reviewStatus ?? null,
          grade: JSON.parse(dupRow?.gradeJson || '{}'),
          answers: (JSON.parse(dupRow?.answersJson || '{"answers":[]}').answers ?? []) as QBScannedAnswer[],
          overallConfidence: dupRow?.overallConfidence ?? 0,
          diagnostics: safeParseDiag(dupRow?.diagnosticsJson),
          studentCode,
          studentId: student?.id ?? null,
        });
      }
    }

    const scan = await db.scan.create({
      data: {
        examId: template.examId,
        examVersionId: template.examVersionId,
        studentCode,
        studentId: student?.id ?? null,
        answersJson: JSON.stringify({ answers, studentId: result.studentId ?? null }),
        gradeJson: JSON.stringify(grade),
        overridesJson: '{}',
        status: 'PROCESSED',
        overallConfidence,
        diagnosticsJson: '{}',
        imageHash,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        reviewStatus,
      },
    });

    const debugPath = result.debugImage
      ? await decodeImage(stripDataUrl(result.debugImage).base64, scan.id, 'debug')
      : null;
    const correctedPath = result.correctedImage
      ? await decodeImage(stripDataUrl(result.correctedImage).base64, scan.id, 'corrected')
      : null;

    const diagnostics = {
      ...(result.diagnostics ?? {}),
      ...scanMeta,
      ...imagesPayload(scan.id, debugPath, correctedPath),
    };
    await db.scan.update({
      where: { id: scan.id },
      data: { diagnosticsJson: JSON.stringify(diagnostics) },
    });

    await audit({
      session: g.session,
      action: 'scan.process',
      entity: 'scan',
      entityId: scan.id,
      meta: { examVersionId: template.examVersionId },
      req,
    });

    // ---- 6. response
    return NextResponse.json({
      scanId: scan.id,
      duplicate: false,
      answers,
      grade,
      diagnostics,
      studentCode,
      studentId: student?.id ?? null,
      studentName: student?.name ?? null,
      needsReview,
      reviewStatus,
      status: 'PROCESSED',
      overallConfidence,
      template: {
        templateId: template.templateId,
        examVersionId: template.examVersionId,
        version: template.versionNumber,
        sheets: template.sheets,
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
