'use client';

import { useState } from 'react';
import { RefreshCcw, ScanSearch } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { LoadStep } from './LoadStep';
import { TemplateStep } from './TemplateStep';
import { ReadStep } from './ReadStep';
import { ReviewStep } from './ReviewStep';
import { GeneratorDialog } from './GeneratorDialog';
import { useFormsStore } from '@/lib/forms/store';

interface Props {
  lang: 'ar' | 'en';
}

export default function FormsStudio({ lang }: Props) {
  const { step, setStep, sheets, template, resetAll } = useFormsStore();
  const [genOpen, setGenOpen] = useState(false);
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);

  const steps: { id: 'load' | 'template' | 'read' | 'review'; label: string; enabled: boolean }[] = [
    { id: 'load', label: L('التحميل', 'Load'), enabled: true },
    { id: 'template', label: L('القالب', 'Template'), enabled: sheets.length > 0 },
    { id: 'read', label: L('القراءة', 'Read'), enabled: sheets.length > 0 && template.areas.length > 0 },
    { id: 'review', label: L('المراجعة والتصدير', 'Review & export'), enabled: true },
  ];

  return (
    <div className="space-y-4" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* header */}
      <Card className="overflow-hidden">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-lg font-bold" style={{ fontFamily: 'Amiri, serif' }}>
                <ScanSearch className="h-5 w-5 text-emerald-500" />
                {L('قارئ النماذج والأوراق — OMR + OCR + باركود', 'Form & sheet scanner — OMR + OCR + barcodes')}
              </h1>
              <p className="mt-0.5 text-xs text-slate-500">
                {L(
                  'ارسم مناطق على ورقة مرجعية، طبّقها على كل الأوراق، راجع العلامات وصحّحها، ثم صدّر CSV/Excel/PDF. القارئ يعمل داخل متصفحك.',
                  'Draw areas on a reference sheet, apply them to every scan, review and correct marks, then export CSV/Excel/PDF. Reading runs in your browser.'
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                if (confirm(lang === 'ar' ? 'إعادة تعيين الجلسة بالكامل؟' : 'Reset the whole session?')) resetAll();
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-slate-500 transition hover:bg-accent hover:text-foreground"
            >
              <RefreshCcw className="h-3.5 w-3.5" /> {L('جلسة جديدة', 'New session')}
            </button>
          </div>
          {/* stepper */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {steps.map((s, i) => (
              <button
                key={s.id}
                type="button"
                disabled={!s.enabled}
                onClick={() => setStep(s.id)}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${
                  step === s.id
                    ? 'btn-primary-grad text-white'
                    : s.enabled
                      ? 'border border-border text-slate-500 hover:bg-accent hover:text-foreground'
                      : 'cursor-not-allowed border border-border text-slate-400 opacity-40'
                }`}
              >
                <span className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[9px] ${step === s.id ? 'bg-white/25' : 'bg-emerald-600/10 text-emerald-600'}`}>
                  {i + 1}
                </span>
                {s.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {step === 'load' && <LoadStep lang={lang} onGenerateDemo={() => setGenOpen(true)} />}
      {step === 'template' && <TemplateStep lang={lang} onGenerateSheets={() => setGenOpen(true)} />}
      {step === 'read' && <ReadStep lang={lang} />}
      {step === 'review' && <ReviewStep lang={lang} />}

      <GeneratorDialog lang={lang} open={genOpen} onOpenChange={setGenOpen} />
    </div>
  );
}
