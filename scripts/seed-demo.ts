/**
 * Demo exam seeder — APPENDS two demo exams (idempotent by title; existing
 * rows — including the golden exam — are never touched):
 *
 *  1. 'Midterm English Exam — Alnokhba'  LTR English, 8 questions, published v1, OMR on
 *  2. 'امتحان نصف السنة — علوم'          Arabic RTL multi-page (2 pages), 12 questions, published v1, OMR on
 *
 * Run: bun scripts/seed-demo.ts
 */
import { PrismaClient } from '@prisma/client';
import { starterDocument, sanitizeDocument } from '../src/lib/qb/schema';
import { buildOmrTemplate } from '../src/lib/qb/omr-template';
import type { QBDocument, QBQuestion, QBTextStyle } from '../src/lib/qb/types';

const db = new PrismaClient();

function q(
  id: string,
  number: number,
  prompt: string,
  options: [string, string][],
  marks = 1
): QBQuestion {
  return {
    id,
    number,
    type: 'mcq',
    prompt,
    options: options.map(([oid, text]) => ({ id: oid, text })),
    marks,
  };
}

function baseStyle(direction: 'rtl' | 'ltr', align: 'right' | 'left' | 'center'): QBTextStyle {
  return {
    fontFamily: 'Tajawal',
    fontSize: 11,
    bold: false,
    italic: false,
    underline: false,
    align,
    color: '#111827',
    lineHeight: 1.5,
    direction,
  };
}

async function publishDemoExam(params: {
  title: string;
  subject: string;
  direction: 'rtl' | 'ltr';
  build: (doc: QBDocument) => QBDocument;
  answerKey: Record<string, string>;
}): Promise<{ created: boolean; examId: string }> {
  const { title, subject, direction, build, answerKey } = params;

  const existing = await db.exam.findFirst({ where: { title } });
  if (existing) {
    console.log(`⏭️  '${title}' already exists (${existing.id}) — skipped (append-only)`);
    return { created: false, examId: existing.id };
  }

  let doc = build(starterDocument(title, direction === 'rtl' ? 'مدرسة النخبة' : 'Alnokhba School'));
  doc.direction = direction;
  doc = sanitizeDocument(doc);

  const exam = await db.exam.create({
    data: {
      title,
      subject,
      direction,
      status: 'DRAFT',
      documentJson: JSON.stringify(doc),
      answerKeyJson: JSON.stringify(answerKey),
      omrEnabled: true,
      currentVersion: 0,
    },
  });

  // immutable v1 snapshot (template needs the version id → save right after)
  const version = await db.examVersion.create({
    data: {
      examId: exam.id,
      version: 1,
      title,
      documentJson: JSON.stringify(doc),
      answerKeyJson: JSON.stringify(answerKey),
      omrTemplateJson: null,
    },
  });
  const omrTemplate = buildOmrTemplate({
    examId: exam.id,
    examVersionId: version.id,
    document: doc,
    versionNumber: 1,
  });
  await db.examVersion.update({
    where: { id: version.id },
    data: { omrTemplateJson: JSON.stringify(omrTemplate) },
  });
  await db.exam.update({
    where: { id: exam.id },
    data: { status: 'PUBLISHED', currentVersion: 1, omrEnabled: true },
  });

  console.log(`✅ '${title}' published: exam ${exam.id}, version ${version.id} (v1)`);
  return { created: true, examId: exam.id };
}

