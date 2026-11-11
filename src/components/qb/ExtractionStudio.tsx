'use client';

// ============================================================
// ALNOKHBA QB — Smart Extraction Studio
// Upload PDF/images → render pages → VLM extraction (server) →
// human review with confidence indicators → import to the bank.
// Extraction results are NEVER auto-published (review mandatory).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import {
  BadgeCheck, CheckCheck, FileText, Image as ImageIcon, Loader2, RefreshCw,
  ScanText, Sparkles, ThumbsDown, ThumbsUp, TriangleAlert, UploadCloud, X,
} from 'lucide-react';

interface SourcePage {
  page: number;
  dataUrl: string;
  selected: boolean;
}
interface SourceFile {
  file: File | null;
  kind: 'pdf' | 'image';
}

interface Candidate {
  id: string;
  page: number | null;
  type: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctAnswer: string | null;
  explanation: string | null;
  difficulty: string;
  marks: number;
  confidence: number;
  status: string;
  questionId?: string | null;
}

interface JobInfo {
  id: string;
  status: string;
  questionCount: number;
  error: string | null;
  createdAt: string;
  document?: { filename: string | null; pageCount: number | null } | null;
}

const MAX_PAGES = 10;

export default function ExtractionStudio({ onGoToBank }: { onGoToBank?: () => void }) {
  const [source, setSource] = useState<SourceFile | null>(null);
  const [pages, setPages] = useState<SourcePage[]>([]);
  const [language, setLanguage] = useState<'auto' | 'ara' | 'eng'>('auto');
  const [preparing, setPreparing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [job, setJob] = useState<JobInfo | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadingJob, setLoadingJob] = useState(false);

  const [defaults, setDefaults] = useState({ subject: '', chapter: '', topic: '' });
  const [taxonomy, setTaxonomy] = useState<Array<{ id: string; kind: string; name: string }>>([]);
  const [importing, setImporting] = useState(false);
  const [jobsHistory, setJobsHistory] = useState<JobInfo[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadTaxonomy = useCallback(async () => {
    try {
      const res = await fetch('/api/taxonomy');
      if (res.ok) {
        const data = await res.json();
        setTaxonomy(data.terms ?? []);
      }
    } catch { /* optional */ }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/extract?limit=8');
      if (res.ok) {
        const data = await res.json();
        setJobsHistory(data.jobs ?? []);
      }
    } catch { /* optional */ }
  }, []);

  useEffect(() => {
    void loadTaxonomy();
    void loadHistory();
  }, [loadTaxonomy, loadHistory]);

  // ---------- source preparation ----------

  const pdfToPages = async (file: File): Promise<SourcePage[]> => {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const total = Math.min(doc.numPages, MAX_PAGES);
    if (doc.numPages > MAX_PAGES) {
      toast.info(`المستند يحتوي ${doc.numPages} صفحة — ستُعالج أول ${MAX_PAGES} صفحات في هذه الدفعة`);
    }
    const out: SourcePage[] = [];
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      await page.render({ canvas, canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]).promise;
      out.push({ page: i, dataUrl: canvas.toDataURL('image/jpeg', 0.85), selected: true });
    }
    return out;
  };

  const imageToPage = async (file: File): Promise<SourcePage[]> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('read-failed'));
      reader.readAsDataURL(file);
    });
    return [{ page: 1, dataUrl, selected: true }];
  };

  const prepareSource = async (file: File) => {
    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');
    if (!isPdf && !isImage) {
      toast.error('الملفات المدعومة: PDF أو صور (PNG / JPG / WEBP)');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error('حجم الملف يتجاوز ٢٠ ميجابايت');
      return;
    }
    setPreparing(true);
    setSource({ file, kind: isPdf ? 'pdf' : 'image' });
    setJob(null);
    setCandidates([]);
    setDocumentId(null);
    setProgress(0);
    try {
      const prepared = isPdf ? await pdfToPages(file) : await imageToPage(file);
      setPages(prepared);
      // upload the ORIGINAL file for source tracking
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('pageCount', String(isPdf ? prepared.length : 1));
        const up = await fetch('/api/documents', { method: 'POST', body: form });
        if (up.ok) {
          const d = await up.json();
          setDocumentId(d.id);
        }
      } catch { /* upload failure does not block extraction */ }
    } catch {
      toast.error('تعذر قراءة الملف — تأكد أنه سليم وغير محمي بكلمة مرور');
      setSource(null);
      setPages([]);
    } finally {
      setPreparing(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void prepareSource(f);
  };

  // ---------- extraction ----------

  const extract = async () => {
    const selected = pages.filter((p) => p.selected);
    if (selected.length === 0) {
      toast.error('حدد صفحة واحدة على الأقل');
      return;
    }
    setExtracting(true);
    setProgress(8);
    const timer = setInterval(() => setProgress((p) => Math.min(p + 4, 92)), 1500);
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: documentId ?? undefined,
          filename: source?.file?.name,
          mimeType: source?.file?.type,
          language,
          pages: selected.map((p) => ({ page: p.page, dataUrl: p.dataUrl })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'فشل الاستخراج');
        return;
      }
      setProgress(100);
      toast.success(`اكتمل الاستخراج — ${data.questionCount} سؤالًا مرشحًا بانتظار المراجعة`);
      await openJob(data.jobId);
      void loadHistory();
    } catch {
      toast.error('تعذر الاتصال بالخادم أثناء الاستخراج');
    } finally {
      clearInterval(timer);
      setExtracting(false);
    }
  };

  const openJob = async (jobId: string) => {
    setLoadingJob(true);
    try {
      const res = await fetch(`/api/extract/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'تعذر تحميل المهمة');
        return;
      }
      setJob(data.job);
      setCandidates(data.questions ?? []);
    } finally {
      setLoadingJob(false);
    }
  };

  // ---------- candidate edits ----------

  const patchCandidate = async (id: string, patch: Record<string, unknown>) => {
    if (!job) return;
    setCandidates((cs) => cs.map((c) => (c.id === id ? { ...c, ...(patch as Partial<Candidate>), status: (patch.status as Candidate['status']) ?? 'accepted' } : c)));
    try {
      const res = await fetch(`/api/extract/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? 'تعذر حفظ التعديل');
      }
    } catch {
      toast.error('تعذر حفظ التعديل — تحقق من الاتصال');
    }
  };

  const importSelected = async () => {
    if (!job) return;
    const ids = candidates.filter((c) => c.status !== 'rejected').map((c) => c.id);
    if (ids.length === 0) {
      toast.error('لا توجد أسئلة محددة للاستيراد');
      return;
    }
    setImporting(true);
    try {
      const res = await fetch(`/api/extract/${job.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          defaults: {
            subject: defaults.subject || null,
            chapter: defaults.chapter || null,
            topic: defaults.topic || null,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'فشل الاستيراد');
        return;
      }
      toast.success(`تم استيراد ${data.imported} سؤالًا إلى البنك${data.duplicates ? ` — تم تخطي ${data.duplicates} مكرر` : ''}`);
      if (data.imported > 0 && onGoToBank) {
        setTimeout(() => onGoToBank(), 900);
      }
      await openJob(job.id);
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setImporting(false);
    }
  };

  const pending = candidates.filter((c) => c.status !== 'rejected');
  const needsReview = candidates.filter((c) => c.confidence < 0.7 && c.status !== 'rejected').length;

  const termsOf = (kind: string) => taxonomy.filter((t) => t.kind === kind).map((t) => t.name);

  return (
    <div className="space-y-5" dir="rtl">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-extrabold text-slate-800">
            <ScanText className="h-5 w-5 text-emerald-600" /> الاستخراج الذكي للأسئلة
          </h2>
          <p className="text-xs text-slate-500">ارفع ملف PDF أو صورة ممسوحة → الذكاء الاصطناعي يستخرج الأسئلة → راجعها وعدّلها ثم استوردها للبنك</p>
        </div>
        <Badge variant="outline" className="gap-1 border-emerald-300 bg-emerald-50 text-emerald-700">
          <Sparkles className="h-3 w-3" /> نموذج رؤية VLM — عربي/إنجليزي
        </Badge>
      </div>

      {/* step 1: source */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${dragOver ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50/60 hover:border-emerald-400 hover:bg-emerald-50/40'}`}
            role="button"
            aria-label="رفع ملف للاستخراج"
          >
            {preparing ? <Loader2 className="h-8 w-8 animate-spin text-emerald-600" /> : <UploadCloud className="h-8 w-8 text-emerald-600" />}
            <div className="text-sm font-bold text-slate-700">{preparing ? 'جارٍ تحضير الصفحات…' : 'اسحب ملف PDF أو صورة هنا أو انقر للاختيار'}</div>
            <div className="text-[11px] text-slate-400">حتى {MAX_PAGES} صفحات في الدفعة • حتى ٢٠ ميجابايت • عربي/إنجليزي</div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void prepareSource(f);
                e.target.value = '';
              }}
            />
          </div>

          {source && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              {source.kind === 'pdf' ? <FileText className="h-4 w-4 text-emerald-600" /> : <ImageIcon className="h-4 w-4 text-emerald-600" />}
              <span className="max-w-[240px] truncate font-medium">{source.file?.name}</span>
              <Badge variant="secondary">{pages.length} صفحة</Badge>
              <Button size="sm" variant="ghost" className="h-7 text-slate-400" onClick={() => { setSource(null); setPages([]); setJob(null); setCandidates([]); }}>
                <X className="h-3.5 w-3.5" /> إزالة
              </Button>
            </div>
          )}

          {pages.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-slate-600">الصفحات المحددة للاستخراج</div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setPages((ps) => ps.map((p) => ({ ...p, selected: true })))}>تحديد الكل</Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setPages((ps) => ps.map((p) => ({ ...p, selected: false })))}>إلغاء الكل</Button>
                </div>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
                {pages.map((p) => (
                  <label key={p.page} className={`relative min-w-[92px] cursor-pointer rounded-lg border-2 p-1 transition ${p.selected ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 opacity-60'}`}>
                    <img src={p.dataUrl} alt={`صفحة ${p.page}`} className="h-28 w-full rounded object-cover" />
                    <div className="mt-1 flex items-center justify-center gap-1 text-[10px] font-bold text-slate-500">
                      <Checkbox checked={p.selected} onCheckedChange={(v) => setPages((ps) => ps.map((x) => (x.page === p.page ? { ...x, selected: v === true } : x)))} aria-label={`تحديد صفحة ${p.page}`} />
                      صفحة {p.page}
                    </div>
                  </label>
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div className="w-40 space-y-1">
                  <Label className="text-xs">لغة المستند</Label>
                  <Select value={language} onValueChange={(v) => setLanguage(v as typeof language)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">تلقائي (عربي/إنجليزي)</SelectItem>
                      <SelectItem value="ara">عربي</SelectItem>
                      <SelectItem value="eng">إنجليزي</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={extracting || preparing} onClick={() => void extract()}>
                  {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanText className="h-4 w-4" />}
                  {extracting ? 'جارٍ الاستخراج…' : 'بدء الاستخراج الذكي'}
                </Button>
              </div>
              {extracting && <Progress value={progress} className="h-2" />}
            </>
          )}
        </CardContent>
      </Card>

      {/* step 2: review */}
      {(job || loadingJob) && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-700">
                <BadgeCheck className="h-4 w-4 text-emerald-600" /> مراجعة الأسئلة المستخرجة
                {job && <Badge variant="secondary" className="text-[10px]">{candidates.length} مرشح</Badge>}
                {needsReview > 0 && (
                  <Badge variant="outline" className="gap-1 border-amber-300 bg-amber-50 text-[10px] text-amber-700">
                    <TriangleAlert className="h-3 w-3" /> {needsReview} بثقة منخفضة
                  </Badge>
                )}
              </h3>
              {job?.document?.filename && <span className="text-[11px] text-slate-400">المصدر: {job.document.filename}</span>}
            </div>

            {/* import defaults */}
            <div className="grid grid-cols-1 gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-[11px] text-slate-500">المادة (تُطبق عند الاستيراد)</Label>
                <Input list="tax-subjects" className="h-8 text-xs" value={defaults.subject} onChange={(e) => setDefaults((d) => ({ ...d, subject: e.target.value }))} placeholder="مثال: الرياضيات" />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-slate-500">الفصل / الوحدة</Label>
                <Input list="tax-chapters" className="h-8 text-xs" value={defaults.chapter} onChange={(e) => setDefaults((d) => ({ ...d, chapter: e.target.value }))} placeholder="مثال: الجبر والمعادلات" />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-slate-500">الدرس / الموضوع</Label>
                <Input list="tax-lessons" className="h-8 text-xs" value={defaults.topic} onChange={(e) => setDefaults((d) => ({ ...d, topic: e.target.value }))} />
              </div>
              <datalist id="tax-subjects">{termsOf('subject').map((n) => <option key={n} value={n} />)}</datalist>
              <datalist id="tax-chapters">{termsOf('unit').map((n) => <option key={n} value={n} />)}</datalist>
              <datalist id="tax-lessons">{termsOf('lesson').map((n) => <option key={n} value={n} />)}</datalist>
            </div>

            {loadingJob ? (
              <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : candidates.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
                لم يُعثر على أسئلة في الصفحات المحددة — جرّب جودة صورة أعلى أو صفحات أخرى
              </div>
            ) : (
              <div className="max-h-[32rem] space-y-3 overflow-y-auto pl-1" style={{ scrollbarWidth: 'thin' }}>
                {candidates.map((c, idx) => (
                  <CandidateCard
                    key={c.id}
                    index={idx}
                    candidate={c}
                    onPatch={patchCandidate}
                    disabled={extracting || importing}
                  />
                ))}
              </div>
            )}

            {candidates.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <div className="text-xs text-slate-500">{pending.length} سؤالًا سيُستورد (المرفوض مستثنى • التكرار يُكتشف تلقائيًا)</div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    disabled={importing}
                    onClick={() => setCandidates((cs) => cs.map((c) => (c.status === 'pending' ? { ...c, status: 'accepted' } : c)))}
                  >
                    <CheckCheck className="h-4 w-4 text-emerald-600" /> قبول الكل
                  </Button>
                  <Button className="gap-1 bg-emerald-600 hover:bg-emerald-700" disabled={importing || pending.length === 0} onClick={() => void importSelected()}>
                    {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
                    استيراد {pending.length} إلى بنك الأسئلة
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* step 3: history */}
      {jobsHistory.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-extrabold text-slate-700"><RefreshCw className="h-4 w-4 text-emerald-600" /> مهام سابقة</h3>
            <div className="max-h-52 space-y-2 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {jobsHistory.map((j) => (
                <button key={j.id} onClick={() => void openJob(j.id)} className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-right text-xs transition hover:bg-slate-50">
                  <Badge variant={j.status === 'failed' ? 'destructive' : j.status === 'completed' ? 'secondary' : 'outline'} className="text-[10px]">
                    {j.status === 'review' ? 'بانتظار المراجعة' : j.status === 'completed' ? 'مكتملة' : j.status === 'failed' ? 'فاشلة' : j.status === 'processing' ? 'قيد المعالجة' : j.status}
                  </Badge>
                  <span className="max-w-[200px] truncate font-medium text-slate-600">{j.document?.filename ?? 'بدون ملف'}</span>
                  <span className="text-slate-400">{j.questionCount} سؤال</span>
                  <span className="mr-auto text-[10px] text-slate-300">{new Date(j.createdAt).toLocaleString('ar')}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* empty state */}
      {!source && !job && jobsHistory.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ScanText className="h-10 w-10 text-slate-200" />
            <p className="text-sm font-bold text-slate-500">ابدأ برفع ورقة امتحان أو ملزمة ممسوحة ضوئيًا</p>
            <p className="max-w-md text-xs text-slate-400">
              يدعم النظام الأسئلة الاختيارية من متعدد وصح/خطأ والأسئلة المقالية، مع مؤشر ثقة لكل سؤال —
              لا يُضاف أي سؤال للبنك دون مراجعتك وتأكيدك.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------- candidate card ----------------

function CandidateCard({
  index,
  candidate: c,
  onPatch,
  disabled,
}: {
  index: number;
  candidate: Candidate;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<void>;
  disabled: boolean;
}) {
  const [prompt, setPrompt] = useState(c.prompt);
  const [options, setOptions] = useState(c.options);
  const [correct, setCorrect] = useState(c.correctAnswer);
  const [explanation, setExplanation] = useState(c.explanation ?? '');
  const dirty = prompt !== c.prompt || JSON.stringify(options) !== JSON.stringify(c.options) || correct !== c.correctAnswer || explanation !== (c.explanation ?? '');

  const conf = c.confidence;
  const confBadge = conf >= 0.8
    ? { cls: 'border-emerald-300 bg-emerald-50 text-emerald-700', label: `ثقة ${Math.round(conf * 100)}%` }
    : conf >= 0.7
      ? { cls: 'border-teal-300 bg-teal-50 text-teal-700', label: `ثقة ${Math.round(conf * 100)}%` }
      : { cls: 'border-amber-400 bg-amber-50 text-amber-700', label: `ثقة منخفضة ${Math.round(conf * 100)}%` };

  const rejected = c.status === 'rejected';

  return (
    <div className={`rounded-xl border p-3 transition ${rejected ? 'border-slate-100 bg-slate-50/60 opacity-60' : dirty ? 'border-emerald-300 bg-emerald-50/30' : 'border-slate-200'}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-[11px] font-black text-slate-500">{index + 1}</span>
        <Badge variant="outline" className={confBadge.cls}>{confBadge.label}</Badge>
        {c.page != null && <Badge variant="secondary" className="text-[10px]">صفحة {c.page}</Badge>}
        <Badge variant="secondary" className="text-[10px]">{c.type === 'mcq' ? 'اختيار متعدد' : c.type === 'truefalse' ? 'صح/خطأ' : 'مقالي'}</Badge>
        {dirty && <Badge className="bg-emerald-600 text-[10px]">معدّل</Badge>}
        {c.questionId && <Badge variant="outline" className="text-[10px] text-emerald-600">مستورد ✓</Badge>}

        <div className="mr-auto flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={disabled || rejected} onClick={() => void onPatch(c.id, { status: 'accepted' })}>
            <ThumbsUp className="h-3 w-3 text-emerald-600" /> قبول
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px] text-slate-400" disabled={disabled || rejected}>
                <ThumbsDown className="h-3 w-3" /> رفض
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent dir="rtl">
              <AlertDialogHeader>
                <AlertDialogTitle>رفض هذا السؤال؟</AlertDialogTitle>
                <AlertDialogDescription>لن يُستورد إلى بنك الأسئلة وسيُستثنى من العدّ.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>إلغاء</AlertDialogCancel>
                <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => void onPatch(c.id, { status: 'rejected' })}>رفض السؤال</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <Textarea
        className="mb-2 min-h-[60px] resize-y bg-white text-sm"
        value={prompt}
        disabled={rejected}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={() => prompt !== c.prompt && prompt.trim() && void onPatch(c.id, { prompt: prompt.trim() })}
        aria-label="نص السؤال"
      />

      {c.type === 'mcq' && options.length > 0 && (
        <div className="mb-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {options.map((o) => (
            <div key={o.id} className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 ${correct === o.id ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
              <button
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black transition ${correct === o.id ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                title="تعيين كإجابة صحيحة"
                aria-label={`تعيين ${o.id} كإجابة صحيحة`}
                disabled={rejected}
                onClick={() => { setCorrect(o.id); void onPatch(c.id, { correctAnswer: o.id }); }}
              >
                {o.id}
              </button>
              <input
                className="w-full bg-transparent text-xs outline-none"
                value={o.text}
                disabled={rejected}
                onChange={(e) => setOptions((os) => os.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)))}
                onBlur={() => {
                  void onPatch(c.id, { options });
                }}
                aria-label={`نص الخيار ${o.id}`}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-7 w-52 text-[11px]" placeholder="شرح الإجابة (اختياري)" value={explanation} disabled={rejected} onChange={(e) => setExplanation(e.target.value)} onBlur={() => explanation !== (c.explanation ?? '') && void onPatch(c.id, { explanation: explanation || null })} />
        <Select value={c.difficulty} onValueChange={(v) => void onPatch(c.id, { difficulty: v })} disabled={rejected}>
          <SelectTrigger className="h-7 w-28 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="easy">سهل</SelectItem>
            <SelectItem value="medium">متوسط</SelectItem>
            <SelectItem value="hard">صعب</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(c.marks)} onValueChange={(v) => void onPatch(c.id, { marks: parseInt(v, 10) })} disabled={rejected}>
          <SelectTrigger className="h-7 w-24 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 5, 10].map((m) => <SelectItem key={m} value={String(m)}>{m} درجات</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
