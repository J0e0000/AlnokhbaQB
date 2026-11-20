'use client';

// ============================================================
// النخبة QB — الإعدادات (/settings)
// OMR calibration thresholds + OCR sanity test + system health.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage, prepareUpload } from '@/lib/image/prepareUpload';
import { t } from '@/lib/ui/strings';
import { Activity } from 'lucide-react';

interface CalibrationConfig {
  filled: number;
  empty: number;
  ambiguousMargin: number;
  minAbsoluteFill: number;
  name?: string;
}

export default function SettingsPane() {
  const [config, setConfig] = useState<CalibrationConfig | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void fetch('/api/calibration').then(async (r) => {
      const d = await r.json();
      setConfig(d.config ?? d);
    });
    void fetch('/api/health').then(async (r) => setHealth(await r.json()));
  }, []);

  const save = async () => {
    if (!config) return;
    const res = await fetch('/api/calibration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: config.name ?? 'مخصص', config }),
    });
    if (res.ok) toast.success('تم حفظ معايرة العتبات');
    else toast.error('فشل الحفظ — أعد المحاولة');
  };

  const testOcr = async (file: File) => {
    setOcrBusy(true);
    try {
      const prepared = await prepareUpload(file);
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: prepared.dataUrl, lang: 'ara' }),
      });
      const d = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
      setOcrText(d?.text ?? (res.ok ? '' : await apiErrorMessage(res, 'فشل تحليل الصورة')));
    } catch {
      setOcrText('تعذر قراءة الصورة');
    } finally {
      setOcrBusy(false);
    }
  };

  if (!config) return <div className="py-20 text-center text-[15px] text-muted-foreground">جارٍ التحميل…</div>;

  const healthRows: [string, boolean][] = [
    [t('sysDb'), Boolean(health?.db)],
    [t('sysPdf'), Boolean((health?.pdf as { ok?: boolean } | undefined)?.ok ?? (health?.pdf as { running?: boolean } | undefined)?.running)],
    [t('sysOmr'), Boolean((health?.omrEngine as { ok?: boolean } | undefined)?.ok ?? health?.omrEngine)],
  ];

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 md:grid-cols-2" dir="rtl">
      <h1 className="text-2xl font-bold md:col-span-2">{t('navSettings')}</h1>

      <Card className="border-border bg-paper">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-2 text-[15px] font-bold">
            <Activity className="h-4 w-4 text-success" /> معايرة قارئ OMR
          </div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            العتبات مأخوذة من معايرة فعلية (قلم رصاص/حبر/إضاءة منخفضة). حد التظليل:
            النسبة التي تُعتبر عندها الفقاعة معلّمة. حد الفارغ: أقل من يُعتبر فارغة.
          </p>
          {([
            ['filled', 'حد التظليل (filled)', 0, 1],
            ['empty', 'حد الفارغ (empty)', 0, 1],
            ['ambiguousMargin', 'هامش الالتباس', 0, 0.5],
            ['minAbsoluteFill', 'أدنى تظليل مطلق', 0, 0.5],
          ] as const).map(([key, label, min, max]) => (
            <div key={key}>
              <div className="mb-1 flex items-center justify-between">
                <Label className="text-[13px]">{label}</Label>
                <span className="text-[13px] font-bold tabular-nums">{config[key].toFixed(2)}</span>
              </div>
              <Slider
                value={[config[key]]}
                min={min}
                max={max}
                step={0.01}
                onValueChange={([v]) => setConfig({ ...config, [key]: v })}
                aria-label={label}
              />
            </div>
          ))}
          <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => void save()}>
            {t('save')}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border bg-paper">
        <CardContent className="space-y-3 p-5">
          <div className="text-[15px] font-bold">اختبار OCR (منفصل عن قراءة الفقاعات)</div>
          <p className="text-[13px] text-muted-foreground">
            العربية عبر نموذج رؤية لغوي، الإنجليزية عبر Tesseract. لا يُستخدم OCR في قراءة الفقاعات أبدًا.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="ocr-file">صورة للتجربة</Label>
            <input
              id="ocr-file"
              type="file"
              accept="image/*"
              className="block w-full text-[13px] file:me-2 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2 file:text-[13px] file:font-medium"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void testOcr(f);
              }}
            />
          </div>
          {ocrBusy && <div className="text-[13px] text-success">جارٍ الاستخراج…</div>}
          <Textarea className="h-40 text-[13px]" value={ocrText} onChange={(e) => setOcrText(e.target.value)} placeholder="النص المستخرج…" aria-label="النص المستخرج" />
        </CardContent>
      </Card>

      <Card className="border-border bg-paper md:col-span-2">
        <CardContent className="p-5">
          <div className="text-[15px] font-bold">{t('systemStatus')}</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {healthRows.map(([label, ok]) => (
              <div key={label} className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-[13px]">
                <span>{label}</span>
                <Badge className={`border-0 ${ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
                  {ok ? t('connected') : t('disconnected')}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
