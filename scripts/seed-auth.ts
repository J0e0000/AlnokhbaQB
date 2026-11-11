// ============================================================
// ALNOKHBA QB — Auth & workspace seed (idempotent)
//   bun scripts/seed-auth.ts
// Creates: default organisation, super admin, demo users,
// taxonomy terms, and assigns legacy rows to the default org.
// ============================================================

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();

const DEFAULT_ORG = 'مدرسة النخبة النموذجية';

const USERS = [
  { email: 'admin@alnokhba.qb', name: 'مدير النظام', role: 'super_admin', password: 'Admin@2025', org: null as string | null },
  { email: 'principal@alnokhba.qb', name: 'مدير المدرسة', role: 'org_admin', password: 'Org@2025', org: DEFAULT_ORG },
  { email: 'teacher@alnokhba.qb', name: 'أستاذ أحمد', role: 'teacher', password: 'Teacher@2025', org: DEFAULT_ORG },
  { email: 'viewer@alnokhba.qb', name: 'مراقب التقارير', role: 'viewer', password: 'Viewer@2025', org: DEFAULT_ORG },
];

const TAXONOMY: Array<{ kind: string; name: string; parentKey?: string }> = [
  { kind: 'subject', name: 'الرياضيات' },
  { kind: 'subject', name: 'العلوم' },
  { kind: 'subject', name: 'اللغة العربية' },
  { kind: 'subject', name: 'اللغة الإنجليزية' },
  { kind: 'grade', name: 'الصف السادس الابتدائي' },
  { kind: 'grade', name: 'الصف الثالث الإعدادي' },
  { kind: 'grade', name: 'الصف الثاني الثانوي' },
  { kind: 'unit', name: 'الكسور والأعداد النسبية', parentKey: 'الرياضيات' },
  { kind: 'unit', name: 'الجبر والمعادلات', parentKey: 'الرياضيات' },
  { kind: 'unit', name: 'خلية الكائن الحي', parentKey: 'العلوم' },
  { kind: 'lesson', name: 'جمع وطرح الكسور', parentKey: 'الكسور والأعداد النسبية' },
  { kind: 'lesson', name: 'حل المعادلة الخطية', parentKey: 'الجبر والمعدلات' },
  { kind: 'lesson', name: 'الميتوكوندريا', parentKey: 'خلية الكائن الحي' },
];

async function main() {
  // ---- default organisation ----
  let org = await db.organization.findFirst({ where: { name: DEFAULT_ORG } });
  if (!org) org = await db.organization.create({ data: { name: DEFAULT_ORG } });
  console.log(`org: ${org.id} (${org.name})`);

  // ---- users ----
  for (const u of USERS) {
    const orgId = u.org ? (await db.organization.findFirst({ where: { name: u.org } }))?.id ?? null : null;
    const existing = await db.user.findUnique({ where: { email: u.email } });
    if (existing) {
      await db.user.update({
        where: { email: u.email },
        data: { role: u.role, organizationId: orgId ?? existing.organizationId, active: true },
      });
      console.log(`user exists: ${u.email} (${u.role})`);
    } else {
      await db.user.create({
        data: {
          email: u.email,
          name: u.name,
          role: u.role,
          organizationId: orgId,
          passwordHash: bcrypt.hashSync(u.password, 10),
        },
      });
      console.log(`user created: ${u.email} (${u.role}) password=${u.password}`);
    }
  }

  // ---- taxonomy ----
  for (const [i, t] of TAXONOMY.entries()) {
    const existing = await db.taxonomyTerm.findFirst({
      where: { organizationId: org.id, kind: t.kind, name: t.name },
    });
    if (!existing) {
      await db.taxonomyTerm.create({
        data: { organizationId: org.id, kind: t.kind, name: t.name, parentKey: t.parentKey ?? null, sortOrder: i },
      });
      console.log(`taxonomy + ${t.kind}: ${t.name}`);
    }
  }

  // ---- assign legacy rows (organizationId = null) to the default org ----
  const tables = ['exam', 'question', 'student', 'assignment'] as const;
  for (const t of tables) {
    const model = (db as unknown as Record<string, { updateMany: (a: unknown) => Promise<{ count: number }> }>)[t];
    const r = await model.updateMany({ where: { organizationId: null }, data: { organizationId: org.id } });
    if (r.count > 0) console.log(`${t}: assigned ${r.count} legacy rows to default org`);
  }

  // ---- demo bank questions (only if the bank is empty) ----
  const qCount = await db.question.count();
  if (qCount === 0) {
    const mk = (
      subject: string,
      prompt: string,
      options: Array<{ id: string; text: string }>,
      correct: string,
      difficulty: string,
      chapter: string | null = null
    ) => ({
      organizationId: org!.id,
      subject,
      chapter,
      topic: null,
      type: 'mcq',
      prompt,
      optionsJson: JSON.stringify(options),
      correctAnswer: correct,
      difficulty,
      marks: 1,
      tagsJson: JSON.stringify([]),
      source: 'seed',
      status: 'approved',
    });
    await db.question.createMany({
      data: [
        mk('الرياضيات', 'ما ناتج جمع ١/٢ + ١/٤ ؟', [
          { id: 'A', text: '٣/٤' },
          { id: 'B', text: '٢/٦' },
          { id: 'C', text: '١/٦' },
          { id: 'D', text: '٣/٦' },
        ], 'A', 'easy', 'الكسور والأعداد النسبية'),
        mk('الرياضيات', 'إذا كان ٢س + ٣ = ١١ فإن س يساوي:', [
          { id: 'A', text: '٣' },
          { id: 'B', text: '٤' },
          { id: 'C', text: '٥' },
          { id: 'D', text: '٧' },
        ], 'B', 'medium', 'الجبر والمعادلات'),
        mk('العلوم', 'أي العضيات مسؤول عن إنتاج الطاقة في الخلية؟', [
          { id: 'A', text: 'النواة' },
          { id: 'B', text: 'الميتوكوندريا' },
          { id: 'C', text: 'الرايبوسوم' },
          { id: 'D', text: 'الفجوة' },
        ], 'B', 'easy', 'خلية الكائن الحي'),
        mk('اللغة الإنجليزية', 'Choose the correct form: He ____ to school every day.', [
          { id: 'A', text: 'go' },
          { id: 'B', text: 'goes' },
          { id: 'C', text: 'going' },
          { id: 'D', text: 'gone' },
        ], 'B', 'easy', null),
      ],
    });
    console.log('demo bank questions created: 4');
  } else {
    console.log(`bank already has ${qCount} questions — skipped demo questions`);
  }

  console.log('SEED DONE');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
