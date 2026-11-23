'use client';

// ============================================================
// النخبة QB — استوديو أوراق OMR (/exams/[id]/omr)
// Enable OMR → publish → print sheets. Same endpoints as before.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { downloadFile } from '@/components/qb/PreviewPane';
import ScanSheetViewer from '@/components/qb/ScanSheetViewer';
import { t } from '@/lib/ui/strings';
import { BookOpen, FileDown, ScanLine } from 'lucide-react';

interface OmrDetail {
  exam: { status: string };
  document: { omr: { enabled: boolean; optionsPerQuestion: number; studentIdDigits: number } };
  versions: { id: string; version: number; publishedAt: string }[];
}

interface FixedSheetSummary {
  id: string;
  revision: number;
  templateId: string;
  createdAt: string;
  template?: { totalQuestions: number; idBoxes?: { digits: number } };
}

interface PracticeAnswer {
  number: number;
  detected: string | null;
  confidence: number;
}

interface PracticeResult {
  scanId?: string;
  status?: string;
  needsReview?: boolean;
  duplicate?: boolean;
  message?: string;
  error?: string;
  stage?: string;
  studentCode?: string | null;
  grade?: { score: number; maxScore: number; percent: number; unanswered: number[] } | null;
  answers?: PracticeAnswer[];
  diagnostics?: {
    identity?: { digits?: string; complete?: boolean; source?: string };
    versionRead?: { letter?: string | null } | null;
    flags?: string[];
    correctedImage?: string | null;
    debugImage?: string | null;
  };
}

const FLAG_LABEL: Record<string, string> = {
  versionBlank: 'لم تُظلَّل النسخة',
  versionMultiple: 'أكثر من نسخة مظللة',
  versionUnclear: 'النسخة غير واضحة',
  versionNotPublished: 'نسخة غير منشورة',
  noAnswersRead: 'لم تُقرأ أي إجابة',
  duplicateStudentPage: 'للطالب ورقة سابقة',
};

