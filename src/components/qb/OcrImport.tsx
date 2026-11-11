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
    if (file.size > 20 * 1024 * 1024) {
      toast.error('حجم الصورة كبير جدًا (الحد 20 ميجابايت)');
      return;
    }
    setOcrBusy(true);
    setEngine(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      setImagePreview(dataUrl);
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: dataUrl, lang }),
      });
      const d = (await res.json()) as { ok?: boolean; text?: string; error?: string; details?: string; engine?: string };
      if (!res.ok || !d.ok) {
        toast.error(d.details ? `${d.error} — ${d.details}` : d.error ?? 'فشل استخراج النص من الصورة');
        return;
      }
      setText(d.text ?? '');
      setEngine(d.engine ?? null);
      toast.success(d.engine === 'vlm' ? 'تم الاستخراج باللغة العربية (نموذج رؤية)' : 'تم استخراج النص (Tesseract)');
    } catch {
      toast.error('تعذر الاتصال بخدمة OCR');
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
            <ScanText className="h-5 w-5 text-emerald-600" /> استخراج النص من صورة (OCR)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">لغة النص:</span>
            <Select value={lang} onValueChange={(v) => setLang(v === 'eng' ? 'eng' : 'ara')}>
              <SelectTrigger className="h-8 w-56 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ara">العربية (نموذج رؤية ذكي)</SelectItem>
                <SelectItem value="eng">English (Tesseract)</SelectItem>
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
            className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 p-5 text-center transition hover:border-emerald-400 hover:bg-emerald-50"
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void extract(f);
              }}
            />
            {ocrBusy ? <Loader2 className="h-7 w-7 animate-spin text-emerald-600" /> : <ImageIcon className="h-7 w-7 text-emerald-600" />}
            <div className="text-sm font-medium text-emerald-800">التقط صورة ورقة الأسئلة أو أفلتها هنا</div>
            <div className="text-[11px] text-slate-500">يُستخرج النص كما هو — لا يُستخدم OCR أبدًا في قراءة فقاعات OMR</div>
          </div>
          {imagePreview && !ocrBusy && (
            <img src={imagePreview} alt="الصورة المرفوعة" className="max-h-40 w-full rounded-lg border object-contain" />
          )}
          {engine && (
            <Badge className="bg-emerald-100 text-emerald-700">
              المحرك: {engine === 'vlm' ? 'نموذج رؤية' : 'Tesseract'}
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* Step 2 — text → exam draft OR bank review queue */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileInput className="h-5 w-5 text-emerald-600" /> تحويل النص إلى أسئلة
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">الوجهة</Label>
              <Select value={target} onValueChange={(v) => setTarget(v === 'bank' ? 'bank' : 'exam')}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="exam">امتحان مسودة — يفتح في المصمم</SelectItem>
                  <SelectItem value="bank">بنك الأسئلة — بحاجة لمراجعة</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{target === 'bank' ? 'وسم المصدر (اختياري)' : 'عنوان الامتحان (اختياري)'}</Label>
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
              <Label className="text-xs">نص الأسئلة (قابل للتعديل — يمكنك اللصق مباشرة)</Label>
              {text.trim().length >= 3 && (
                <Badge variant="outline" className="gap-1 text-[10px] text-emerald-700">
                  <ListPlus className="h-3 w-3" /> {detectedCount > 0 ? `${detectedCount} سؤال مكتشف` : 'سؤال واحد (بدون ترقيم)'}
                </Badge>
              )}
            </div>
            <Textarea
              className="max-h-96 min-h-56 overflow-y-auto text-xs leading-relaxed"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'الصق النص هنا… كل سطر يبدأ برقم (1. أو ٢-) يبدأ سؤالًا جديدًا\n1. ما ناتج جمع 2 + 2؟\n2. عاصمة مصر؟'}
            />
          </div>
          <Button
            className="w-full bg-emerald-600 hover:bg-emerald-700"
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
          <p className="text-[11px] leading-relaxed text-slate-500">
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
