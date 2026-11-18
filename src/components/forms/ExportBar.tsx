'use client';

import { useState } from 'react';
import { ClipboardCopy, FileJson, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useFormsStore } from '@/lib/forms/store';
import type { SheetResult } from '@/lib/forms/types';
import { buildCsv, buildPdfReport, buildTsv, buildXlsx } from '@/lib/forms/exporters';
import { downloadBlob, sanitizeFileName } from '@/lib/pw/blob';

interface Props {
  lang: 'ar' | 'en';
}

export function ExportBar({ lang }: Props) {
  const { results, template } = useFormsStore();
  const [busy, setBusy] = useState<string>('');
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  const baseName = sanitizeFileName(template.name || 'form-results');

  const guard = async (kind: string, fn: () => Promise<void> | void) => {
    if (!results.length) return;
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
          4. {L('تصدير النتائج', 'Export results')} ({results.length})
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy !== ''}
            onClick={() =>
              void guard('csv', async () => {
                downloadBlob(new Blob([buildCsv(results, template, lang)], { type: 'text/csv;charset=utf-8' }), `${baseName}.csv`);
                toast.success(L('تم تنزيل CSV', 'CSV downloaded'));
              })
            }
          >
            {busy === 'csv' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy !== ''}
            onClick={() =>
              void guard('xlsx', async () => {
                downloadBlob(await buildXlsx(results, template, lang), `${baseName}.xlsx`);
                toast.success(L('تم تنزيل Excel', 'Excel downloaded'));
              })
            }
          >
            {busy === 'xlsx' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />} Excel
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy !== ''}
            onClick={() =>
              void guard('pdf', async () => {
                downloadBlob(await buildPdfReport(results, template), `${baseName}-report.pdf`);
                toast.success(L('تم تنزيل تقرير PDF', 'PDF report downloaded'));
              })
            }
          >
            {busy === 'pdf' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} PDF
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy !== ''}
            onClick={() =>
              void guard('clip', async () => {
                await navigator.clipboard.writeText(buildTsv(results, template, lang));
                toast.success(L('نُسخت النتائج إلى الحافظة', 'Results copied to clipboard'));
              })
            }
          >
            {busy === 'clip' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
            {L('نسخ (TSV)', 'Copy (TSV)')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy !== ''}
            onClick={() =>
              void guard('json', () => {
                downloadBlob(
                  new Blob(
                    [
                      JSON.stringify(
                        {
                          template,
                          results: results.map((r) => {
                            // strip non-serializable canvases/debug payloads
                            const { reviewCanvas, omr, ...rest } = r as SheetResult & {
                              reviewCanvas?: unknown;
                              omr?: unknown;
                            };
                            void reviewCanvas;
                            void omr;
                            return rest;
                          }),
                        },
                        null,
                        2
                      ),
                    ],
                    { type: 'application/json' }
                  ),
                  `${baseName}-results.json`
                );
                toast.success(L('تم تنزيل JSON', 'JSON downloaded'));
              })
            }
          >
            {busy === 'json' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileJson className="h-3.5 w-3.5" />} JSON
          </Button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {L(
            'الخصوصية: النتائج تُبنى داخل متصفحك. عند تفعيل مناطق «نص يدوي» تُرسل قصاصات تلك المناطق فقط إلى نموذج الرؤية على الخادم، ولا تُخزن بعد القراءة.',
            'Privacy: results are built in your browser. When "handwritten" regions are enabled, only those region crops go to the server-side vision model, and nothing is stored afterwards.'
          )}
        </p>
      </CardContent>
    </Card>
  );
}