export default function OmrStudioPane({ examId }: { examId: string }) {
  const [detail, setDetail] = useState<OmrDetail | null>(null);
  const [fixed, setFixed] = useState<FixedSheetSummary | null>(null);
  const [copies, setCopies] = useState(30);
  const [busy, setBusy] = useState('');
  const [practice, setPractice] = useState<PracticeResult | null>(null);
  const [practiceOpen, setPracticeOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [examRes, fixedRes] = await Promise.all([
      fetch(`/api/exams/${examId}`),
      fetch(`/api/exams/${examId}/fixed-sheet`),
    ]);
    setDetail(await examRes.json());
    if (fixedRes.ok) setFixed((await fixedRes.json()).current ?? null);
  }, [examId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createFixedSheet = async () => {
    setBusy('fixed');
    try {
      const res = await fetch(`/api/exams/${examId}/fixed-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body?.error ?? 'تعذّر إنشاء الورقة الموحّدة');
        return;
      }
      toast.success(`الورقة الموحّدة جاهزة — الإصدار ${body.revision}`);
      void load();
    } finally {
      setBusy('');
    }
  };

  const runPracticeScan = async (file: File) => {
    setBusy('practice');
    setPractice(null);
    setPracticeOpen(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      });
      setPractice(await res.json());
    } catch {
      toast.error('تعذّر إرسال الصورة إلى المحرك');
      setPracticeOpen(false);
    } finally {
      setBusy('');
    }
  };

  const enableOmr = async (enabled: boolean) => {
    if (!detail) return;
    await fetch(`/api/exams/${examId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: { ...detail.document, omr: { ...detail.document.omr, enabled } } }),
    });
    toast.success(enabled ? 'تم تفعيل OMR — انشر الامتحان لتوليد القالب' : 'تم تعطيل OMR');
    void load();
  };

  const download = async (url: string, name: string, kind: string) => {
    setBusy(kind);
    try {
      await downloadFile(url, name, kind === 'pdf' ? `تم تنزيل ${name}` : 'تم التنزيل');
    } finally {
      setBusy('');
    }
  };

  if (!detail?.exam) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-[15px] text-muted-foreground" dir="rtl">
        {(detail as unknown as { error?: string } | null)?.error ?? 'جارٍ التحميل…'}
      </div>
    );
  }
  const published = detail.exam.status === 'PUBLISHED' && detail.versions.length > 0;
  const latestVersion = detail.versions[detail.versions.length - 1];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('stageOmr')}</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="border-border bg-paper">
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[15px] font-bold">التصحيح الآلي (OMR)</div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  ورقة إجابة قابلة للقراءة الضوئية، مواضع الفقاعات مخزنة في قالب الامتحان
                </div>
              </div>
              <Button
                size="sm"
                variant={detail.document.omr.enabled ? 'secondary' : 'outline'}
                className="h-9"
                onClick={() => void enableOmr(!detail.document.omr.enabled)}
              >
                {detail.document.omr.enabled ? 'مفعّل' : 'معطّل'}
              </Button>
            </div>
            <div className="rounded-lg bg-muted p-3 text-[13px] leading-relaxed text-muted-foreground">
              التدفق: فعّل OMR ← انشر الامتحان (يُنشأ قالب إحداثيات ثابت) ← اطبع الأوراق ← امسح ← راجع
              القراءات غير المؤكدة ← اعتمد النتائج. كل ورقة تحمل رمز QR يربطها بنسخة الامتحان — أوراق
              النسخ القديمة تُصحح بمفاتيحها القديمة.
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-paper">
          <CardContent className="space-y-3 p-5">
            <div className="text-[15px] font-bold">
              توليد الأوراق {published ? `(النسخة ${latestVersion?.version})` : ''}
            </div>
            {!published ? (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-[13px] text-warning">
                انشر الامتحان أولًا من صفحة الامتحانات لتوليد قالب أوراق OMR.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Label className="text-[13px]">عدد النسخ</Label>
                  <Slider
                    value={[copies]}
                    min={1}
                    max={200}
                    step={1}
                    onValueChange={([v]) => setCopies(v)}
                    className="flex-1"
                    aria-label="عدد النسخ"
                  />
                  <span className="w-10 text-center text-[15px] font-bold tabular-nums">{copies}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="h-9 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                    disabled={busy !== ''}
                    onClick={() => void download(`/api/versions/${latestVersion?.id}/pdf?type=omr&copies=${copies}`, 'omr-sheets.pdf', 'pdf')}
                  >
                    <FileDown className="h-4 w-4" />
                    {busy === 'pdf' ? 'جارٍ التوليد…' : `اطبع ${copies} ورقة (PDF)`}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 gap-1"
                    disabled={busy !== ''}
                    onClick={() => void download(`/api/versions/${latestVersion?.id}/omr-png?sheet=0`, 'omr-sheet-300dpi.png', 'png')}
                  >
                    <FileDown className="h-4 w-4" />
                    {busy === 'png' ? 'جارٍ التجهيز…' : 'ورقة PNG 300dpi (اختبار)'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 gap-1"
                    onClick={() => void download(`/api/versions/${latestVersion?.id}/pdf?type=exam`, 'exam.pdf', 'exam')}
                  >
                    <BookOpen className="h-4 w-4" /> PDF الامتحان
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card className="border-border bg-paper md:col-span-2">
          <CardContent className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[15px] font-bold">
                  الورقة الموحّدة {fixed ? `(الإصدار ${fixed.revision})` : ''}
                </div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  ورقة واحدة لكل الامتحان تُطبع مرة واحدة وتُستخدم لكل النسخ — الطالب يظلّل رقمه في
                  شبكة الأرقام ويظلّل حرف النسخة، فلا حاجة لورقة لكل نسخة.
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                disabled={busy !== ''}
                onClick={() => void createFixedSheet()}
              >
                {busy === 'fixed' ? 'جارٍ الإنشاء…' : fixed ? 'أنشئ إصدارًا جديدًا' : 'أنشئ الورقة الموحّدة'}
              </Button>
            </div>
            {fixed ? (
              <>
                <div className="rounded-lg bg-muted p-3 text-[13px] leading-relaxed text-muted-foreground">
                  {fixed.template?.totalQuestions ?? 0} سؤالًا • {fixed.template?.idBoxes?.digits ?? 0} خانات
                  لرقم الطالب • ظلّل حرف النسخة (A/B/C) في صف النسخة أعلى الورقة.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="h-9 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                    disabled={busy !== ''}
                    onClick={() =>
                      void download(`/api/fixed-sheets/${fixed.id}/pdf?copies=${copies}`, 'fixed-sheet.pdf', 'fixedPdf')
                    }
                  >
                    <FileDown className="h-4 w-4" />
                    {busy === 'fixedPdf' ? 'جارٍ التوليد…' : `اطبع ${copies} ورقة (PDF)`}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 gap-1"
                    disabled={busy !== ''}
                    onClick={() =>
                      void download(`/api/fixed-sheets/${fixed.id}/png?sheet=0&dpi=300`, 'fixed-sheet-300dpi.png', 'fixedPng')
                    }
                  >
                    <FileDown className="h-4 w-4" />
                    {busy === 'fixedPng' ? 'جارٍ التجهيز…' : 'ورقة PNG 300dpi (اختبار)'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-9 gap-1"
                    disabled={busy !== ''}
                    onClick={() => fileRef.current?.click()}
                  >
                    <ScanLine className="h-4 w-4" />
                    {busy === 'practice' ? 'جارٍ القراءة…' : 'اختبر ورقة معبّأة (صورة)'}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void runPracticeScan(file);
                    }}
                  />
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-[13px] text-warning">
                لا توجد ورقة موحّدة بعد — أنشئها مرة واحدة ثم اطبعها لكل الطلاب.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={practiceOpen} onOpenChange={setPracticeOpen}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto" dir="rtl">
          <DialogTitle className="text-[15px] font-bold">نتيجة قراءة الورقة</DialogTitle>
          {busy === 'practice' || !practice ? (
            <div className="py-10 text-center text-[13px] text-muted-foreground">جارٍ قراءة الورقة…</div>
          ) : practice.error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-[13px] text-destructive">
              {practice.error}
              {practice.stage ? <div className="mt-1 text-[11px] opacity-70">المرحلة: {practice.stage}</div> : null}
            </div>
          ) : (
            <div className="space-y-3">
              {practice.duplicate ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-2 text-[12px] text-warning">
                  {practice.message ?? 'هذه الصورة مُسجّلة مسبقًا'}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 text-[13px]">
                <span className="rounded-md bg-muted px-2 py-1">
                  رقم الطالب: <b className="tabular-nums">{practice.diagnostics?.identity?.digits || '—'}</b>
                </span>
                <span className="rounded-md bg-muted px-2 py-1">
                  النسخة: <b>{practice.diagnostics?.versionRead?.letter ?? '—'}</b>
                </span>
                <span className="rounded-md bg-muted px-2 py-1">
                  الدرجة: <b className="tabular-nums">{practice.grade?.score ?? 0}</b> /{' '}
                  {practice.grade?.maxScore ?? 0}
                </span>
                <span className="rounded-md bg-muted px-2 py-1">
                  الحالة: <b>{practice.status === 'PROCESSED' ? 'مقبولة' : 'تحتاج مراجعة'}</b>
                </span>
              </div>
              {(practice.diagnostics?.flags?.length ?? 0) > 0 ? (
                <div className="flex flex-wrap gap-1 text-[12px]">
                  {practice.diagnostics?.flags?.map((f) => (
                    <span key={f} className="rounded bg-destructive/10 px-2 py-0.5 text-destructive">
                      {FLAG_LABEL[f] ?? f}
                    </span>
                  ))}
                </div>
              ) : null}
              <ScanSheetViewer
                correctedImage={practice.diagnostics?.correctedImage ?? null}
                debugImage={practice.diagnostics?.debugImage ?? null}
              />
              {practice.answers && practice.answers.length > 0 ? (
                <div className="grid grid-cols-2 gap-1 text-[12px] sm:grid-cols-3 md:grid-cols-5">
                  {practice.answers.map((a) => (
                    <div key={a.number} className="flex items-center justify-between rounded border px-2 py-1">
                      <span className="text-muted-foreground">س{a.number}</span>
                      <span className={a.detected ? 'font-bold' : 'text-muted-foreground'}>{a.detected ?? '—'}</span>
                      <span className="tabular-nums text-[10px] text-muted-foreground">
                        {Math.round((a.confidence ?? 0) * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
