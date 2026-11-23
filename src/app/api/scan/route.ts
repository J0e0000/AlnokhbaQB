// POST /api/scan { imageBase64, examVersionIdHint?, manualMarkers?, debug? }
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
//   6. link Student by decoded student code
// Engine down → clean 503. Unknown QR → 404. Template mismatch → 409.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { clientIp, rateLimit } from '@/lib/auth/ratelimit';
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
  readJsonBody,
  serverError,
  stripDataUrl,
  thresholdsFromConfig,
} from '../_lib/shared';
import { resolveScanTables } from '../_lib/scan-tables';
import { loadVersion } from '../_lib/version';
import { handleFixedScan } from '../_lib/fixed-scan';
import {
  decodeImage,
  imagesPayload,
  meanConfidence,
  normalizeStudentCode,
} from '../_lib/scan-persist';

export const maxDuration = 60;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

export async function POST(req: Request) {
  // heavy OMR route — 30 req/min per client (auth gate)
  const rl = await rateLimit(`scan:${clientIp(req)}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'عدد كبير من الطلبات — خفّف السرعة وحاول بعد قليل' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  try {
    const body = await readJsonBody(req);
    const rawImage = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
    if (!rawImage) {
      return NextResponse.json({ error: 'صورة الورقة مطلوبة (imageBase64)' }, { status: 400 });
    }
    const { base64: imageBase64 } = stripDataUrl(rawImage);
    const hint = typeof body?.examVersionIdHint === 'string' ? body.examVersionIdHint : undefined;
    const manualMarkers = parseManualMarkers(body?.manualMarkers);
    const batchId = typeof body?.batchId === 'string' ? body.batchId.slice(0, 64) : null;
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.slice(0, 128) : null;

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
    // DB ids of the resolved version — the template JSON is a snapshot and its
    // examId may no longer exist (version re-published / moved between
    // environments); the row is the authoritative source for persistence.
    let resolvedExamId: string | null = null;
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

    if (manualMarkers && hint) {
      const loaded = await loadVersion(hint);
      if (!loaded || !loaded.omrTemplate) {
        return NextResponse.json(
          { error: 'لا توجد نسخة امتحان مطابقة', stage: 'noMatchingVersion' },
          { status: 404 }
        );
      }
      template = loaded.omrTemplate;
      versionDoc = loaded.document;
      versionKey = loaded.answerKey;
      resolvedExamId = loaded.row.examId;
      resolvedVersionId = loaded.row.id;
      const { answerKeyByNumber, marksMap } = buildEngineKey(versionDoc, versionKey);
      result = await processScan({
        imageBase64,
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
        imageBase64,
        template: null,
        thresholds,
        debug: true,
        manualMarkers,
      });
      engineCalls++;
    }

    if (isTransportError(result)) {
      return NextResponse.json(
        { error: result.error, stage: result.stage, details: result.details ?? null },
        { status: 503 }
      );
    }

    // Fixed reusable sheet: the QR names the exam/template only, so the whole
    // identity → version → grade flow lives in its own handler.
    if (result.ok && result.mode === 'fixed') {
      return handleFixedScan({
        imageBase64,
        first: result,
        thresholds,
        batchId,
        idempotencyKey,
      });
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
      const loaded = await loadVersion(qrVersionId);
      if (!loaded) {
        return NextResponse.json(
          { error: 'لا توجد نسخة امتحان مطابقة لرمز QR', stage: 'noMatchingVersion' },
          { status: 404 }
        );
      }
      template = loaded.omrTemplate;
      resolvedExamId = loaded.row.examId;
      resolvedVersionId = loaded.row.id;
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
          imageBase64,
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
            { error: second.error, stage: second.stage, details: second.details ?? null },
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
          examId: resolvedExamId,
          examVersionId: resolvedVersionId,
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
        ? decodeImage(stripDataUrl(result.debugImage).base64, scan.id, 'debug')
        : null;
      const correctedPath = result.correctedImage
        ? decodeImage(stripDataUrl(result.correctedImage).base64, scan.id, 'corrected')
        : null;
      const failedImages = imagesPayload(scan.id, debugPath, correctedPath);
      // keep what the engine saw: a rejected sheet is exactly the one a
      // teacher needs to look at before re-photographing it
      await db.scan
        .update({
          where: { id: scan.id },
          data: {
            diagnosticsJson: JSON.stringify({
              error: result.error,
              engineStage: result.stage,
              ...scanMeta,
              ...failedImages,
            }),
          },
        })
        .catch(() => undefined);
      return NextResponse.json(
        {
          scanId: scan.id,
          error: result.error || 'فشل محرك التعرف على الورقة',
          stage: result.stage,
          diagnostics: {
            ...(result.diagnostics ?? {}),
            ...failedImages,
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

    // ---- 3b. tables printed/ruled on the sheet (shown with the review)
    const tables = await resolveScanTables(result.tables);

    // ---- 4. SERVER-side grading (engine grade is advisory only)
    const answers: QBScannedAnswer[] = result.answers ?? [];
    const grade = gradeScan({
      document: versionDoc,
      answerKey: versionKey,
      answers,
      overrides: {},
    });

    // ---- 5. persist
    const studentCode = normalizeStudentCode(result.studentId?.digits);
    const student = studentCode
      ? await db.student.findUnique({ where: { code: studentCode } })
      : null;
    const overallConfidence = meanConfidence(answers);
    // Engine flags a detected sheet with zero readable marks: never store that
    // as a confident PROCESSED result — a teacher must eyeball it.
    const needsReview = result.needsReview === true;
    const scanStatus = needsReview ? 'REVIEW' : 'PROCESSED';

    const scan = await db.scan.create({
      data: {
        examId: resolvedExamId ?? template.examId,
        examVersionId: resolvedVersionId ?? template.examVersionId,
        studentCode,
        studentId: student?.id ?? null,
        answersJson: JSON.stringify({ answers, studentId: result.studentId ?? null }),
        gradeJson: JSON.stringify(grade),
        overridesJson: '{}',
        status: scanStatus,
        reviewStatus: needsReview ? 'PENDING' : 'NONE',
        overallConfidence,
        diagnosticsJson: '{}',
      },
    });

    const debugPath = result.debugImage
      ? decodeImage(stripDataUrl(result.debugImage).base64, scan.id, 'debug')
      : null;
    const correctedPath = result.correctedImage
      ? decodeImage(stripDataUrl(result.correctedImage).base64, scan.id, 'corrected')
      : null;

    const diagnostics = {
      ...(result.diagnostics ?? {}),
      ...scanMeta,
      ...imagesPayload(scan.id, debugPath, correctedPath),
      tables,
    };
    await db.scan.update({
      where: { id: scan.id },
      data: { diagnosticsJson: JSON.stringify(diagnostics) },
    });

    // ---- 6. response
    return NextResponse.json({
      scanId: scan.id,
      answers,
      grade,
      diagnostics,
      studentCode,
      studentId: student?.id ?? null,
      status: scanStatus,
      needsReview,
      overallConfidence,
      tables,
      template: {
        templateId: template.templateId,
        examVersionId: resolvedVersionId ?? template.examVersionId,
        version: template.versionNumber,
        sheets: template.sheets,
      },
    });
  } catch (err) {
    console.error('[scan] unhandled', err);
    return NextResponse.json(serverError(err), { status: 500 });
  }
}
