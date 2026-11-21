'use client';

// ============================================================
// ALNOKHBA QB — Text extraction (OCR) — PHASE 8, general-text first
// أي صورة/PDF → نص كامل قابل للتعديل والنسخ والتنزيل (كلام عام،
// ليس أسئلة فقط). القراءة الأساسية تعمل داخل المتصفح (tesseract.js
// + WASM) بدون أي مفاتيح، ولو فشلت نحاول محركات الخادم (/api/ocr:
// Tesseract على محرك OMR ثم نموذج رؤية بديل).
// تحويل النص إلى أسئلة (امتحان/بنك) خطوة اختيارية منفصلة.
// ============================================================

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage, prepareUpload } from '@/lib/image/prepareUpload';
import { ocrImageInBrowser, type ClientOcrLang } from '@/lib/qb/ocr/browser-ocr';
import {
  ChevronDown, ChevronUp, Copy, Download, FileInput, ImageIcon, ListPlus,
  Loader2, RotateCcw, ScanText,
} from 'lucide-react';

/** Same rule as the server parser: a numbered line starts a new question. */
const NUMBERED_LINE_RE = /^[\d\u0660-\u0669]+[\.\)\-]/;

const LANG_LABEL: Record<ClientOcrLang, string> = {
  ara: 'العربية',
  eng: 'English',
  'ara+eng': 'عربي + English',
};

