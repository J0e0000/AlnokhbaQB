/**
 * Golden fixture generator — seeds the golden test exam, publishes it
 * (immutable ExamVersion + canonical OMR template) and renders REAL blank
 * OMR sheet PNGs at 300 DPI via Puppeteer for the Python engine harness.
 *
 * Run: bun scripts/gen-omr-fixtures.ts
 */
import { PrismaClient } from '@prisma/client';
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { starterDocument, sanitizeDocument } from '../src/lib/qb/schema';
import { buildOmrTemplate } from '../src/lib/qb/omr-template';
import { renderOmrHtml } from '../src/lib/qb/render-omr';
import type { QBDocument, QBQuestion } from '../src/lib/qb/types';

const ROOT = path.resolve((import.meta as unknown as { dir: string }).dir, '..');
const OUT = path.join(ROOT, 'tests', 'omr-fixtures');
const CHROME =
  process.env.CHROME_PATH ||
  `${process.env.HOME}/.cache/puppeteer/chrome-headless-shell/linux-153.0.8010.36/chrome-headless-shell-linux64/chrome-headless-shell`;

const db = new PrismaClient();

function q(id: string, number: number, prompt: string, options: string[][], correct: string, marks = 1): QBQuestion {
  return {
    id,
    number,
    type: 'mcq',
    prompt,
    options: options.map(([oid, text]) => ({ id: oid as string, text: text as string })),
    marks,
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // ---------- 1. Golden exam (Arabic RTL, mixed Arabic/English questions) ----------
  const questions: QBQuestion[] = [
    q('q1', 1, 'ما ناتج ٧ × ٨ ؟', [['A', '٥٤'], ['B', '٥٦'], ['C', '٤٨'], ['D', '٦٤']], 'B'),
    q('q2', 2, 'ما هو الكوكب الأحمر؟', [['A', 'الأرض'], ['B', 'الزهرة'], ['C', 'المريخ'], ['D', 'المشتري']], 'C'),
    q('q3', 3, 'What is the capital of Egypt?', [['A', 'Cairo'], ['B', 'Paris'], ['C', 'London'], ['D', 'Rome']], 'A'),
    q('q4', 4, 'أي مما يلي ليس من حالات الماء؟', [['A', 'صلب'], ['B', 'سائل'], ['C', 'غازي'], ['D', 'ضوئي']], 'D'),
    q('q5', 5, 'ما ناتج ١٢ ÷ ٤ ؟', [['A', '٢'], ['B', '٣'], ['C', '٤'], ['D', '٦']], 'B'),
    q('q6', 6, 'أطول نهر في العالم هو:', [['A', 'النيل'], ['B', 'الأمازون'], ['C', 'الفرات'], ['D', 'دجلة']], 'A'),
    q('q7', 7, 'What is 15 + 27?', [['A', '32'], ['B', '42'], ['C', '41'], ['D', '52']], 'B'),
    q('q8', 8, 'وحدة قياس القوة هي:', [['A', 'الجول'], ['B', 'النيوتن'], ['C', 'الواط'], ['D', 'الأمبير']], 'B'),
    q('q9', 9, 'عدد أضلاع المثلث:', [['A', '٢'], ['B', '٤'], ['C', '٣'], ['D', '٥']], 'C'),
    q('q10', 10, 'ما عاصمة المملكة العربية السعودية؟', [['A', 'جدة'], ['B', 'الرياض'], ['C', 'الدمام'], ['D', 'مكة']], 'B'),
  ];

  let doc: QBDocument = starterDocument('امتحان تجريبي شامل — النخبة', 'مدرسة النخبة التجريبية');
  doc.questions = questions;
  // Question elements flowed on page 0
  let y = 60;
  for (const question of questions) {
    doc.elements.push({
      id: `el-${question.id}`,
      type: 'question',
      page: 0,
      x: 15,
      y,
      widthMm: 180,
      heightMm: 20,
      rotation: 0,
      style: { fontFamily: 'Tajawal', fontSize: 12, bold: false, italic: false, underline: false, align: 'right', color: '#111827', lineHeight: 1.5 },
      content: { questionId: question.id, showNumber: true, optionLayout: 'inline', showOptionLetter: true, showMarks: false },
    } as never);
    y += 21.5;
  }
  doc.omr.enabled = true;
  doc = sanitizeDocument(doc) as unknown as QBDocument;

  const answerKey: Record<string, string> = {
    q1: 'B', q2: 'C', q3: 'A', q4: 'D', q5: 'B', q6: 'A', q7: 'B', q8: 'B', q9: 'C', q10: 'B',
  };

  // ---------- 2. Publish (snapshot) ----------
  const existing = await db.exam.findFirst({ where: { title: doc.branding.examTitle } });
  let exam = existing;
  if (!exam) {
    exam = await db.exam.create({
      data: {
        title: doc.branding.examTitle,
        subject: 'عام',
        direction: 'rtl',
        status: 'PUBLISHED',
        documentJson: JSON.stringify(doc),
        answerKeyJson: JSON.stringify(answerKey),
        omrEnabled: true,
        currentVersion: 1,
      },
    });
  } else {
    exam = await db.exam.update({
      where: { id: exam.id },
      data: {
        documentJson: JSON.stringify(doc),
        answerKeyJson: JSON.stringify(answerKey),
        omrEnabled: true,
        status: 'PUBLISHED',
      },
    });
  }

  let version = await db.examVersion.findFirst({
    where: { examId: exam.id, version: 1 },
  });
  const omrTemplate = buildOmrTemplate({
    examId: exam.id,
    examVersionId: version?.id ?? 'pending',
    document: doc,
    versionNumber: 1,
  });

  if (!version) {
    version = await db.examVersion.create({
      data: {
        examId: exam.id,
        version: 1,
        title: doc.branding.examTitle,
        documentJson: JSON.stringify(doc),
        answerKeyJson: JSON.stringify(answerKey),
        omrTemplateJson: JSON.stringify(omrTemplate),
      },
    });
    // templateId/examVersionId depend on the version id → regenerate with real id and re-save
    const finalTemplate = buildOmrTemplate({
      examId: exam.id,
      examVersionId: version.id,
      document: doc,
      versionNumber: 1,
    });
    await db.examVersion.update({
      where: { id: version.id },
      data: { omrTemplateJson: JSON.stringify(finalTemplate) },
    });
    await writeFixtures(finalTemplate, doc, answerKey, questions);
  } else {
    const finalTemplate = buildOmrTemplate({
      examId: exam.id,
      examVersionId: version.id,
      document: doc,
      versionNumber: 1,
    });
    await db.examVersion.update({
      where: { id: version.id },
      data: { omrTemplateJson: JSON.stringify(finalTemplate) },
    });
    await writeFixtures(finalTemplate, doc, answerKey, questions);
  }

  console.log('✅ Golden exam published:', exam.id, 'version:', version.id);
  await db.$disconnect();
}

async function writeFixtures(template: ReturnType<typeof buildOmrTemplate>, doc: QBDocument, answerKey: Record<string, string>, questions: QBQuestion[]) {
  // ---------- 3. Render blank sheet PNG @300dpi via Puppeteer ----------
  const html = renderOmrHtml(template);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 300 / 96 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 300));
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 794, height: 1123 } });
    writeFileSync(path.join(OUT, 'blank_sheet_0.png'), png as Buffer);
  } finally {
    await browser.close();
  }

  writeFileSync(path.join(OUT, 'template.json'), JSON.stringify(template, null, 2));
  writeFileSync(path.join(OUT, 'document.json'), JSON.stringify(doc, null, 2));
  writeFileSync(path.join(OUT, 'answer_key.json'), JSON.stringify(answerKey, null, 2));

  // Ground-truth answer key by question NUMBER (for harness)
  const keyByNumber: Record<number, string> = {};
  for (const question of questions) keyByNumber[question.number] = answerKey[question.id];
  writeFileSync(path.join(OUT, 'key_by_number.json'), JSON.stringify(keyByNumber, null, 2));

  console.log(`✅ fixtures written to ${OUT} (sheet: ${template.sheets} page(s), ${template.totalQuestions} questions)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
