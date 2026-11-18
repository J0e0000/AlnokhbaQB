'use client';

// Pagewise PDF toolkit embedded as aQB pane. The toolkit's own grid + workspace
// render with the QB design tokens; only the wrapper chrome is QB-styled.

import { useState } from 'react';
import { FileStack } from 'lucide-react';
import { HomeGrid } from '@/components/pw/HomeGrid';
import { Workspace } from '@/components/pw/Workspace';
import { getTool } from '@/lib/pw/registry';
import type { ToolDef } from '@/lib/pw/types';

export default function PdfToolsPane({ lang }: { lang: 'ar' | 'en' }) {
  const [tool, setTool] = useState<ToolDef | null>(null);
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);

  return (
    <div className="space-y-3" dir="ltr">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold" style={{ fontFamily: 'Amiri, serif' }}>
            <FileStack className="h-5 w-5 text-emerald-500" />
            {L('أدوات PDF — صندوق الأدوات الكامل', 'PDF Tools — the complete toolkit')}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {L(
              'دمج، تقسيم، ضغط، تحويل، توقيع، حجب، وقراءة ذكية — معظم الأدوات تعمل داخل المتصفح دون رفع أي ملف.',
              'Merge, split, compress, convert, sign, redact and understand — most tools run entirely in your browser.'
            )}
          </p>
        </div>
        {tool && (
          <button
            type="button"
            onClick={() => setTool(null)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-accent hover:text-foreground"
          >
            {L('رجوع إلى كل الأدوات', 'Back to all tools')}
          </button>
        )}
      </div>
      {tool ? <Workspace tool={tool} onBack={() => setTool(null)} /> : <HomeGrid onOpen={(id) => setTool(getTool(id) ?? null)} />}
    </div>
  );
}