export default function OcrImport({ onCreated }: { onCreated: (examId: string) => void }) {
  const [lang, setLang] = useState<ClientOcrLang>('ara');
  const [target, setTarget] = useState<'exam' | 'bank'>('exam');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [engine, setEngine] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [ocrPct, setOcrPct] = useState<number | null>(null);
  const [ocrStage, setOcrStage] = useState('');
  const [showQuestions, setShowQuestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const detectedCount = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => NUMBERED_LINE_RE.test(l)).length;

  const setProgress = (pct: number | null, stage = '') => {
    setOcrPct(pct);
    setOcrStage(stage);
  };

  /** Server fallback: same engine chain as before (OMR Tesseract → vision model). */
  const serverOcr = async (dataUrl: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: dataUrl, lang: lang === 'ara+eng' ? 'ara' : lang }),
      });
      const d = (await res.json().catch(() => null)) as
        | { ok?: boolean; text?: string; error?: string; details?: string; engine?: string }
        | null;
      if (!res.ok || !d?.ok || !d.text?.trim()) return null;
      setEngine(d.engine === 'vlm' ? 'نموذج رؤية — الخادم' : 'Tesseract — الخادم');
      return d.text;
    } catch {
      return null;
    }
  };

  const extract = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      toast.error('حجم الملف كبير جدًا (الحد 25 ميجابايت)');
      return;
    }
    setOcrBusy(true);
    setEngine(null);
    setText('');
    setProgress(0, 'جارٍ التجهيز…');
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

      if (isPdf) {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        if (pdf.numPages > 30) throw new Error('الحد الأقصى لمعالجة الملف هو 30 صفحة');

        const pageTexts: string[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          setProgress(Math.round((pageNumber / pdf.numPages) * 100), `معالجة الصفحة ${pageNumber} من ${pdf.numPages}…`);
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const embeddedText = content.items
            .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
            .join('')
            .trim();

          if (embeddedText.length >= 20) {
            pageTexts.push(embeddedText);
            await page.cleanup();
            continue;
          }

          // No useful text layer: render → in-browser OCR → server fallback.
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(2, 1800 / baseViewport.width);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('تعذر تجهيز صفحة PDF للتحليل');
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          const pageImage = canvas.toDataURL('image/jpeg', 0.9);
          if (pageNumber === 1) setImagePreview(pageImage);

          let pageOcr = '';
          try {
            pageOcr = await ocrImageInBrowser(canvas, lang, (pct, stage) =>
              setProgress(Math.round(((pageNumber - 1 + pct / 100) / pdf.numPages) * 100), stage)
            );
          } catch {
            pageOcr = '';
          }
          if (!pageOcr) pageOcr = (await serverOcr(pageImage)) ?? '';
          pageTexts.push(pageOcr);
          canvas.width = 0;
          canvas.height = 0;
          await page.cleanup();
        }
        const extracted = pageTexts.filter(Boolean).join('\n\n').trim();
        if (!extracted) throw new Error('لم يُستخرج أي نص — جرّب صورة أوضح أو ملفًا نصيًا');
        setText(extracted);
        setEngine('PDF');
        setProgress(null);
        toast.success(`تم استخراج النص من ${pdf.numPages} صفحة`);
        return;
      }

      // Image: downscale for a sane working size, then in-browser OCR.
      const prepared = await prepareUpload(file);
      setImagePreview(prepared.dataUrl);
      setProgress(2, 'تحميل بيانات اللغة (أول مرة فقط)…');

      let extracted = '';
      try {
        extracted = await ocrImageInBrowser(prepared.dataUrl, lang, (pct, stage) =>
          setProgress(Math.max(2, pct), stage)
        );
        if (extracted) setEngine('Tesseract — داخل المتصفح');
      } catch {
        extracted = '';
      }
      if (!extracted) {
        setProgress(50, 'الاستعانة بمحرك الخادم…');
        extracted = (await serverOcr(prepared.dataUrl)) ?? '';
      }
      if (!extracted) {
        throw new Error('لم يُستخرج أي نص — جرّب صورة أوضح وبجودة أعلى');
      }
      setText(extracted);
      setProgress(null);
      toast.success('تم استخراج النص — راجعه وعدّله إن لزم');
    } catch (err) {
      setProgress(null);
      toast.error(err instanceof Error ? err.message : 'تعذر الاتصال بخدمة OCR');
    } finally {
      setOcrBusy(false);
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('تم نسخ النص');
    } catch {
      toast.error('تعذر النسخ — حدد النص وانسخه يدويًا');
    }
  };

  const downloadText = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.trim() || 'نص-مستخرج'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importContent = async () => {
    if (text.trim().length < 3) {
      toast.error('النص قصير جدًا — الصق أو استخرج النص أولًا');
      return;
    }
    setImportBusy(true);
    try {
      const res = await fetch('/api/ocr/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, title: title.trim() || undefined, target }),
      });
      const d = (await res.json()) as {
        target?: string;
        examId?: string;
        questionCount?: number;
        bankCreated?: number;
        error?: string;
      };
      if (!res.ok) {
        toast.error(d.error ?? 'فشل استيراد الأسئلة');
        return;
      }
      if (d.target === 'bank') {
        toast.success(
          `أُضيف ${d.bankCreated ?? 0} سؤال إلى البنك بحالة "بحاجة لمراجعة" — راجعها واضبط المفاتيح من بنك الأسئلة`
        );
        return;
      }
      if (!d.examId) {
        toast.error(d.error ?? 'فشل استيراد الأسئلة');
        return;
      }
      toast.success(`تم إنشاء الامتحان مع ${d.questionCount ?? 0} سؤال — أكمل الخيارات ومفتاح الإجابة في المصمم`);
      onCreated(d.examId);
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <div className="space-y-4" dir="rtl">
      {/* Step 1 — image/PDF → general text */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanText className="h-5 w-5 text-success" /> استخراج النص (OCR)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-muted-foreground">لغة النص:</span>
            <Select value={lang} onValueChange={(v) => setLang(v as ClientOcrLang)}>
              <SelectTrigger className="h-8 w-44 text-[13px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ara">العربية</SelectItem>
                <SelectItem value="eng">English</SelectItem>
                <SelectItem value="ara+eng">عربي + English</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-[12px] text-muted-foreground">القراءة تعمل داخل متصفحك — الملف لا يُرفع إلا عند الحاجة لمحرك الخادم.</span>
          </div>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void extract(f);
            }}
            onClick={() => !ocrBusy && inputRef.current?.click()}
            className={`flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-success/40 bg-success/5 p-5 text-center transition hover:bg-success/10 ${ocrBusy ? 'cursor-wait opacity-70' : 'cursor-pointer'}`}
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/*,.pdf,application/pdf"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void extract(f);
                e.target.value = '';
              }}
            />
            {ocrBusy ? <Loader2 className="h-7 w-7 animate-spin text-success" /> : <ImageIcon className="h-7 w-7 text-success" />}
            <div className="text-sm font-medium text-success">اسحب صورة أو PDF هنا، أو اضغط للاختيار</div>
            <div className="text-[13px] text-muted-foreground">
              يُستخرج كل النص المكتوب (عربي أو إنجليزي) — ملحوظات، رسائل، وصف، أسئلة… أي كلام.
            </div>
          </div>

          {ocrBusy && ocrPct !== null && (
            <div className="space-y-1.5" aria-live="polite">
              <div className="flex justify-between text-[13px] text-muted-foreground">
                <span>{ocrStage || 'جارٍ المعالجة…'}</span>
                <span className="tabular-nums">{ocrPct}%</span>
              </div>
              <Progress value={ocrPct} className="h-2" />
            </div>
          )}

          {imagePreview && !ocrBusy && (
            <img src={imagePreview} alt="معاينة الملف" className="max-h-40 w-full rounded-lg border object-contain" />
          )}
          {engine && !ocrBusy && (
            <Badge className="bg-success/10 text-success">المحرك: {engine}</Badge>
          )}

          {text.trim().length > 0 && !ocrBusy && (
            <div className="space-y-2">
              <Textarea
                className="max-h-96 min-h-56 overflow-y-auto text-[13px] leading-relaxed"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="النص المستخرج"
                placeholder="النص المستخرج يظهر هنا…"
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="h-8 gap-1 text-[13px]" onClick={() => void copyText()}>
                  <Copy className="h-3.5 w-3.5" /> نسخ النص
                </Button>
                <Button variant="outline" size="sm" className="h-8 gap-1 text-[13px]" onClick={downloadText}>
                  <Download className="h-3.5 w-3.5" /> تنزيل ملف نصي
                </Button>
                <Button variant="ghost" size="sm" className="h-8 gap-1 text-[13px]" onClick={() => { setText(''); setImagePreview(null); setEngine(null); }}>
                  <RotateCcw className="h-3.5 w-3.5" /> مسح
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 2 — optional: turn text into questions */}
      <Card className={text.trim().length < 3 ? 'opacity-90' : ''}>
        <CardHeader className="pb-2">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 text-start"
            onClick={() => setShowQuestions((v) => !v)}
            aria-expanded={showQuestions}
          >
            <CardTitle className="flex items-center gap-2 text-base">
              <ListPlus className="h-5 w-5 text-success" /> تحويل النص إلى أسئلة
              <span className="text-[13px] font-normal text-muted-foreground">— اختياري: للاستيراد إلى امتحان أو بنك الأسئلة</span>
            </CardTitle>
            {showQuestions ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CardHeader>
        {showQuestions && (
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-[13px]">الوجهة</Label>
                <Select value={target} onValueChange={(v) => setTarget(v === 'bank' ? 'bank' : 'exam')}>
                  <SelectTrigger className="h-9 text-[13px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="exam">امتحان مسودة — يفتح في المصمم</SelectItem>
                    <SelectItem value="bank">بنك الأسئلة — بحاجة لمراجعة</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[13px]">{target === 'bank' ? 'وسم المصدر (اختياري)' : 'عنوان الامتحان (اختياري)'}</Label>
                <Input
                  className="h-9 text-sm"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={target === 'bank' ? 'يُسجل كوصف للأسئلة المستوردة' : 'امتحان مستورد'}
                  maxLength={300}
                />
              </div>
            </div>
            {text.trim().length >= 3 && (
              <Badge variant="outline" className="gap-1 text-[13px] text-success">
                <ListPlus className="h-3 w-3" />
                {detectedCount > 0 ? `${detectedCount} سؤال مكتشف` : 'لم يُعثر على أسئلة مرقمة — كل النص سيكون سؤالًا واحدًا'}
              </Badge>
            )}
            <Button
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={importBusy || ocrBusy || text.trim().length < 3}
              onClick={() => void importContent()}
            >
              {importBusy ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> جارٍ الاستيراد…</>
              ) : target === 'bank' ? (
                'إضافة إلى بنك الأسئلة (بحاجة لمراجعة)'
              ) : (
                <>
                  <FileInput className="h-4 w-4" /> استيراد وفتح في المصمم
                </>
              )}
            </Button>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              القواعد: السطر المرقم (1. / 2) / ٣-) يبدأ سؤالًا جديدًا، والأسطر التالية تُلحق به.
              {target === 'bank'
                ? ' أسئلة البنك المستوردة لا تُنشر تلقائيًا أبدًا — راجعها واضبط مفتاح الإجابة لاعتمادها.'
                : ' بعد الاستيراد أكمل الخيارات ومفتاح الإجابة في المصمم ثم انشر النسخة.'}
            </p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
