'use client';

// ============================================================
// النخبة QB — معاينة الامتحان (/exams/[id]/preview)
// Paper on the desk surface; PDF download via the shared helper.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FileDown } from 'lucide-react';
import { t } from '@/lib/ui/strings';

const TRANSIENT_STATUS = new Set([502, 503, 504]);

async function fetchFileWithRetry(url: string): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
    try {
      const res = await fetch(url);
      if (res.ok || !TRANSIENT_STATUS.has(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('network');
}

/** Resilient file download shared by Preview / OMR studio. */
export async function downloadFile(url: string, name: string, successMsg = 'تم التنزيل'): Promise<void> {
  let res: Response;
  try {
    res = await fetchFileWithRetry(url);
  } catch {
    toast.error('تعذر الاتصال بالخادم — تأكد من تشغيله ثم أعد المحاولة');
    return;
  }
  if (!res.ok) {
    let msg = `فشل التوليد (HTTP ${res.status})`;
    try {
      const data = (await res.json()) as { error?: string; details?: string };
      if (data?.error) msg = data.details ? `${data.error} — ${data.details}` : data.error;
    } catch {
      /* non-JSON error body (e.g. gateway 502 HTML) → keep the default message */
    }
    toast.error(msg);
    return;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast.success(successMsg);
}

export default function PreviewPane({ examId }: { examId: string }) {
  const [html, setHtml] = useState<string>('');
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/exams/${examId}/preview`);
        const text = await r.text();
        if (!cancelled) {
          setHtml(text);
          setBusy(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
          setBusy(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [examId]);

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadFile(`/api/exams/${examId}/pdf`, 'exam.pdf', 'تم تنزيل PDF — نص متجهي حقيقي');
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">
          معاينة الامتحان <span className="text-muted-foreground">— مطابقة ١:١ مع PDF</span>
        </h1>
        <Button
          className="h-10 bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={pdfBusy}
          onClick={() => void downloadPdf()}
        >
          <FileDown className="me-1 h-4 w-4" />
          {pdfBusy ? 'جارٍ التوليد…' : `${t('download')} PDF`}
        </Button>
      </div>
      <div className="desk-surface rounded-lg border border-border p-4 sm:p-6">
        {busy ? (
          <div className="py-20 text-center text-[15px] text-muted-foreground">جارٍ رسم الورقة…</div>
        ) : failed ? (
          <div className="py-16 text-center text-[15px] text-destructive">
            تعذر تحميل المعاينة — تأكد من أن الامتحان يحتوي أسئلة ثم أعد المحاولة
          </div>
        ) : (
          <iframe
            title="معاينة ورقة الامتحان"
            srcDoc={html}
            className="paper-sheet mx-auto block h-[calc(100vh-16rem)] min-h-96 w-full max-w-[794px]"
          />
        )}
      </div>
    </div>
  );
}
