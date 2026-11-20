'use client';

// ============================================================
// ALNOKHBA QB — OMR Pipeline Wizard ("معالج OMR")
// One guided pipeline instead of hopping between 4 separate views:
//   1. Exam      — pick an existing exam or create one in place
//   2. Answer key — enable OMR + mark the guide answer per MCQ
//   3. Publish   — freeze key/version, download & print bubble sheets
//   4. Scan      — drop photos / scanner PDFs, per-page progress+retry
//   5. Results   — accuracy stats, review queue, CSV export
// Every step carries an inline tip, and a 7-slide interactive
// tutorial (auto-opens on first visit, replayable) teaches the flow.
// Golden path only: the advanced OmrStudio / ScanStudio remain for
// camera scanning, manual corners and partial keys.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { EmptyState, PaneHeader, StatCard } from '@/components/qb/pane-kit';
import { keyFingerprint } from '@/lib/qb/key-fingerprint';
import type { QBQuestion } from '@/lib/qb/types';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Camera,
  CheckCircle2,
  ClipboardList,
  Copy,
  Eraser,
  FileDown,
  FileSpreadsheet,
  KeyRound,
  Lightbulb,
  Loader2,
  Lock,
  Plus,
  Printer,
  RefreshCcw,
  ScanLine,
  Sparkles,
  Upload,
  Workflow,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ---------------- types ----------------

interface ExamRow {
  id: string;
  title: string;
  subject: string | null;
  status: string;
  questionCount: number;
  omrEnabled: boolean;
  currentVersion: number;
  updatedAt: string;
}

interface VersionRow {
  id: string;
  version: number;
  publishedAt: string;
  omrTemplate?: boolean;
  answerKeyCount?: number;
  answerKeyHash?: string;
}

interface ExamDetail {
  exam: ExamRow & { documentJson: string; answerKeyJson: string };
  document: {
    questions: QBQuestion[];
    branding: { examTitle: string; institution: string };
    omr: { enabled: boolean; optionsPerQuestion: number; studentIdDigits: number };
  };
  answerKey: Record<string, string>;
  versions: VersionRow[];
}

interface ScanRow {
  id: string;
  createdAt: string;
  studentCode: string | null;
  status: string;
  reviewStatus: string;
  ambiguousCount: number;
  overallConfidence: number;
  score: number | null;
  maxScore: number | null;
  percent: number | null;
  needsReview: boolean;
}

type StepKey = 'exam' | 'key' | 'print' | 'scan' | 'results';

const STEP_ORDER: StepKey[] = ['exam', 'key', 'print', 'scan', 'results'];

const STEPS: { key: StepKey; ar: string; en: string; icon: LucideIcon }[] = [
  { key: 'exam', ar: 'الاختبار', en: 'Exam', icon: BookOpen },
  { key: 'key', ar: 'مفتاح التصحيح', en: 'Answer key', icon: KeyRound },
  { key: 'print', ar: 'النشر والطباعة', en: 'Publish & print', icon: Printer },
  { key: 'scan', ar: 'المسح', en: 'Scan', icon: ScanLine },
  { key: 'results', ar: 'النتائج', en: 'Results', icon: ClipboardList },
];

// Vercel caps serverless bodies at 4.5MB — whole-file PDFs beyond ~4MB are
// sliced per page with pdf-lib (same thresholds as the full ScanStudio).
const PDF_WHOLE_LIMIT_BYTES = 4_000_000;
const PDF_PAGE_LIMIT_BYTES = 4_200_000;

const TRANSIENT_STATUS = new Set([502, 503, 504]);

