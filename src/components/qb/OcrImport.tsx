'use client';

// ============================================================
// ALNOKHBA QB — OCR Import (PHASE 8)
// صورة → OCR (محرك Tesseract + نموذج رؤية بديل) → نص قابل
// للتعديل → الوجهة: امتحان مسودة جديد في المصمم أو إضافة لبنك
// الأسئلة كأسئلة "بحاجة لمراجعة" (لا تُنشر أبدًا تلقائيًا)
// Backend: POST /api/ocr (extraction), POST /api/ocr/import (parsing)
// ============================================================

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage, prepareUpload } from '@/lib/image/prepareUpload';
import { FileInput, ImageIcon, ListPlus, Loader2, ScanText } from 'lucide-react';

/** Same rule as the server parser: a numbered line starts a new question. */
const NUMBERED_LINE_RE = /^[\d\u0660-\u0669]+[\.\)\-]/;

export default function OcrImport({ onCreated }: { onCreated: (examId: string) => void }) {
  const [lang, setLang] = useState<'ara' | 'eng'>('ara');
  const [target, setTarget] = useState<'exam' | 'bank'>('exam');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [engine, setEngine] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const detectedCount = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => NUMBERED_LINE_RE.test(l)).length;

  const extract = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      toast.error('حجم الملف كبير جدًا (الحد 25 ميجابايت)');
      return;
    }
    setOcrBusy(true);
    setEngine(null);
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
        let usedOcr = false;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const embeddedText = content.items
            .map((item) => {
              if (!('str' in item)) return '';
              return `${item.str}${item.hasEOL ? '\n' : ' '}`;
            })
            .join('')
            .trim();

          if (embeddedText.length >= 20) {
            pageTexts.push(embeddedText);
            await page.cleanup();
            continue;
          }

          // No useful text layer: render this scanned page and OCR it.
          usedOcr = true;
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
          canvas.width = 0;
          canvas.height = 0;
          const res = await fetch('/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: pageImage, lang }),
          });
          const d = (await res.json().catch(() => null)) as {
            ok?: boolean;
            text?: string;
            error?: string;
            details?: string;
            engine?: string;
          } | null;
          if (!res.ok || !d?.ok) {
            const message = await apiErrorMessage(res, `فشل تحليل الصفحة ${pageNumber}`);
            throw new Error(d?.details ? `${d.error ?? message} — ${d.details}` : d?.error ?? message);
          }
          pageTexts.push(d.text ?? '');
          await page.cleanup();
        }
        const extracted = pageTexts.filter(Boolean).join('\n\n').trim();
        setText(extracted);
        setEngine(usedOcr ? 'PDF + OCR' : 'PDF text');
        toast.success(usedOcr ? 'تم استخراج نص صفحات PDF عبر OCR' : 'تم استخراج النص المضمّن في PDF');
        return;
      }

      // Downscale + JPEG re-encode on-device: keeps the base64 JSON body
      // under Vercel's 4.5 MB function payload limit for phone photos.
      const prepared = await prepareUpload(file);
      setImagePreview(prepared.dataUrl);
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: prepared.dataUrl, lang }),
      });
      const d = (await res.json().catch(() => null)) as {
        ok?: boolean;
        text?: string;
        error?: string;
        details?: string;
        engine?: string;
      } | null;
      if (!res.ok || !d?.ok) {
        const message = await apiErrorMessage(res, 'فشل استخراج النص من الصورة');
        toast.error(d?.details ? `${d.error ?? message} — ${d.details}` : d?.error ?? message);
        return;
      }
      setText(d.text ?? '');
      setEngine(d.engine ?? null);
      toast.success(d.engine === 'vlm' ? 'تم الاستخراج باللغة العربية (نموذج رؤية)' : 'تم استخراج النص (Tesseract)');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'تعذر الاتصال بخدمة OCR');
    } finally {
      setOcrBusy(false);
    }
  };

  const importContent = async () => {
    if (text.trim().length < 3) {
      toast.error('النص قصير جدًا — الصق أو استخرج نص الأسئلة أولًا');
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
        setText('');
        setTitle('');
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
    <div className="grid gap-4 lg:grid-cols-2" dir="rtl">
      {/* Step 1 — image → text */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanText className="h-5 w-5 text-success" /> استخراج النص من صورة (OCR)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-muted-foreground">لغة النص:</span>
            <Select value={lang} onValueChange={(v) => setLang(v === 'eng' ? 'eng' : 'ara')}>
              <SelectTrigger className="h-8 w-56 text-[13px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ara">العربية (Tesseract — مراجعة مطلوبة)</SelectItem>
                <SelectItem value="eng">English (Tesseract — review required)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void extract(f);
            }}
            onClick={() => inputRef.current?.click()}
            className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-success/40 bg-success/5 p-5 text-center transition hover:border-success/40 hover:bg-success/10"
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
              }}
            />
            {ocrBusy ? <Loader2 className="h-7 w-7 animate-spin text-success" /> : <ImageIcon className="h-7 w-7 text-success" />}
            <div className="text-sm font-medium text-success">اختر صورة أو ملف PDF لورقة الأسئلة</div>
            <div className="text-[13px] text-muted-foreground">يُقرأ النص المضمّن في PDF، وتُحوّل الصفحات المصوّرة تلقائيًا إلى OCR</div>
          </div>
          {imagePreview && !ocrBusy && (
            <img src={imagePreview} alt="الصورة المرفوعة" className="max-h-40 w-full rounded-lg border object-contain" />
          )}
          {engine && (
            <Badge className="bg-success/10 text-success">
              المحرك: {engine === 'vlm' ? 'نموذج رؤية' : 'Tesseract'}
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* Step 2 — text → exam draft OR bank review queue */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileInput className="h-5 w-5 text-success" /> تحويل النص إلى أسئلة
          </CardTitle>
        </CardHeader>
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
                placeholder={target === 'bank' ? 'يُسجل كوصف للأسئلة المستوردة' : 'امتحان مستورد من OCR'}
                maxLength={300}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-[13px]">نص الأسئلة (قابل للتعديل — يمكنك اللصق مباشرة)</Label>
              {text.trim().length >= 3 && (
                <Badge variant="outline" className="gap-1 text-[13px] text-success">
                  <ListPlus className="h-3 w-3" /> {detectedCount > 0 ? `${detectedCount} سؤال مكتشف` : 'سؤال واحد (بدون ترقيم)'}
                </Badge>
              )}
            </div>
            <Textarea
              className="max-h-96 min-h-56 overflow-y-auto text-[13px] leading-relaxed"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'الصق النص هنا… كل سطر يبدأ برقم (1. أو ٢-) يبدأ سؤالًا جديدًا\n1. ما ناتج جمع 2 + 2؟\n2. عاصمة مصر؟'}
            />
          </div>
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
              'استيراد وفتح في المصمم'
            )}
          </Button>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            القواعد: السطر المرقم (1. / 2) / ٣-) يبدأ سؤالًا جديدًا، والأسطر التالية تُلحق به.
            {target === 'bank'
              ? ' أسئلة البنك المستوردة لا تُنشر تلقائيًا أبدًا — راجعها واضبط مفتاح الإجابة لاعتمادها.'
              : ' بعد الاستيراد أكمل الخيارات ومفتاح الإجابة في المصمم ثم انشر النسخة.'}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
