'use client';

import { useCallback, useRef, useState } from 'react';
import { FileDown, FilePlus2, Loader2, Trash2, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useFormsStore } from '@/lib/forms/store';

interface Props {
  lang: 'ar' | 'en';
  onGenerateDemo?: () => void;
  demoBusy?: boolean;
}

export function LoadStep({ lang, onGenerateDemo, demoBusy }: Props) {
  const { sheets, addFiles, removeSheet, setStep, template } = useFormsStore();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);

  const ingest = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      setError(null);
      try {
        await addFiles(files, (done, total, label) => setProgress({ done, total, label }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [addFiles]
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void ingest(Array.from(e.dataTransfer.files));
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-1 text-sm font-bold">
            1. {L('حمّل الأوراق الممسوحة', 'Load scanned sheets')}
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            {L(
              'صور JPG/PNG أو ملفات PDF (كل صفحة = ورقة). الأوراق يجب أن تشترك بنفس التخطيط والاتجاه. الورقة الأولى هي مرجع القالب.',
              'JPG/PNG images or PDFs (one sheet per page). All sheets must share one layout and orientation. The first sheet is the template reference.'
            )}
          </p>
          <div
            role="button"
            tabIndex={0}
            aria-label={L('إسقاط الملفات هنا', 'Drop files here')}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
            }}
            className={`flex h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-sm transition ${
              dragOver ? 'border-emerald-500 bg-emerald-500/10' : 'border-border hover:border-emerald-500/60 hover:bg-accent'
            }`}
          >
            {busy ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
                <div className="text-xs text-muted-foreground">
                  {progress.label || '...'} ({progress.done}/{progress.total})
                </div>
                <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} className="w-40" />
              </>
            ) : (
              <>
                <UploadCloud className="h-7 w-7 text-emerald-500" />
                <span className="font-medium">{L('اسحب الملفات هنا أو انقر للاختيار', 'Drop files here or click to browse')}</span>
                <span className="text-[11px] text-muted-foreground">
                  {L('كل المعالجة تجري في متصفحك — لا يُرفع أي ملف', 'Everything runs in your browser — nothing is uploaded')}
                </span>
              </>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              void ingest(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          {error && (
            <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">
              {L('تعذر فتح الملفات:', 'Could not open the files:')} {error}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="btn-primary-grad gap-1 border-0 text-white"
              disabled={!sheets.length || busy}
              onClick={() => setStep('template')}
            >
              {L('التالي: رسم القالب', 'Next: draw the template')} →
            </Button>
            {onGenerateDemo && (
              <Button size="sm" variant="outline" className="gap-1" disabled={demoBusy} onClick={onGenerateDemo}>
                {demoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FilePlus2 className="h-3.5 w-3.5" />}
                {L('جرّب بأوراق تجريبية (٣٠ ورقة ممتلئة)', 'Try demo sheets (30 filled)')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <h2 className="mb-2 text-sm font-bold">
            {L('الأوراق المحمّلة', 'Loaded sheets')} ({sheets.length})
          </h2>
          {!sheets.length ? (
            <p className="py-8 text-center text-xs text-muted-foreground">{L('لا شيء بعد', 'Nothing yet')}</p>
          ) : (
            <ul className="max-h-96 space-y-1.5 overflow-y-auto pw-scroll pe-1">
              {sheets.map((s, i) => (
                <li key={s.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
                  <span className="w-6 text-center font-bold text-emerald-600">{i === 0 ? '★' : i + 1}</span>
                  <span className="min-w-0 flex-1 truncate" title={s.fileName}>
                    {s.fileName}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {s.canvas.width}×{s.canvas.height}
                  </span>
                  <button
                    type="button"
                    aria-label={L('إزالة', 'Remove')}
                    className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                    onClick={() => removeSheet(s.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <FileDown className="me-1 inline h-3 w-3" />
            {L(
              'الورقة الأولى (★) تُستخدم لرسم مناطق القالب بإحداثيات معيارية 0–1، فتعمل مع أي دقة مسح.',
              'The first sheet (★) is used to draw template areas in normalized 0–1 coordinates, so one template works at any scan resolution.'
            )}
            {template.refWidth > 0 && (
              <span className="ms-1 font-medium text-foreground">
                ({template.refWidth}×{template.refHeight})
              </span>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
