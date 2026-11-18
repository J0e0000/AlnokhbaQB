'use client';

import { ArrowLeft, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useFormsStore } from '@/lib/forms/store';

interface Props {
  lang: 'ar' | 'en';
}

export function ReadStep({ lang }: Props) {
  const { sheets, reading, readOpts, setReadOpts, runRead, setStep } = useFormsStore();
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);

  return (
    <div className="grid gap-4 md:grid-cols-2" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <Card>
        <CardContent className="space-y-4 p-4">
          <h2 className="text-sm font-bold">3. {L('قراءة الأوراق', 'Read the sheets')}</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {L(
              'يُطبَّق القالب على كل ورقة: محاذاة بالعلامات إن وُجدت (تصحيح دوران/تحجيم حتى ±°3 أو أكثر)، ثم قراءة الفقاعات بعتبة وسطية، وقراءة الباركود والنصوص. كل ذلك داخل متصفحك.',
              'The template is applied to every sheet: marker alignment when available (handles rotation/scaling), median-baseline OMR, barcode and text regions. All in your browser.'
            )}
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <div>
                <div className="text-xs font-semibold">{L('تنقية الضوضاء (3×3)', 'Denoise (3×3 median)')}</div>
                <div className="text-[10px] text-muted-foreground">{L('أنصح به للمسح الضوئي المنقّط', 'Recommended for speckly scans')}</div>
              </div>
              <Switch checked={readOpts.denoise} onCheckedChange={(v) => setReadOpts({ denoise: v })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <div>
                <div className="text-xs font-semibold">{L('المتابعة عند فشل المحاذاة', 'Continue when alignment fails')}</div>
                <div className="text-[10px] text-muted-foreground">{L('يُقرأ دون تصحيح المنظور وتُعلَّم الأوراق للمراجعة', 'Read without perspective correction and flag the sheet for review')}</div>
              </div>
              <Switch checked={readOpts.allowUnaligned} onCheckedChange={(v) => setReadOpts({ allowUnaligned: v })} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="btn-primary-grad gap-1 border-0 text-white"
              disabled={reading.active || !sheets.length}
              onClick={() => void runRead()}
            >
              {reading.active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {reading.active ? L('جارٍ القراءة…', 'Reading…') : L(`قراءة ${sheets.length} ورقة`, `Read ${sheets.length} sheets`)}
            </Button>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setStep('template')}>
              <ArrowLeft className="h-3.5 w-3.5" /> {L('رجوع للقالب', 'Back to template')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="text-sm font-bold">{L('التقدم', 'Progress')}</h3>
          {reading.error && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{reading.error}</div>
          )}
          <Progress value={reading.total ? (reading.done / reading.total) * 100 : 0} />
          <div className="text-xs text-muted-foreground">
            {reading.active
              ? `${L('يُقرأ', 'Reading')} ${reading.current} (${reading.done}/${reading.total})`
              : reading.done && !reading.error
                ? L(`تمت قراءة ${reading.done} ورقة — انتقل إلى المراجعة`, `${reading.done} sheets read — continue to review`)
                : L('لم يبدأ بعد', 'Not started')}
          </div>
          {reading.done > 0 && !reading.active && !reading.error && (
            <Button size="sm" variant="outline" onClick={() => setStep('review')}>
              {L('فتح شاشة المراجعة', 'Open the review screen')} →
            </Button>
          )}
          <div className="rounded-lg bg-slate-500/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {L(
              'ملاحظة: الأوراق التي فشلت محاذاة علاماتها تُعلَّم «فشل محاذاة» ولا تُقرأ (ما لم تفعّل المتابعة). عتبة الحساسية قابلة للتعديل من خطوة القالب.',
              'Sheets whose markers failed alignment are flagged and not read unless you enable "continue". Sensitivity is adjustable in the template step.'
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