async function main() {
  // ---------- 1. English LTR midterm ----------
  await publishDemoExam({
    title: 'Midterm English Exam — Alnokhba',
    subject: 'General',
    direction: 'ltr',
    build: (doc) => {
      doc.branding.institution = 'Alnokhba School';
      doc.branding.examTitle = 'Midterm English Exam — Alnokhba';
      doc.branding.subtitle = 'Maths • Science • General Knowledge';
      doc.branding.academicYear = '2024 / 2025';
      doc.branding.duration = '60 minutes';
      doc.branding.borderStyle = 'single';
      doc.pageCount = 1;
      doc.omr = { ...doc.omr, enabled: true };

      const questions: QBQuestion[] = [
        q('e1', 1, 'Solve for x: 3x + 7 = 22. Which value of x makes the equation true?', [['A', '3'], ['B', '5'], ['C', '7'], ['D', '15']]),
        q('e2', 2, 'What is the boiling point of water at sea level, expressed in degrees Celsius?', [['A', '50°C'], ['B', '90°C'], ['C', '100°C'], ['D', '120°C']]),
        q('e3', 3, 'The largest planet in our solar system is:', [['A', 'Mars'], ['B', 'Jupiter'], ['C', 'Saturn'], ['D', 'Venus']]),
        q('e4', 4, 'Which gas do plants absorb from the atmosphere during photosynthesis?', [['A', 'Oxygen'], ['B', 'Nitrogen'], ['C', 'Carbon dioxide'], ['D', 'Hydrogen']]),
        q('e5', 5, 'A rectangle has a length of 12 cm and a width of 7 cm. What is its area, in square centimeters?', [['A', '19'], ['B', '84'], ['C', '38'], ['D', '72']]),
        q('e6', 6, 'Choose the correct past-tense form of the verb "to teach":', [['A', 'teached'], ['B', 'taught'], ['C', 'teaches'], ['D', 'teaching']]),
        q('e7', 7, 'The speed of light in vacuum is about 300,000 km/s. Which statement is correct?\nLight travels fastest in vacuum, and its speed does not depend on the source.', [['A', 'Light slows down in vacuum'], ['B', 'Light is fastest in vacuum'], ['C', 'Light cannot travel in vacuum'], ['D', 'Light speed changes with the source only']]),
        q('e8', 8, 'Which of the following is NOT a state of matter?', [['A', 'Solid'], ['B', 'Liquid'], ['C', 'Plasma'], ['D', 'Gravity']]),
      ];
      doc.questions = questions;

      doc.elements.push({
        id: 'en-header',
        type: 'header',
        page: 0,
        x: 15, y: 12, widthMm: 180, heightMm: 22, rotation: 0,
        style: { ...baseStyle('ltr', 'center'), fontSize: 16, bold: true, color: '#1e293b', lineHeight: 1.3 },
        content: { text: 'Midterm English Exam — Alnokhba', level: 1, showMeta: true },
      } as never);
      doc.elements.push({
        id: 'en-name',
        type: 'name-fields',
        page: 0,
        x: 15, y: 36, widthMm: 180, heightMm: 14, rotation: 0,
        style: baseStyle('ltr', 'left'),
        content: { fields: ['Student Name', 'Class'], showStudentId: true },
      } as never);

      let y = 52;
      for (const question of questions) {
        const long = question.prompt.length > 90;
        doc.elements.push({
          id: `en-${question.id}`,
          type: 'question',
          page: 0,
          x: 15, y, widthMm: 180, heightMm: long ? 24 : 18, rotation: 0,
          style: baseStyle('ltr', 'left'),
          content: {
            questionId: question.id,
            showNumber: true,
            optionLayout: question.number % 3 === 0 ? 'grid2' : 'inline',
            showOptionLetter: true,
            showMarks: question.number % 4 === 0,
          },
        } as never);
        y += long ? 26 : 21;
      }

      doc.elements.push({
        id: 'en-pagenum',
        type: 'page-number',
        page: 0,
        x: 70, y: 281, widthMm: 70, heightMm: 8, rotation: 0,
        style: { ...baseStyle('ltr', 'center'), fontSize: 9, color: '#64748b' },
        content: {},
      } as never);
      return doc;
    },
    answerKey: { e1: 'B', e2: 'C', e3: 'B', e4: 'C', e5: 'B', e6: 'B', e7: 'B', e8: 'D' },
  });

  // ---------- 2. Arabic RTL multi-page science exam ----------
  await publishDemoExam({
    title: 'امتحان نصف السنة — علوم',
    subject: 'علوم',
    direction: 'rtl',
    build: (doc) => {
      doc.branding.institution = 'مدرسة النخبة';
      doc.branding.examTitle = 'امتحان نصف السنة — علوم';
      doc.branding.subtitle = 'الفصل الدراسي الأول';
      doc.branding.academicYear = '١٤٤٦ هـ — ٢٠٢٤ / ٢٠٢٥ م';
      doc.branding.duration = 'ساعتان';
      doc.pageCount = 2;
      doc.omr = { ...doc.omr, enabled: true };

      const questions: QBQuestion[] = [
        q('s1', 1, 'ما هي الوحدة الأساسية لبناء الكائن الحي؟', [['A', 'الخلية'], ['B', 'النسيج'], ['C', 'العضو'], ['D', 'الجهاز']]),
        q('s2', 2, 'أي مما يلي يُعد مصدرًا متجددًا للطاقة؟', [['A', 'الفحم'], ['B', 'البترول'], ['C', 'طاقة الشمس'], ['D', 'الغاز الطبيعي']]),
        q('s3', 3, 'ما اسم الغاز الذي نتنفسه ويحتاجه الإنسان لبقاء الحياة؟', [['A', 'النيتروجين'], ['B', 'الأكسجين'], ['C', 'ثاني أكسيد الكربون'], ['D', 'الهيليوم']]),
        q('s4', 4, 'عملية البناء الضوئي في النبات تحدث داخل:', [['A', 'الميتوكوندريا'], ['B', 'البلاستيدات الخضراء'], ['C', 'النواة'], ['D', 'الرايبوسوم']]),
        q('s5', 5, 'ما ناتج التحليل الكهربائي للماء؟', [['A', 'هيدروجين وأكسجين'], ['B', 'نيتروجين'], ['C', 'ثاني أكسيد الكربون'], ['D', 'كلور']]),
        q('s6', 6, 'أي الحيوانات التالية يُصنف من الثدييات؟', [['A', 'الدلفين'], ['B', 'التمساح'], ['C', 'النسر'], ['D', 'السلحفاة']]),
        q('s7', 7, 'سرعة الضوء في الفراغ تساوي تقريبًا:\nوهي أقصى سرعة معروفة في الكون.', [['A', '٣٠٠ كم/ث'], ['B', '٣٠٠٠ كم/ث'], ['C', '٣٠٠٠٠٠ كم/ث'], ['D', '٣ ملايين كم/ث']]),
        q('s8', 8, 'أي مما يلي ليس من كواكب المجموعة الشمسية؟', [['A', 'عطارد'], ['B', 'نبتون'], ['C', 'القمر'], ['D', 'زحل']]),
        q('s9', 9, 'الوحدة المستخدمة لقياس شدة التيار الكهربائي هي:', [['A', 'الفولت'], ['B', 'الأمبير'], ['C', 'الأوم'], ['D', 'الواط']]),
        q('s10', 10, 'ما الجزء المسؤول عن صناعة البروتين داخل الخلية؟', [['A', 'النواة'], ['B', 'الرايبوسوم'], ['C', 'الفجوة'], ['D', 'الغشاء']]),
        q('s11', 11, 'عند تجمد الماء يتغير حجمه ليصبح:', [['A', 'أكبر من حجمه سائلًا'], ['B', 'أصغر من حجمه سائلًا'], ['C', 'مساويًا لحجمه سائلًا'], ['D', 'لا يمكن تحديد ذلك']]),
        q('s12', 12, 'أي المعادن التالية يكون سائلًا في درجة حرارة الغرفة؟', [['A', 'الحديد'], ['B', 'الزئبق'], ['C', 'الألومنيوم'], ['D', 'النحاس']]),
      ];
      doc.questions = questions;

      doc.elements.push({
        id: 'ar-header',
        type: 'header',
        page: 0,
        x: 15, y: 12, widthMm: 180, heightMm: 22, rotation: 0,
        style: { ...baseStyle('rtl', 'center'), fontSize: 16, bold: true, color: '#1e293b', lineHeight: 1.3 },
        content: { text: 'امتحان نصف السنة — علوم', level: 1, showMeta: true },
      } as never);
      doc.elements.push({
        id: 'ar-name',
        type: 'name-fields',
        page: 0,
        x: 15, y: 36, widthMm: 180, heightMm: 14, rotation: 0,
        style: baseStyle('rtl', 'right'),
        content: { fields: ['اسم الطالب', 'الفصل'], showStudentId: true },
      } as never);

      // page 0 → questions 1..6
      let y = 52;
      for (const question of questions.slice(0, 6)) {
        const long = question.prompt.length > 60;
        doc.elements.push({
          id: `ar-${question.id}`,
          type: 'question',
          page: 0,
          x: 15, y, widthMm: 180, heightMm: long ? 24 : 18, rotation: 0,
          style: baseStyle('rtl', 'right'),
          content: {
            questionId: question.id,
            showNumber: true,
            optionLayout: question.number % 3 === 0 ? 'grid2' : 'inline',
            showOptionLetter: true,
            showMarks: question.number % 4 === 0,
          },
        } as never);
        y += long ? 28 : 22;
      }

      // page 1 → continuation title + questions 7..12
      doc.elements.push({
        id: 'ar-cont-header',
        type: 'text',
        page: 1,
        x: 15, y: 14, widthMm: 180, heightMm: 12, rotation: 0,
        style: { ...baseStyle('rtl', 'center'), fontSize: 13, bold: true, color: '#334155' },
        content: { text: 'تكملة أسئلة امتحان العلوم — الصفحة الثانية' },
      } as never);
      let y1 = 32;
      for (const question of questions.slice(6)) {
        const long = question.prompt.length > 60;
        doc.elements.push({
          id: `ar-${question.id}`,
          type: 'question',
          page: 1,
          x: 15, y: y1, widthMm: 180, heightMm: long ? 24 : 18, rotation: 0,
          style: baseStyle('rtl', 'right'),
          content: {
            questionId: question.id,
            showNumber: true,
            optionLayout: question.number % 3 === 0 ? 'grid2' : 'inline',
            showOptionLetter: true,
            showMarks: question.number % 4 === 0,
          },
        } as never);
        y1 += long ? 30 : 24;
      }

      // page-number elements on BOTH pages
      doc.elements.push({
        id: 'ar-pagenum-0',
        type: 'page-number',
        page: 0,
        x: 70, y: 281, widthMm: 70, heightMm: 8, rotation: 0,
        style: { ...baseStyle('rtl', 'center'), fontSize: 9, color: '#64748b' },
        content: {},
      } as never);
      doc.elements.push({
        id: 'ar-pagenum-1',
        type: 'page-number',
        page: 1,
        x: 70, y: 281, widthMm: 70, heightMm: 8, rotation: 0,
        style: { ...baseStyle('rtl', 'center'), fontSize: 9, color: '#64748b' },
        content: {},
      } as never);
      return doc;
    },
    answerKey: {
      s1: 'A', s2: 'C', s3: 'B', s4: 'B', s5: 'A', s6: 'A',
      s7: 'C', s8: 'C', s9: 'B', s10: 'B', s11: 'A', s12: 'B',
    },
  });

  console.log('🌱 seed-demo done (append-only; golden exam untouched)');
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