async function fetchFileWithRetry(url: string): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
    try {
      const res = await fetch(url);
      if (res.ok || !TRANSIENT_STATUS.has(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('network');
}

async function downloadFile(url: string, name: string, successMsg = 'تم التنزيل ✓'): Promise<void> {
  let res: Response;
  try {
    res = await fetchFileWithRetry(url);
  } catch {
    toast.error('تعذر الاتصال بالخادم — تأكد من تشغيله ثم أعد المحاولة');
    return;
  }
  if (!res.ok) {
    let msg = `فشل التوليد (HTTP ${res.status})`;
    try {
      const data = (await res.json()) as { error?: string; details?: string };
      if (data?.error) msg = data.details ? `${data.error} — ${data.details}` : data.error;
    } catch {
      /* non-JSON body → default message */
    }
    toast.error(msg);
    return;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast.success(successMsg);
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return await res.blob();
}

/** Client-side downscale before upload (phones ship 3-10MB frames; the
 *  engine analyses at ~300 DPI anyway — past 2400px it is pure latency). */
async function downscaleImage(dataUrl: string, maxEdge = 2400, quality = 0.9): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const long = Math.max(w, h);
      if (!w || !h || long <= maxEdge) {
        resolve(dataUrl);
        return;
      }
      const scale = maxEdge / long;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ---------------- tutorial content ----------------

interface TutorialSlide {
  icon: LucideIcon;
  ar: { title: string; lines: string[] };
  en: { title: string; lines: string[] };
}

const TUTORIAL_SLIDES: TutorialSlide[] = [
  {
    icon: Workflow,
    ar: {
      title: 'معالج OMR — التصحيح الآلي في 5 خطوات',
      lines: [
        'هذا المعالج يأخذك من الامتحان إلى الدرجات النهائية في مسار واحد واضح:',
        '١) اختر أو أنشئ الامتحان ← ٢) حدّد مفتاح التصحيح ← ٣) انشر واطبع أوراق الفقاعات ← ٤) امسح الأوراق الممتلئة ← ٥) شاهد النتائج والدقة.',
        'كل ورقة تحمل رمز QR يربطها تلقائيًا بنسخة الامتحان — لا حاجة لاختيار يدوي وقت المسح.',
      ],
    },
    en: {
      title: 'OMR Wizard — automatic grading in 5 steps',
      lines: [
        'This wizard takes you from exam to final grades in one clear path:',
        '1) Pick or create an exam → 2) Set the answer key → 3) Publish & print bubble sheets → 4) Scan the filled sheets → 5) See results & accuracy.',
        'Every sheet carries a QR code linking it to the exam version automatically — no manual picking at scan time.',
      ],
    },
  },
  {
    icon: BookOpen,
    ar: {
      title: 'الخطوة ١ — الاختبار',
      lines: [
        'اختر امتحانًا موجودًا من القائمة، أو أنشئ امتحانًا جديدًا من نفس الشاشة.',
        'يجب أن يحتوي الامتحان على أسئلة اختيار من متعدد (MCQ) — هي فقط التي تظهر كفقاعات في ورقة الإجابة.',
        'إذا كان الامتحان فارغًا استخدم زر «فتح المصمم» لإضافة الأسئلة ثم عد إلى المعالج.',
      ],
    },
    en: {
      title: 'Step 1 — Exam',
      lines: [
        'Select an existing exam from the list, or create a new one right here.',
        'The exam must contain MCQ questions — only MCQs become bubbles on the answer sheet.',
        'If the exam is empty, use "Open Designer" to add questions, then come back to the wizard.',
      ],
    },
  },
  {
    icon: KeyRound,
    ar: {
      title: 'الخطوة ٢ — مفتاح التصحيح',
      lines: [
        'فعّل خيار التصحيح الآلي (OMR) ثم اختر الإجابة الصحيحة لكل سؤال بالضغط على دوائر الأحرف.',
        'المفتاح يُجمَّد عند النشر — أي تعديل بعدها يتطلب «إعادة نشر» تنشئ نسخة جديدة.',
        'الأوراق المطبوعة من نسخة قديمة تُصحح دائمًا بمفتاح نسختها — لا تقلق من إعادة النشر.',
      ],
    },
    en: {
      title: 'Step 2 — Answer key',
      lines: [
        'Enable OMR grading, then tap the letter circles to mark the correct answer for every question.',
        'The key is frozen at publish time — any later edit requires a "re-publish" that creates a new version.',
        'Sheets printed from an older version are always graded with that version\'s key — re-publishing is safe.',
      ],
    },
  },
  {
    icon: Printer,
    ar: {
      title: 'الخطوة ٣ — النشر والطباعة',
      lines: [
        'اضغط «نشر» لتجميد المفتاح وتوليد قالب الإحداثيات، ثم نزّل ملف PDF واطبع عدد النسخ الذي تحتاجه.',
        'قواعد الطباعة المهمة: حجم A4 بمقياس ١٠٠٪ (الحجم الفعلي) — لا تختر «ملاءمة الصفحة» أو تصغيرًا.',
        'الطباعة بالأبيض والأسود تكفي تمامًا، ولا تستخدم وضع توفير الحبر — العلامات الأربع في الأركان ورمز QR يجب أن تكون حادة وواضحة.',
      ],
    },
    en: {
      title: 'Step 3 — Publish & print',
      lines: [
        'Press "Publish" to freeze the key and generate the coordinate template, then download the PDF and print your copies.',
        'Golden printing rules: A4 at 100% scale (actual size) — never "fit to page" or shrink.',
        'Black & white is perfectly fine; avoid ink-saver modes — the 4 corner markers and the QR must be sharp and dark.',
      ],
    },
  },
  {
    icon: ScanLine,
    ar: {
      title: 'الخطوة ٤ — المسح',
      lines: [
        'اسحب وأفلت صور الجوال أو ملفات الماسح الضوئي (PDF متعدد الصفحات مدعوم) وسيقرأ النظام كل ورقة تلقائيًا.',
        'صوّر الورقة كاملة على سطح مستوٍ وبإضاءة جيدة — الأركان الأربعة ورمز QR يجب أن تظهر في الصورة.',
        'الورقة المكررة تُتجاهل تلقائيًا، والصفحة الفاشلة يمكن إعادة محاولتها بضغطة زر.',
      ],
    },
    en: {
      title: 'Step 4 — Scan',
      lines: [
        'Drag & drop phone photos or scanner files (multi-page PDF supported) — every sheet is read automatically.',
        'Capture the full sheet on a flat surface with good lighting — all 4 corner markers and the QR must be visible.',
        'Duplicate sheets are ignored automatically, and any failed page can be retried with one click.',
      ],
    },
  },
  {
    icon: ClipboardList,
    ar: {
      title: 'الخطوة ٥ — النتائج والدقة',
      lines: [
        'بعد المسح مباشرة: الدرجات، المتوسط، ونسبة الدقة تظهر في صفحة النتائج.',
        'الأوراق غير الواضحة أو إجاباتها الملتبسة تذهب إلى «قائمة المراجعة» لتقررها بنفسك قبل الاعتماد.',
        'صدّر النتائج كملف CSV لرفعها إلى نظام الدرجات لديك.',
      ],
    },
    en: {
      title: 'Step 5 — Results & accuracy',
      lines: [
        'Right after scanning: scores, average and accuracy appear on the results page.',
        'Sheets with ambiguous or low-confidence answers go to the "Review Queue" for you to decide before approval.',
        'Export the results as CSV to import into your grading system.',
      ],
    },
  },
  {
    icon: Lightbulb,
    ar: {
      title: 'نصائح ذهبية',
      lines: [
        '● تحقق من نقطة «محرك OMR» في الشريط الجانبي قبل المسح — إن كانت حمراء اضغط «تشغيل المحرك» في خطوة المسح.',
        '● طالب بلا رقم؟ لا مشكلة — الورقة تُصحح ويمكن ربط الطالب لاحقًا من قائمة المراجعة.',
        '● إذا فشلت ورقة: أعد التصوير بإضاءة أفضل أو مستوٍ أكثر؛ وللحالات الصعبة استخدم وضع الزوايا اليدوي في صفحة «مسح وتصحيح» الكاملة.',
        '● جرّب أولًا بنسخة تجريبية: اطبع ورقتين، تعمدهما بالقلم، وامسحهما لترى النتائج قبل يوم الامتحان.',
      ],
    },
    en: {
      title: 'Golden tips',
      lines: [
        '● Check the "OMR engine" dot in the sidebar before scanning — if red, press "Start engine" in the scan step.',
        '● No student number? No problem — the sheet is still graded and identity can be linked later from the Review Queue.',
        '● If a sheet fails: re-shoot with better light / a flatter surface; for hard cases use manual-corner mode in the full "Scanning" page.',
        '● Do a dry run: print 2 sheets, fill them by hand, scan them and check the results before exam day.',
      ],
    },
  },
];

// ---------------- per-step inline tips ----------------

function tipFor(step: StepKey, lang: 'ar' | 'en'): string | null {
  if (lang === 'ar') {
    switch (step) {
      case 'exam': return 'اختر امتحانًا يحتوي أسئلة اختيار من متعدد — هي التي تتحول إلى فقاعات في ورقة الإجابة.';
      case 'key': return 'حدّد الإجابة الصحيحة لكل سؤال؛ المفتاح يُجمَّد عند النشر ولا يتأثر بالأوراق المطبوعة سابقًا.';
      case 'print': return 'اطبع بمقياس ١٠٠٪ (الحجم الفعلي) على A4 — أي تصغير يفسد مواضع الفقاعات.';
      case 'scan': return 'صوّر الورقة كاملة على سطح مستوٍ — الأركان الأربعة ورمز QR يجب أن تظهر في الصورة.';
      case 'results': return 'الأوراق الملتبسة تنتقل لقائمة المراجعة — اعتمدها هناك ثم حدّث هذه الصفحة.';
    }
  }
  switch (step) {
    case 'exam': return 'Pick an exam that contains MCQ questions — only MCQs become bubbles on the answer sheet.';
    case 'key': return 'Mark the correct answer for every question; the key is frozen at publish time and never affects previously printed sheets.';
    case 'print': return 'Print at 100% scale (actual size) on A4 — any shrinking breaks the bubble coordinates.';
    case 'scan': return 'Capture the full sheet on a flat surface — the 4 corner markers and the QR must be visible.';
    case 'results': return 'Ambiguous sheets move to the Review Queue — approve them there, then refresh this page.';
  }
}

// ---------------- upload row model ----------------

interface UploadRow {
  key: string;
  label: string;
  ok: boolean | null; // null = pending
  duplicate?: boolean;
  error?: string;
  score?: number | null;
  maxScore?: number | null;
  studentCode?: string | null;
  needsReview?: boolean;
  kind: 'image' | 'pdf-page';
  fileKey?: string; // index into filesRef for retry
  pageIndex?: number; // for pdf-page retry
}

export default function OmrPipeline({
  lang,
  examId: propExamId,
  onSelectExam,
  onChanged,
  onGoView,
}: {
  lang: 'ar' | 'en';
  examId: string | null;
  onSelectExam: (id: string) => void;
  onChanged: () => void;
  onGoView: (v: 'scan' | 'review' | 'design' | 'preview', examId?: string | null) => void;
}) {
  const L = useCallback((ar: string, en: string) => (lang === 'ar' ? ar : en), [lang]);

  // ---- wizard state
  const [step, setStep] = useState<StepKey>('exam');
  const [maxVisited, setMaxVisited] = useState(0);
  const [examId, setExamId] = useState<string | null>(propExamId ?? null);
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [detail, setDetail] = useState<ExamDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [copies, setCopies] = useState(30);
  const [engineOk, setEngineOk] = useState<boolean | null>(null);

  // ---- tutorial
  const [tutOpen, setTutOpen] = useState(false);
  const [tutSlide, setTutSlide] = useState(0);

  // ---- create-exam form (step 1)
  const [newTitle, setNewTitle] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [newDirection, setNewDirection] = useState<'rtl' | 'ltr'>('rtl');

  // ---- scan step
  const [hintVersionId, setHintVersionId] = useState<string>('auto');
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const filesRef = useRef<Map<string, File>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- results step
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [scansLoading, setScansLoading] = useState(false);
  // stable mirror of examId for callbacks that must not go stale
  const examIdRef = useRef<string | null>(examId);
  useEffect(() => {
    examIdRef.current = examId;
  }, [examId]);

  // ---- data loaders ----
  const loadExams = useCallback(async () => {
    try {
      const res = await fetch('/api/exams');
      const data = await res.json();
      setExams(Array.isArray(data) ? data : data.exams ?? []);
    } catch {
      /* non-critical */
    }
  }, []);

  const loadScans = useCallback(async (id: string) => {
    setScansLoading(true);
    try {
      const res = await fetch(`/api/scans?examId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const data = await res.json();
      setScans(Array.isArray(data) ? (data as ScanRow[]) : []);
    } catch {
      setScans([]);
    } finally {
      setScansLoading(false);
    }
  }, []);

  const loadEngine = useCallback(async () => {
    try {
      const res = await fetch('/api/engine/ensure');
      const d = await res.json();
      setEngineOk(Boolean(d.ok));
    } catch {
      setEngineOk(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/exams/${id}`);
      if (!res.ok) {
        setDetail(null);
        return;
      }
      const data = (await res.json()) as ExamDetail;
      setDetail(data);
      setKeyDraft(data.answerKey ?? {});
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const goStep = useCallback(
    (s: StepKey) => {
      const idx = STEP_ORDER.indexOf(s);
      setStep(s);
      setMaxVisited((m) => Math.max(m, idx));
      // results are produced outside this component too (camera scanning in
      // ScanStudio, batch uploads) — always refetch on entering the step
      if (s === 'results') {
        const id = examIdRef.current;
        if (id) void loadScans(id);
      }
      if (s === 'scan') void loadEngine();
    },
    [loadScans, loadEngine]
  );

  // ---- mount: restore last exam, check engine, auto-open tutorial ----
  useEffect(() => {
    void loadExams();
    void loadEngine();
    const saved = window.localStorage.getItem('anqb-omr-wizard-exam');
    if (!propExamId && saved) setExamId(saved);
    if (!window.localStorage.getItem('anqb-omr-tut-v1')) {
      const t = setTimeout(() => setTutOpen(true), 500);
      return () => clearTimeout(t);
    }
  }, [loadExams, loadEngine, propExamId]);

  const closeTutorial = () => {
    setTutOpen(false);
    window.localStorage.setItem('anqb-omr-tut-v1', '1');
  };

  // ---- adopt parent's selected exam (e.g. opened from an exam card) ----
  useEffect(() => {
    if (propExamId && propExamId !== examId) setExamId(propExamId);
  }, [propExamId]);

  // ---- exam changed: sync parent, persist, load everything, jump to first incomplete ----
  useEffect(() => {
    if (!examId) {
      setDetail(null);
      setScans([]);
      return;
    }
    window.localStorage.setItem('anqb-omr-wizard-exam', examId);
    onSelectExam(examId);
    void loadDetail(examId);
    void loadScans(examId);
  }, [examId, loadDetail, loadScans, onSelectExam]);

  // ---- derived ----
  const mcqQuestions: QBQuestion[] = useMemo(
    () => (detail?.document.questions ?? []).filter((q) => q.type === 'mcq' && Array.isArray(q.options) && q.options.length >= 2),
    [detail]
  );
  const omrOn = detail?.document.omr.enabled ?? false;
  const setCount = mcqQuestions.filter((q) => (keyDraft[q.id] ?? '') !== '').length;
  const missingKey = mcqQuestions.length - setCount;
  const keyComplete = omrOn && mcqQuestions.length > 0 && missingKey === 0;

  const published = (detail?.versions.length ?? 0) > 0;
  const latest = detail?.versions[0];
  const frozenCount = latest?.answerKeyCount ?? -1;
  const draftClean: Record<string, string> = {};
  for (const [qid, letter] of Object.entries(keyDraft)) if (letter) draftClean[qid] = letter;
  const keyDiffers = published && !!latest?.answerKeyHash && keyFingerprint(draftClean) !== latest.answerKeyHash;
  const printReady = published && !keyDiffers;

  // unlock rules — the golden path requires the previous stage to be sound
  const unlocked: Record<StepKey, boolean> = {
    exam: true,
    key: !!examId,
    print: !!examId && mcqQuestions.length > 0 && keyComplete,
    scan: printReady && !!latest?.id,
    results: printReady,
  };

  const done: Record<StepKey, boolean> = {
    exam: !!examId && mcqQuestions.length > 0,
    key: keyComplete,
    print: printReady && !!latest?.omrTemplate,
    scan: scans.length > 0,
    results: scans.length > 0,
  };

  // when a NEW exam is chosen (different id), land on its first incomplete step
  const lastLoadedExamRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !examId) return;
    if (lastLoadedExamRef.current === examId) return;
    lastLoadedExamRef.current = examId;
    const mcq = detail.document.questions.filter((q) => q.type === 'mcq' && Array.isArray(q.options) && q.options.length >= 2);
    const set = mcq.filter((q) => ((detail.answerKey ?? {})[q.id] ?? '') !== '').length;
    let target: StepKey = 'exam';
    if (mcq.length === 0) target = 'exam';
    else if (!detail.document.omr.enabled || set < mcq.length) target = 'key';
    else if (detail.versions.length === 0) target = 'print';
    else target = 'scan';
    const idx = STEP_ORDER.indexOf(target);
    setStep(target);
    setMaxVisited(idx);
    setHintVersionId(detail.versions[0]?.id ?? 'auto');
    setRows([]);
    filesRef.current.clear();
  }, [detail, examId]);

  // ---- actions ----
  const createExam = async () => {
    if (!newTitle.trim()) {
      toast.error(L('اكتب عنوان الامتحان', 'Enter an exam title'));
      return;
    }
    setBusy('create');
    try {
      const res = await fetch('/api/exams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), subject: newSubject.trim(), direction: newDirection }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? L('فشل الإنشاء', 'Create failed'));
        return;
      }
      toast.success(L('تم إنشاء الامتحان', 'Exam created'));
      setNewTitle('');
      setNewSubject('');
      await loadExams();
      onChanged();
      setExamId(data.exam?.id ?? data.id);
    } finally {
      setBusy('');
    }
  };

  const toggleOmr = async () => {
    if (!detail || !examId) return;
    setBusy('omr');
    try {
      const res = await fetch(`/api/exams/${examId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document: { ...detail.document, omr: { ...detail.document.omr, enabled: !omrOn } } }),
      });
      if (!res.ok) {
        toast.error(L('فشل التحديث', 'Update failed'));
        return;
      }
      toast.success(omrOn ? L('تم تعطيل OMR', 'OMR disabled') : L('تم تفعيل OMR', 'OMR enabled'));
      await loadDetail(examId);
    } finally {
      setBusy('');
    }
  };

  const saveKey = async () => {
    if (!detail || !examId) return;
    setBusy('key');
    try {
      const clean: Record<string, string> = {};
      for (const [qid, letter] of Object.entries(keyDraft)) if (letter) clean[qid] = letter;
      const res = await fetch(`/api/exams/${examId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answerKey: clean }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? L('فشل حفظ المفتاح', 'Failed to save key'));
        return;
      }
      toast.success(L(`تم حفظ المفتاح (${Object.keys(clean).length} سؤالًا)`, `Key saved (${Object.keys(clean).length} questions)`));
      await loadDetail(examId);
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    if (!examId) return;
    setBusy('publish');
    try {
      const res = await fetch(`/api/exams/${examId}/publish`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? L('فشل النشر', 'Publish failed'));
        return;
      }
      toast.success(L(`تم نشر النسخة ${d.version} وتجميد المفتاح`, `Version ${d.version} published — key frozen`));
      await loadDetail(examId);
      onChanged();
    } finally {
      setBusy('');
    }
  };

  const startEngine = async () => {
    setBusy('engine');
    try {
      const res = await fetch('/api/engine/ensure', { method: 'POST' });
      const d = await res.json();
      if (res.ok && d.ok) {
        toast.success(L('تم تشغيل محرك OMR', 'OMR engine started'));
        setEngineOk(true);
      } else {
        toast.error(d.error ?? L('تعذر تشغيل المحرك', 'Could not start engine'));
        setEngineOk(false);
      }
    } catch {
      toast.error(L('تعذر الاتصال بالمحرك', 'Engine unreachable'));
    } finally {
      setBusy('');
    }
  };

  // ================= SCAN UPLOAD =================

  const patchRow = (key: string, patch: Partial<UploadRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const postScanImage = async (file: File, hint: string) => {
    const rawUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const dataUrl = await downscaleImage(rawUrl);
    const form = new FormData();
    form.append('image', await dataUrlToBlob(dataUrl), 'sheet.jpg');
    if (hint !== 'auto') form.append('examVersionIdHint', hint);
    const res = await fetch('/api/scan', { method: 'POST', body: form });
    const data = await res.json();
    return { res, data } as { res: Response; data: Record<string, unknown> & { error?: string; duplicate?: boolean; needsReview?: boolean; studentCode?: string | null; grade?: { score?: number; maxScore?: number } | null } };
  };

  const postPdfSlice = async (srcFile: File, index: number, total: number, hint: string) => {
    const { PDFDocument } = await import('pdf-lib');
    const src = await PDFDocument.load(new Uint8Array(await srcFile.arrayBuffer()));
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [index]);
    doc.addPage(page);
    const slice = await doc.save();
    if (slice.byteLength > PDF_PAGE_LIMIT_BYTES) {
      return { tooBig: true as const };
    }
    const form = new FormData();
    form.append('pdf', new Blob([slice as unknown as BlobPart], { type: 'application/pdf' }), `page-${index + 1}.pdf`);
    form.append('pageChunk', JSON.stringify({ index, total }));
    if (hint !== 'auto') form.append('examVersionIdHint', hint);
    const res = await fetch('/api/scan/pdf', { method: 'POST', body: form });
    const data = await res.json();
    return { tooBig: false as const, res, data } as { tooBig: false; res: Response; data: { results?: Array<{ index: number; ok: boolean; scanId?: string; duplicate?: boolean; error?: string; studentCode?: string | null; score?: number | null; maxScore?: number | null; needsReview?: boolean; transportAbort?: boolean }>; error?: string } };
  };

  const applyResultToRow = (key: string, ok: boolean, r: { duplicate?: boolean; error?: string; studentCode?: string | null; score?: number | null; maxScore?: number | null; needsReview?: boolean }) => {
    patchRow(key, {
      ok,
      duplicate: r.duplicate,
      error: r.error,
      studentCode: r.studentCode ?? null,
      score: r.score ?? null,
      maxScore: r.maxScore ?? null,
      needsReview: r.needsReview,
    });
  };

  const handleFiles = async (list: FileList | null) => {
    if (!list || list.length === 0 || uploading) return;
    const hint = hintVersionId === 'auto' ? latest?.id ?? '' : hintVersionId;
    if (!hint) {
      toast.error(L('انشر الامتحان أولًا لتوليد نسخة قابلة للمسح', 'Publish the exam first to get a scannable version'));
      return;
    }
    const files = Array.from(list).slice(0, 60);
    const oversize = files.filter((f) => f.size > 40 * 1024 * 1024);
    if (oversize.length > 0) {
      toast.error(L('ملف أكبر من 40 ميجابايت — أعد المسح بدقة أقل', 'A file exceeds 40MB — rescan at lower DPI'));
      return;
    }
    setUploading(true);
    let aborted = false;
    try {
      for (const f of files) {
        if (aborted) break;
        const key = `${f.name}#${Date.now()}#${Math.round(Math.random() * 1e6)}`;
        filesRef.current.set(key, f);
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
        if (!isPdf) {
          setRows((prev) => [...prev, { key, label: f.name, ok: null, kind: 'image', fileKey: key }]);
          try {
            const { res, data } = await postScanImage(f, hint);
            if (!res.ok) applyResultToRow(key, false, { error: data.error ?? `HTTP ${res.status}` });
            else applyResultToRow(key, true, data);
          } catch {
            applyResultToRow(key, false, { error: L('تعذر الاتصال بخدمة التحليل', 'Analyzer unreachable') });
          }
        } else {
          // PDF: whole-file when small enough, else slice per page
          if (f.size <= PDF_WHOLE_LIMIT_BYTES) {
            const form = new FormData();
            form.append('pdf', f, f.name);
            if (hint !== 'auto') form.append('examVersionIdHint', hint);
            try {
              const res = await fetch('/api/scan/pdf', { method: 'POST', body: form });
              const data = await res.json();
              const results = (data.results ?? []) as Array<{ index: number; ok: boolean; duplicate?: boolean; error?: string; studentCode?: string | null; score?: number | null; maxScore?: number | null; needsReview?: boolean }>;
              if (!res.ok || results.length === 0) {
                setRows((prev) => [...prev, { key, label: f.name, ok: false, kind: 'pdf-page', fileKey: key, pageIndex: 0, error: data.error ?? `HTTP ${res.status}` }]);
              } else {
                for (const r of results) {
                  const rk = `${key}:p${r.index}`;
                  setRows((prev) => [...prev, { key: rk, label: `${f.name} — ${L('صفحة', 'page')} ${r.index + 1}`, ok: r.ok, duplicate: r.duplicate, error: r.error, studentCode: r.studentCode ?? null, score: r.score ?? null, maxScore: r.maxScore ?? null, needsReview: r.needsReview, kind: 'pdf-page', fileKey: key, pageIndex: r.index }]);
                }
              }
            } catch {
              setRows((prev) => [...prev, { key, label: f.name, ok: false, kind: 'pdf-page', fileKey: key, pageIndex: 0, error: L('تعذر الاتصال', 'Unreachable') }]);
            }
          } else {
            let total = 0;
            try {
              const { PDFDocument } = await import('pdf-lib');
              const src = await PDFDocument.load(new Uint8Array(await f.arrayBuffer()));
              total = src.getPageCount();
            } catch {
              setRows((prev) => [...prev, { key, label: f.name, ok: false, kind: 'pdf-page', fileKey: key, pageIndex: 0, error: L('تعذر قراءة PDF', 'Unreadable PDF') }]);
              continue;
            }
            for (let i = 0; i < total; i++) {
              const rk = `${key}:p${i}`;
              setRows((prev) => [...prev, { key: rk, label: `${f.name} — ${L('صفحة', 'page')} ${i + 1}`, ok: null, kind: 'pdf-page', fileKey: key, pageIndex: i }]);
              try {
                const sliced = await postPdfSlice(f, i, total, hint);
                if (sliced.tooBig) {
                  applyResultToRow(rk, false, { error: L('الصفحة أكبر من حد الرفع — أعد مسحها بدقة أقل', 'Page exceeds upload limit — rescan at lower DPI') });
                  continue;
                }
                const r0 = sliced.data.results?.[0];
                if (!sliced.res.ok || !r0) {
                  applyResultToRow(rk, false, { error: sliced.data.error ?? `HTTP ${sliced.res.status}` });
                  if (sliced.res.status >= 500) {
                    aborted = true;
                    toast.error(L('انقطع الاتصال بالمحرك — تم إيقاف الدفعة، أعد المحاولة', 'Engine connection lost — batch stopped, please retry'));
                    break;
                  }
                } else {
                  applyResultToRow(rk, r0.ok, r0);
                }
              } catch {
                applyResultToRow(rk, false, { error: L('تعذر الاتصال', 'Unreachable') });
              }
            }
          }
        }
      }
      if (examId) void loadScans(examId);
    } finally {
      setUploading(false);
    }
  };

  const retryRow = async (row: UploadRow) => {
    if (uploading || !row.fileKey) return;
    const srcFile = filesRef.current.get(row.fileKey);
    if (!srcFile) {
      toast.error(L('الملف الأصلي غير متوفر — أعد رفعه', 'Original file unavailable — re-upload'));
      return;
    }
    const hint = hintVersionId === 'auto' ? latest?.id ?? '' : hintVersionId;
    patchRow(row.key, { ok: null, error: undefined, duplicate: undefined });
    try {
      if (row.kind === 'image') {
        const { res, data } = await postScanImage(srcFile, hint);
        if (!res.ok) applyResultToRow(row.key, false, { error: data.error ?? `HTTP ${res.status}` });
        else applyResultToRow(row.key, true, data);
      } else {
        const idx = row.pageIndex ?? 0;
        const sliced = await postPdfSlice(srcFile, idx, idx + 1, hint);
        if (sliced.tooBig) {
          applyResultToRow(row.key, false, { error: L('الصفحة أكبر من حد الرفع', 'Page exceeds upload limit') });
          return;
        }
        const r0 = sliced.data.results?.[0];
        if (!sliced.res.ok || !r0) applyResultToRow(row.key, false, { error: sliced.data.error ?? `HTTP ${sliced.res.status}` });
        else applyResultToRow(row.key, r0.ok, r0);
      }
      if (examId) void loadScans(examId);
    } catch {
      applyResultToRow(row.key, false, { error: L('تعذر الاتصال', 'Unreachable') });
    }
  };

  const okCount = rows.filter((r) => r.ok === true && !r.duplicate).length;
  const dupCount = rows.filter((r) => r.ok === true && r.duplicate).length;
  const failCount = rows.filter((r) => r.ok === false).length;
  const pendingCount = rows.filter((r) => r.ok === null).length;
  const progressPct = rows.length === 0 ? 0 : Math.round(((rows.length - pendingCount) / rows.length) * 100);

  // ================= RESULTS =================

  const graded = scans.filter((s) => s.score !== null && s.percent !== null);
  const avgPercent = graded.length > 0 ? Math.round(graded.reduce((a, s) => a + (s.percent ?? 0), 0) / graded.length) : null;
  const bestPercent = graded.length > 0 ? Math.max(...graded.map((s) => s.percent ?? 0)) : null;
  const reviewCount = scans.filter((s) => s.needsReview).length;
  const failedCount = scans.filter((s) => s.status === 'FAILED').length;

  const fmtTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso.slice(0, 16);
    }
  };

  const fmtNum = (n: number) => (lang === 'ar' ? n.toLocaleString('ar-EG') : String(n));

  const ForwardIcon = lang === 'ar' ? ArrowLeft : ArrowRight;
  const BackIcon = lang === 'ar' ? ArrowRight : ArrowLeft;

  // ================================================================
  return (
    <div className="animate-fade-up space-y-4" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <PaneHeader
        icon={Workflow}
        title={L('معالج التصحيح الآلي (OMR)', 'OMR Wizard')}
        desc={L(
          'مسار واحد من الامتحان إلى الدرجات: اختر ← مفتاح ← انشر واطبع ← امسح ← نتائج',
          'One path from exam to grades: pick → key → publish & print → scan → results'
        )}
        actions={
          <Button variant="outline" className="gap-1.5" onClick={() => { setTutSlide(0); setTutOpen(true); }}>
            <Lightbulb className="h-4 w-4 text-warning" />
            {L('شرح الاستخدام', 'Tutorial')}
          </Button>
        }
      />

      {/* ================= stepper ================= */}
      <Card>
        <CardContent className="px-4 py-4">
          <ol className="flex items-start gap-1.5">
            {STEPS.map((s, i) => {
              const idx = i;
              const isCurrent = step === s.key;
              const isDone = done[s.key] && !isCurrent;
              const reachable = unlocked[s.key] || idx <= maxVisited;
              const isFirst = idx === 0;
              return (
                <li key={s.key} className="flex min-w-0 flex-1 items-start">
                  {!isFirst && <span aria-hidden className="mt-[18px] h-px w-4 shrink-0 bg-border sm:w-6" />}
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => reachable && goStep(s.key)}
                    aria-current={isCurrent ? 'step' : undefined}
                    className={`group flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 transition ${
                      reachable ? 'hover:bg-accent' : 'cursor-not-allowed opacity-45'
                    }`}
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-[13px] font-extrabold transition ${
                        isCurrent
                          ? 'border-transparent text-white shadow-[0_8px_22px_-10px_oklch(0.55_0.18_300/0.75)]'
                          : isDone
                            ? 'border-transparent bg-success/100 text-white'
                            : 'border-border bg-background text-muted-foreground'
                      }`}
                    >
                      {isDone ? <CheckCircle2 className="h-4.5 w-4.5" /> : reachable ? <s.icon className="h-4 w-4" /> : <Lock className="h-3.5 w-3.5" />}
                    </span>
                    <span className={`w-full text-center text-[13px] font-bold leading-tight line-clamp-2 sm:text-[13px] ${isCurrent ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {lang === 'ar' ? s.ar : s.en}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      {/* ================= STEP 1 — EXAM ================= */}
      {step === 'exam' && (
        <div className="space-y-4">
          <TipBanner tip={tipFor('exam', lang)} lang={lang} />
          <div className="grid gap-4 lg:grid-cols-2">
            {/* pick existing */}
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="text-sm font-bold">{L('اختر امتحانًا موجودًا', 'Pick an existing exam')}</div>
                {exams.length === 0 ? (
                  <p className="rounded-lg bg-muted/50 p-3 text-[13px] text-muted-foreground">
                    {L('لا توجد امتحانات بعد — أنشئ أول امتحان من النموذج المجاور.', 'No exams yet — create your first one using the form beside.')}
                  </p>
                ) : (
                  <div className="max-h-72 space-y-1.5 overflow-y-auto omr-key-scroll pe-1">
                    {exams.map((ex) => {
                      const active = ex.id === examId;
                      return (
                        <button
                          key={ex.id}
                          type="button"
                          onClick={() => setExamId(ex.id)}
                          aria-pressed={active}
                          className={`flex w-full items-center gap-2 rounded-xl border p-3 text-start transition ${
                            active ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-primary/50 hover:bg-accent'
                          }`}
                        >
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${active ? 'border-primary bg-primary' : 'border-muted-foreground/40'}`}>
                            {active && <CheckCircle2 className="h-3.5 w-3.5 text-white" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-bold">{ex.title}</span>
                            <span className="block text-[13px] text-muted-foreground">
                              {ex.subject ?? '—'}، {fmtNum(ex.questionCount)} {L('سؤال', 'questions')}، {ex.status === 'PUBLISHED' ? L('منشور', 'published') : L('مسودة', 'draft')}
                            </span>
                          </span>
                          {ex.omrEnabled && <Badge className="bg-primary/15 text-primary">{L('OMR', 'OMR')}</Badge>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* create new */}
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="text-sm font-bold">{L('أو أنشئ امتحانًا جديدًا', 'Or create a new exam')}</div>
                <div>
                  <Label className="text-[13px]">{L('عنوان الامتحان', 'Exam title')}</Label>
                  <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={L('امتحان الرياضيات — أكتوبر', 'Math exam — October')} />
                </div>
                <div>
                  <Label className="text-[13px]">{L('المادة', 'Subject')}</Label>
                  <Input value={newSubject} onChange={(e) => setNewSubject(e.target.value)} placeholder={L('رياضيات', 'Math')} />
                </div>
                <div>
                  <Label className="text-[13px]">{L('اتجاه الورقة', 'Paper direction')}</Label>
                  <Select value={newDirection} onValueChange={(v) => setNewDirection(v as 'rtl' | 'ltr')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rtl">{L('عربي (يمين ← يسار)', 'Arabic (right → left)')}</SelectItem>
                      <SelectItem value="ltr">{L('English (left → right)', 'English (left → right)')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button className="w-full gap-1 border-0 text-white" disabled={busy !== ''} onClick={() => void createExam()}>
                  {busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {L('إنشاء واختيار', 'Create & select')}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* selected exam summary */}
          {examId && (
            <Card>
              <CardContent className="p-4">
                {detailLoading || !detail ? (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> {L('جارٍ تحميل تفاصيل الامتحان…', 'Loading exam details…')}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-extrabold">{detail.exam.title}</div>
                      <div className="mt-0.5 text-[13px] text-muted-foreground">
                        {fmtNum(detail.document.questions.length)} {L('سؤال', 'questions')}، منها {fmtNum(mcqQuestions.length)} {L('اختيار من متعدد', 'MCQ')}، {published ? L(`منشور — نسخة ${latest?.version}`, `published — v${latest?.version}`) : L('مسودة غير منشورة', 'draft, not published')}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" className="gap-1 text-[13px]" onClick={() => onGoView('design', examId)}>
                        <BookOpen className="h-3.5 w-3.5" /> {L('فتح المصمم', 'Open Designer')}
                      </Button>
                      <Button size="sm" className="gap-1 border-0 text-[13px] text-white" disabled={!unlocked.key} onClick={() => goStep('key')}>
                        {L('التالي: مفتاح التصحيح', 'Next: answer key')} <ForwardIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
                {!detailLoading && detail && mcqQuestions.length === 0 && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-warning/40/30 bg-warning/100/10 p-3 text-[13px] text-warning dark:text-warning">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {L('لا توجد أسئلة MCQ في هذا الامتحان — أضف أسئلة من المصمم لتتمكن من تكوين ورقة الفقاعات والمفتاح.', 'No MCQ questions in this exam — add questions in the Designer to build the bubble sheet and key.')}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ================= STEP 2 — ANSWER KEY ================= */}
      {step === 'key' && detail && (
        <div className="space-y-4">
          <TipBanner tip={tipFor('key', lang)} lang={lang} />
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-5 w-5 text-primary" />
                  <div>
                    <div className="text-sm font-bold">{L('مفتاح التصحيح — دليل الإجابة', 'Answer key — guide answers')}</div>
                    <div className="text-[13px] text-muted-foreground">
                      {L('اضغط على حرف الإجابة الصحيحة لكل سؤال', 'Tap the letter of the correct answer for each question')}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={missingKey === 0 ? 'default' : 'destructive'} className={missingKey === 0 ? 'bg-primary' : ''}>
                    {fmtNum(setCount)} / {fmtNum(mcqQuestions.length)}
                  </Badge>
                  {!omrOn && (
                    <Button size="sm" className="h-8 gap-1 border-0 text-[13px] text-white" disabled={busy !== ''} onClick={() => void toggleOmr()}>
                      <Sparkles className="h-3.5 w-3.5" /> {L('تفعيل OMR أولًا', 'Enable OMR first')}
                    </Button>
                  )}
                  {mcqQuestions.length > 0 && setCount > 0 && (
                    <Button size="sm" variant="outline" className="h-8 gap-1 text-[13px]" disabled={busy !== ''} onClick={() => setKeyDraft({})}>
                      <Eraser className="h-3.5 w-3.5" /> {L('مسح الكل', 'Clear all')}
                    </Button>
                  )}
                  {mcqQuestions.length > 0 && (
                    <Button size="sm" className="h-8 gap-1 bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy !== '' || missingKey === setCount} onClick={() => void saveKey()}>
                      {busy === 'key' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />} {L('حفظ المفتاح', 'Save key')}
                    </Button>
                  )}
                </div>
              </div>

              {mcqQuestions.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-warning/40/30 bg-warning/100/10 p-6 text-center">
                  <AlertTriangle className="h-6 w-6 text-warning" />
                  <div className="text-[13px] text-warning dark:text-warning">
                    {L('لا توجد أسئلة MCQ — افتح المصمم وأضف الأسئلة أولًا.', 'No MCQ questions — open the Designer and add questions first.')}
                  </div>
                  <Button size="sm" variant="outline" className="gap-1 text-[13px]" onClick={() => onGoView('design', examId)}>
                    <BookOpen className="h-3.5 w-3.5" /> {L('فتح المصمم', 'Open Designer')}
                  </Button>
                </div>
              ) : (
                <>
                  {missingKey > 0 && (
                    <div className="rounded-lg border border-warning/40/30 bg-warning/100/10 p-2.5 text-[13px] text-warning dark:text-warning">
                      {L(`${fmtNum(missingKey)} سؤالًا بدون إجابة صحيحة — أكملها قبل النشر (تُحتسب فارغة في التصحيح).`, `${fmtNum(missingKey)} question(s) without a correct answer — complete before publishing (graded as blank).`)}
                    </div>
                  )}
                  <div className="max-h-96 space-y-1.5 overflow-y-auto omr-key-scroll pe-1">
                    {mcqQuestions.map((q) => {
                      const current = keyDraft[q.id] ?? '';
                      return (
                        <div key={q.id} className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
                          <span className="w-8 shrink-0 text-sm font-bold">{fmtNum(q.number)}</span>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground" title={q.prompt}>{q.prompt || '—'}</span>
                          <div className="flex shrink-0 gap-1">
                            {q.options.map((o) => {
                              const active = current === o.id;
                              return (
                                <button
                                  key={o.id}
                                  type="button"
                                  onClick={() => setKeyDraft((prev) => ({ ...prev, [q.id]: prev[q.id] === o.id ? '' : o.id }))}
                                  aria-pressed={active}
                                  aria-label={`${L('سؤال', 'Question')} ${q.number}: ${o.id}`}
                                  title={o.text || o.id}
                                  className={`h-7 w-7 rounded-full border text-[13px] font-bold transition ${
                                    active
                                      ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                                      : 'border-border bg-background text-muted-foreground hover:border-primary/60 hover:text-primary'
                                  }`}
                                >
                                  {o.id}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 p-3">
                    <div className="text-[13px] leading-relaxed text-muted-foreground">
                      {published ? (
                        <>
                          {L(`النسخة المنشورة (نسخة ${latest?.version}) مجمّدة على مفتاح بـ`, `Published version (v${latest?.version}) is frozen with a key of`)} <b>{fmtNum(frozenCount)}</b> {L('سؤالًا', 'questions')}
                          {keyDiffers && <span className="text-warning"> — {L('المفتاح الحالي مختلف؛ أعد النشر لتجميد المفتاح الجديد.', ' — the current key differs; re-publish to freeze it.')}</span>}
                        </>
                      ) : (
                        L('المفتاح يُجمَّد عند النشر في الخطوة التالية.', 'The key is frozen when you publish in the next step.')
                      )}
                    </div>
                    <Button size="sm" className="gap-1 border-0 text-[13px] text-white" disabled={!keyComplete} onClick={() => goStep('print')}>
                      {L('التالي: النشر والطباعة', 'Next: publish & print')} <ForwardIcon className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ================= STEP 3 — PUBLISH & PRINT ================= */}
      {step === 'print' && detail && (
        <div className="space-y-4">
          <TipBanner tip={tipFor('print', lang)} lang={lang} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-primary" />
                  <div className="text-sm font-bold">{L('نشر الامتحان (تجميد المفتاح والقالب)', 'Publish (freeze key & template)')}</div>
                </div>
                {!published ? (
                  <>
                    <p className="text-[13px] leading-relaxed text-muted-foreground">
                      {L('النشر ينشئ نسخة ثابتة من الأسئلة والمفتاح ويولّد قالب إحداثيات ورقة الفقاعات. لا يمكن المسح قبل النشر.', 'Publishing creates an immutable snapshot of questions + key and generates the bubble-sheet coordinate template. Scanning requires a published version.')}
                    </p>
                    <Button className="gap-1 border-0 text-white" disabled={busy !== ''} onClick={() => void publish()}>
                      {busy === 'publish' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {L('نشر الامتحان الآن', 'Publish now')}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="rounded-xl border p-3 text-[13px] leading-relaxed">
                      <div className="font-bold">{L(`النسخة ${latest?.version} منشورة ✓`, `Version ${latest?.version} published ✓`)}</div>
                      <div className="mt-1 text-muted-foreground">
                        {L('المفتاح المجمّد:', 'Frozen key:')} <b>{frozenCount >= 0 ? fmtNum(frozenCount) : '—'}</b> {L('سؤالًا', 'questions')}، {L('آخر نشر', 'last published')} {new Date(latest?.publishedAt ?? Date.now()).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US')}
                      </div>
                      {keyDiffers && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/40/30 bg-warning/100/10 p-2 text-warning dark:text-warning">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>{L('المفتاح الحالي مختلف عن المجمد — أعد النشر لإنشاء نسخة جديدة (الأوراق القديمة تبقى صحيحة).', 'The current key differs from the frozen one — re-publish to create a new version (old sheets stay correct).')}</span>
                        </div>
                      )}
                    </div>
                    <Button variant="outline" className="gap-1" disabled={busy !== ''} onClick={() => void publish()}>
                      {busy === 'publish' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                      {keyDiffers ? L('إعادة النشر بنسخة جديدة', 'Re-publish as new version') : L('نشر نسخة جديدة', 'Publish a new version')}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center gap-2">
                  <Printer className="h-5 w-5 text-primary" />
                  <div className="text-sm font-bold">{published ? L(`توليد أوراق الفقاعات (نسخة ${latest?.version})`, `Generate bubble sheets (v${latest?.version})`) : L('توليد الأوراق', 'Generate sheets')}</div>
                </div>
                {!published ? (
                  <p className="rounded-lg bg-muted/50 p-3 text-[13px] text-muted-foreground">{L('انشر الامتحان أولًا لتتمكن من طباعة الأوراق.', 'Publish the exam first to enable printing.')}</p>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <Label className="whitespace-nowrap text-[13px]">{L('عدد النسخ', 'Copies')}</Label>
                      <Slider value={[copies]} min={1} max={200} step={1} onValueChange={([v]) => setCopies(v)} className="flex-1" />
                      <span className="w-10 text-center text-sm font-extrabold">{fmtNum(copies)}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" className="gap-1 bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy !== ''} onClick={() => void downloadFile(`/api/versions/${latest?.id}/pdf?type=omr&copies=${copies}`, 'omr-sheets.pdf', L(`تم تنزيل ${copies} ورقة`, `${copies} sheets downloaded`))}>
                        <FileDown className="h-4 w-4" /> {L(`طباعة ${copies} ورقة (PDF)`, `Print ${copies} sheets (PDF)`)}
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1" disabled={busy !== ''} onClick={() => void downloadFile(`/api/versions/${latest?.id}/omr-png?sheet=0`, 'omr-sheet-300dpi.png')}>
                        <FileDown className="h-4 w-4" /> PNG 300dpi
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1" disabled={busy !== ''} onClick={() => void downloadFile(`/api/versions/${latest?.id}/pdf?type=exam`, 'exam.pdf')}>
                        <BookOpen className="h-4 w-4" /> {L('PDF الامتحان', 'Exam PDF')}
                      </Button>
                    </div>
                  </>
                )}
                <div className="rounded-xl border border-border bg-muted/40 p-3 text-[13px] leading-relaxed text-muted-foreground">
                  <div className="mb-1 flex items-center gap-1.5 font-bold text-foreground"><Printer className="h-3.5 w-3.5" /> {L('قواعد الطباعة الذهبية', 'Golden printing rules')}</div>
                  <ul className="list-inside list-disc space-y-0.5">
                    <li>{L('مقياس ١٠٠٪ — «الحجم الفعلي» لا «ملاءمة الصفحة»', '100% scale — "actual size", never "fit to page"')}</li>
                    <li>{L('A4، أبيض وأسود يكفي، بدون وضع توفير الحبر', 'A4, B/W is fine, no ink-saver mode')}</li>
                    <li>{L('علامات الأركان الأربعة ورمز QR يجب أن تكون حادة', 'The 4 corner markers and QR must be sharp')}</li>
                  </ul>
                </div>
                <Button size="sm" className="w-full gap-1 border-0 text-[13px] text-white" disabled={!unlocked.scan} onClick={() => goStep('scan')}>
                  {L('التالي: مسح الأوراق', 'Next: scan the sheets')} <ForwardIcon className="h-3.5 w-3.5" />
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ================= STEP 4 — SCAN ================= */}
      {step === 'scan' && (
        <div className="space-y-4">
          <TipBanner tip={tipFor('scan', lang)} lang={lang} />
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ScanLine className="h-5 w-5 text-primary" />
                  <div className="text-sm font-bold">{L('رفع الأوراق الممسوحة', 'Upload scanned sheets')}</div>
                </div>
                <div className="flex items-center gap-2">
                  {engineOk === false && (
                    <Button size="sm" variant="outline" className="h-8 gap-1 border-warning/40/40 text-[13px] text-warning" disabled={busy !== ''} onClick={() => void startEngine()}>
                      {busy === 'engine' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {L('تشغيل المحرك', 'Start engine')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-8 gap-1 text-[13px]" onClick={() => onGoView('scan', examId)}>
                    <Camera className="h-3.5 w-3.5" /> {L('المسح بالكاميرا', 'Camera scanning')}
                  </Button>
                </div>
              </div>

              {/* engine status */}
              {engineOk !== null && (
                <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${engineOk ? 'border border-success/40/30 bg-success/100/10 text-success dark:text-success' : 'border border-warning/40/30 bg-warning/100/10 text-warning dark:text-warning'}`}>
                  <span className={`h-2 w-2 rounded-full ${engineOk ? 'bg-success/100' : 'bg-warning/100'}`} />
                  {engineOk ? L('محرك قراءة الأوراق يعمل', 'Sheet-reading engine is running') : L('محرك القراءة متوقف — المسح سيفشل حتى تشغيله', 'Reading engine is down — scanning will fail until started')}
                </div>
              )}

              {/* version hint */}
              {detail && detail.versions.length > 1 && (
                <div className="flex items-center gap-2">
                  <Label className="whitespace-nowrap text-[13px]">{L('نسخة الامتحان', 'Exam version')}</Label>
                  <Select value={hintVersionId} onValueChange={setHintVersionId}>
                    <SelectTrigger className="h-8 w-64 text-[13px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{L('تلقائي (من رمز QR)', 'Auto (from QR)')}</SelectItem>
                      {detail.versions.map((v) => (
                        <SelectItem key={v.id} value={v.id}>{L(`نسخة ${v.version}`, `Version ${v.version}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[13px] text-muted-foreground">{L('يُكتشف تلقائيًا من QR — اختر يدويًا فقط لصور بلا QR', 'Auto-detected from QR — pick manually only for photos without QR')}</span>
                </div>
              )}

              {/* dropzone */}
              <div
                role="button"
                tabIndex={0}
                aria-label={L('منطقة رفع الأوراق', 'Sheet upload dropzone')}
                onClick={() => !uploading && fileInputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFiles(e.dataTransfer.files); }}
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition ${
                  dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent'
                } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
              >
                {uploading ? <Loader2 className="h-7 w-7 animate-spin text-primary" /> : <Upload className="h-7 w-7 text-primary" />}
                <div className="text-sm font-bold">
                  {uploading ? L('جارٍ المعالجة…', 'Processing…') : L('اسحب صور الأوراق أو ملف PDF هنا — أو اضغط للاختيار', 'Drop sheet photos or a PDF here — or click to browse')}
                </div>
                <div className="text-[13px] text-muted-foreground">
                  {L('JPG / PNG / PDF متعدد الصفحات — حتى 40 ميجابايت للملف، التكرار يُتجاهل تلقائيًا', 'JPG / PNG / multi-page PDF — up to 40MB per file, duplicates auto-ignored')}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/*,application/pdf"
                  multiple
                  onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }}
                />
              </div>

              {/* progress */}
              {rows.length > 0 && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-bold">{fmtNum(rows.length - pendingCount)} / {fmtNum(rows.length)}</span>
                    <Badge className="bg-success/100/15 text-success">{L('ناجحة', 'ok')} {fmtNum(okCount)}</Badge>
                    {dupCount > 0 && <Badge className="bg-muted text-muted-foreground">{L('مكررة', 'dup')} {fmtNum(dupCount)}</Badge>}
                    {failCount > 0 && <Badge className="bg-destructive/100/15 text-destructive">{L('فاشلة', 'failed')} {fmtNum(failCount)}</Badge>}
                    <div className="min-w-32 flex-1"><Progress value={progressPct} className="h-1.5" /></div>
                  </div>
                  <div className="max-h-64 space-y-1 overflow-y-auto omr-key-scroll pe-1">
                    {rows.map((r) => (
                      <div key={r.key} className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px]">
                        {r.ok === null ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                        ) : r.ok ? (
                          r.duplicate ? <Copy className="h-4 w-4 shrink-0 text-muted-foreground" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                        ) : (
                          <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{r.label}</span>
                        {r.ok && r.score != null && (
                          <Badge className="bg-success/100/15 text-success">
                            {fmtNum(r.score)} / {fmtNum(r.maxScore ?? 0)}
                          </Badge>
                        )}
                        {r.ok && r.studentCode && <span className="text-[13px] text-muted-foreground">{L('رقم', 'ID')} {r.studentCode}</span>}
                        {r.ok && r.needsReview && <Badge className="bg-warning/100/15 text-warning">{L('مراجعة', 'review')}</Badge>}
                        {r.ok === false && <span className="truncate text-[13px] text-destructive">{r.error}</span>}
                        {r.ok === false && (
                          <Button size="sm" variant="outline" className="h-6 shrink-0 gap-1 px-2 text-[13px]" onClick={() => void retryRow(r)}>
                            <RefreshCcw className="h-3 w-3" /> {L('إعادة', 'Retry')}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 p-3">
                <div className="text-[13px] text-muted-foreground">
                  {L('كل ورقة تُقرأ وتُصحح وتُحفظ تلقائيًا — الأوراق الملتبسة تنتقل لقائمة المراجعة.', 'Every sheet is read, graded and saved automatically — ambiguous sheets go to the Review Queue.')}
                </div>
                <Button size="sm" className="gap-1 border-0 text-[13px] text-white" onClick={() => goStep('results')}>
                  {L('التالي: النتائج', 'Next: results')} <ForwardIcon className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ================= STEP 5 — RESULTS ================= */}
      {step === 'results' && (
        <div className="space-y-4">
          <TipBanner tip={tipFor('results', lang)} lang={lang} />
          {scansLoading ? (
            <Card><CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> {L('جارٍ تحميل النتائج…', 'Loading results…')}
            </CardContent></Card>
          ) : scans.length === 0 ? (
            <EmptyState
              icon={ScanLine}
              title={L('لا توجد أوراق ممسوحة لهذا الامتحان بعد', 'No scanned sheets for this exam yet')}
              hint={L('ارفع الأوراق من خطوة «المسح» وستظهر النتائج هنا فورًا.', 'Upload sheets in the "Scan" step and results will appear here instantly.')}
            >
              <Button size="sm" className="gap-1 border-0 text-white" onClick={() => goStep('scan')}>
                <Upload className="h-3.5 w-3.5" /> {L('الانتقال للمسح', 'Go to scanning')}
              </Button>
            </EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard icon={ScanLine} label={L('ورقة مقروءة', 'sheets read')} value={fmtNum(scans.length)} />
                <StatCard icon={ClipboardList} label={L('متوسط الدرجات', 'average score')} value={avgPercent !== null ? `${fmtNum(avgPercent)}%` : '—'} tone="emerald" />
                <StatCard icon={AlertTriangle} label={L('تحتاج مراجعة', 'need review')} value={fmtNum(reviewCount)} tone={reviewCount > 0 ? 'gold' : 'neutral'} />
                <StatCard icon={XCircle} label={L('فشل القراءة', 'failed')} value={fmtNum(failedCount)} tone={failedCount > 0 ? 'red' : 'neutral'} />
              </div>

              {avgPercent !== null && (
                <Card>
                  <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4 text-[13px]">
                    <span>
                      {L('دقة التقييم الإجمالية:', 'Overall class result:')} <b className="text-success">{fmtNum(avgPercent)}%</b>
                      {' '}({bestPercent !== null && <>{L('أعلى نتيجة', 'best')} <b>{fmtNum(bestPercent)}%</b>، </>}{L(`على ${fmtNum(graded.length)} ورقة مصححة من ${fmtNum(scans.length)}`, `across ${fmtNum(graded.length)} graded of ${fmtNum(scans.length)} sheets`)})
                    </span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-[13px]" onClick={() => { if (examId) void loadScans(examId); }}>
                        <RefreshCcw className="h-3.5 w-3.5" /> {L('تحديث', 'Refresh')}
                      </Button>
                      <a href={`/api/scans/export?examId=${encodeURIComponent(examId ?? '')}`} download>
                        <Button size="sm" variant="outline" className="h-8 gap-1 text-[13px]">
                          <FileSpreadsheet className="h-3.5 w-3.5" /> {L('تصدير CSV', 'Export CSV')}
                        </Button>
                      </a>
                      <Button size="sm" className="h-8 gap-1 border-0 text-[13px] text-white" onClick={() => onGoView('review', examId)}>
                        <ClipboardList className="h-3.5 w-3.5" /> {L('قائمة المراجعة', 'Review queue')}
                        {reviewCount > 0 && <Badge className="ms-1 bg-card/95 px-1.5">{fmtNum(reviewCount)}</Badge>}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="p-0">
                  <div className="max-h-96 overflow-y-auto omr-key-scroll">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                        <tr className="text-start text-[13px] text-muted-foreground">
                          <th className="p-3 text-start">#</th>
                          <th className="p-3 text-start">{L('الطالب', 'Student')}</th>
                          <th className="p-3 text-start">{L('النتيجة', 'Score')}</th>
                          <th className="p-3 text-start">{L('النسبة', 'Percent')}</th>
                          <th className="p-3 text-start">{L('الثقة', 'Confidence')}</th>
                          <th className="p-3 text-start">{L('الحالة', 'Status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scans.map((s, i) => (
                          <tr key={s.id} className="border-b last:border-0">
                            <td className="p-3 text-[13px] text-muted-foreground">{fmtNum(i + 1)}</td>
                            <td className="p-3 font-mono text-[13px]">{s.studentCode ?? '—'}</td>
                            <td className="p-3 text-[13px] font-bold">{s.score != null ? `${fmtNum(s.score)} / ${fmtNum(s.maxScore ?? 0)}` : '—'}</td>
                            <td className="p-3 text-[13px]">
                              {s.percent != null ? (
                                <span className={s.percent >= 50 ? 'font-bold text-success' : 'font-bold text-destructive'}>{fmtNum(Math.round(s.percent))}%</span>
                              ) : '—'}
                            </td>
                            <td className="p-3 text-[13px]">{fmtNum(Math.round((s.overallConfidence ?? 0) * 100))}%</td>
                            <td className="p-3">
                              <div className="flex flex-wrap gap-1">
                                {s.status === 'FAILED' ? (
                                  <Badge className="bg-destructive/100/15 text-destructive">{L('فاشلة', 'failed')}</Badge>
                                ) : s.needsReview ? (
                                  <Badge className="bg-warning/100/15 text-warning">{L('مراجعة', 'review')}</Badge>
                                ) : (
                                  <Badge className="bg-success/100/15 text-success">{L('مقبولة', 'approved')}</Badge>
                                )}
                                {s.ambiguousCount > 0 && <Badge className="bg-warning/100/15 text-warning">{L('التباس', 'ambig.')} {fmtNum(s.ambiguousCount)}</Badge>}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}

      {/* ================= tutorial dialog ================= */}
      <Dialog open={tutOpen} onOpenChange={(o) => (o ? setTutOpen(true) : closeTutorial())}>
        <DialogContent className="max-w-lg" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-start">
              {(() => {
                const s = TUTORIAL_SLIDES[tutSlide];
                return (
                  <>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink text-white">
                      <s.icon className="h-4.5 w-4.5" />
                    </span>
                    <span className="min-w-0">{lang === 'ar' ? s.ar.title : s.en.title}</span>
                  </>
                );
              })()}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-start">
                {TUTORIAL_SLIDES[tutSlide][lang].lines.map((line, i) => (
                  <p key={i} className="text-[13px] leading-relaxed text-muted-foreground">{line}</p>
                ))}
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-1.5">
              {TUTORIAL_SLIDES.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`${L('شريحة', 'Slide')} ${i + 1}`}
                  onClick={() => setTutSlide(i)}
                  className={`h-1.5 rounded-full transition-all ${i === tutSlide ? 'w-5 bg-primary' : 'w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'}`}
                />
              ))}
            </div>
            <div className="flex gap-2">
              {tutSlide > 0 && (
                <Button size="sm" variant="outline" className="gap-1 text-[13px]" onClick={() => setTutSlide((s) => s - 1)}>
                  <BackIcon className="h-3.5 w-3.5" /> {L('السابق', 'Back')}
                </Button>
              )}
              {tutSlide < TUTORIAL_SLIDES.length - 1 ? (
                <Button size="sm" className="gap-1 border-0 text-[13px] text-white" onClick={() => setTutSlide((s) => s + 1)}>
                  {L('التالي', 'Next')} <ForwardIcon className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button size="sm" className="gap-1 border-0 text-[13px] text-white" onClick={closeTutorial}>
                  <Sparkles className="h-3.5 w-3.5" /> {L('ابدأ الآن', 'Start now')}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------- inline tip banner ----------------

function TipBanner({ tip, lang }: { tip: string | null; lang: 'ar' | 'en' }) {
  void lang;
  if (!tip) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-warning/40/30 bg-warning/100/10 p-3 text-[13px] leading-relaxed text-warning dark:text-warning">
      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{tip}</span>
    </div>
  );
}
