'use client';

// ============================================================
// النخبة QB — استوديو أوراق OMR (/exams/[id]/omr)
// Enable OMR → publish → print sheets. Same endpoints as before.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { downloadFile } from '@/components/qb/PreviewPane';
import { t } from '@/lib/ui/strings';
import { BookOpen, FileDown } from 'lucide-react';

interface OmrDetail {
  exam: { status: string };
  document: { omr: { enabled: boolean; optionsPerQuestion: number; studentIdDigits: number } };
  versions: { id: string; version: number; publishedAt: string }[];
}

export default function OmrStudioPane({ examId }: { examId: string }) {
  const [detail, setDetail] = useState<OmrDetail | null>(null);
  const [copies, setCopies] = useState(30);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/exams/${examId}`);
    setDetail(await res.json());
  }, [examId]);

  useEffect(() => {
    void load();
  }, [load]);

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
      </div>
    </div>
  );
}
