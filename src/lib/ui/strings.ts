// ============================================================
// النخبة QB — UI glossary (single source for repeated labels).
// Arabic is the default and the fallback; every string carries
// an `en` key so English can be enabled later without re-sweeping
// the components. Keep terminology consistent:
//   امتحان = the exam  ·  نموذج = exam version  ·  ورقة OMR = answer sheet
// ============================================================

export type Strings = Record<string, { ar: string; en: string }>;

export const strings: Strings = {
  appName: { ar: 'النخبة', en: 'Alnokhba' },
  appFullName: { ar: 'النخبة QB', en: 'Alnokhba QB' },

  // Groups
  groupExams: { ar: 'الامتحانات', en: 'Exams' },
  groupGrading: { ar: 'التصحيح', en: 'Grading' },
  groupStudents: { ar: 'الطلاب', en: 'Students' },
  groupSettings: { ar: 'الإعدادات', en: 'Settings' },

  // Nav
  navExams: { ar: 'امتحاناتي', en: 'My exams' },
  navBank: { ar: 'بنك الأسئلة', en: 'Question bank' },
  navImport: { ar: 'استيراد من ملف', en: 'Import from file' },
  navScan: { ar: 'مسح وتصحيح', en: 'Scan & grade' },
  navPipeline: { ar: 'معالج OMR', en: 'OMR wizard' },
  navReview: { ar: 'قائمة المراجعة', en: 'Review queue' },
  navCheating: { ar: 'كشف الغش', en: 'Cheating detection' },
  navStudents: { ar: 'الطلاب', en: 'Students' },
  navAssignments: { ar: 'الواجبات', en: 'Assignments' },
  navOnline: { ar: 'أونلاين', en: 'Online' },
  navSettings: { ar: 'الإعدادات', en: 'Settings' },
  navMore: { ar: 'المزيد', en: 'More' },

  // Exam stages (the only numbered sequence in the product)
  stageDesign: { ar: 'التصميم', en: 'Design' },
  stagePreview: { ar: 'المعاينة', en: 'Preview' },
  stageOmr: { ar: 'أوراق OMR', en: 'OMR sheets' },

  // Common verbs — the same verb leads the flow
  save: { ar: 'احفظ التعديلات', en: 'Save changes' },
  saved: { ar: 'تم الحفظ', en: 'Saved' },
  saving: { ar: 'جارٍ الحفظ…', en: 'Saving…' },
  publish: { ar: 'انشر', en: 'Publish' },
  published: { ar: 'تم النشر', en: 'Published' },
  archive: { ar: 'أرشِف', en: 'Archive' },
  archived: { ar: 'تمت الأرشفة', en: 'Archived' },
  download: { ar: 'تنزيل', en: 'Download' },
  createExam: { ar: 'امتحان جديد', en: 'New exam' },

  // Status vocabulary
  statusDraft: { ar: 'مسودة', en: 'Draft' },
  statusPublished: { ar: 'منشور', en: 'Published' },
  statusArchived: { ar: 'مؤرشف', en: 'Archived' },

  // System status
  systemStatus: { ar: 'حالة النظام', en: 'System status' },
  sysDb: { ar: 'قاعدة البيانات', en: 'Database' },
  sysPdf: { ar: 'محرك PDF', en: 'PDF engine' },
  sysOmr: { ar: 'محرك التصحيح', en: 'Grading engine' },
  connected: { ar: 'متصل', en: 'Connected' },
  disconnected: { ar: 'غير متصل', en: 'Disconnected' },
  fixDb: { ar: 'أعد تشغيل الخادم — تعذر الوصول إلى قاعدة البيانات', en: 'Restart the server — the database is unreachable' },
  fixPdf: { ar: 'جرّب تنزيل أي PDF — المحرك يعمل تلقائيًا عند أول طلب', en: 'Try downloading any PDF — the engine starts on the first request' },
  fixOmr: { ar: 'شغّل خدمة قراءة الأوراق (محرك OMR) ثم أعد المحاولة', en: 'Start the sheet-reading (OMR) service, then retry' },

  // Login
  loginTitle: { ar: 'تسجيل الدخول', en: 'Sign in' },
  loginPassword: { ar: 'كلمة المرور', en: 'Password' },
  loginSubmit: { ar: 'دخول', en: 'Sign in' },
  loginError: { ar: 'كلمة المرور غير صحيحة — أعد المحاولة', en: 'Wrong password — try again' },

  // Empty states
  examsEmpty: { ar: 'لا توجد امتحانات بعد — ابدأ بإنشاء أول امتحان، ثم صمّم أسئلته واطبع أورقه.', en: 'No exams yet — create your first exam, design its questions, then print its sheets.' },
} as const;

export function t(key: keyof Strings & string): string {
  return strings[key]?.ar ?? key;
}
