'use client';

import { useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useFormsStore } from '@/lib/forms/store';
import { flagLabel } from '@/lib/forms/types';

interface Props {
  lang: 'ar' | 'en';
}

export function SheetPreview({ lang }: Props) {
  const { results, selectedSheetId, selectSheet, reviewCanvases } = useFormsStore();
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sheet = results.find((r) => r.sheetId === selectedSheetId) ?? results[0];
  const canvas = sheet ? reviewCanvases[sheet.sheetId] : undefined;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !canvas) return;
    const scale = Math.min(560 / canvas.width, 1);
    cv.width = Math.round(canvas.width * scale);
    cv.height = Math.round(canvas.height * scale);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(canvas, 0, 0, cv.width, cv.height);
    const W = cv.width;
    const lw = Math.max(1.2, W / 420);
    for (const m of sheet.marks) {
      ctx.beginPath();
      ctx.arc(m.x * W, m.y * cv.height, Math.max(2, m.r * W), 0, Math.PI * 2);
      ctx.lineWidth = lw * 1.4;
      ctx.strokeStyle = m.state === 'marked' ? '#059669' : m.state === 'multiple' ? '#dc2626' : '#d97706';
      ctx.stroke();
    }
  }, [canvas, sheet]);

  if (!sheet) return null;

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold">{L('معاينة الورقة والعلامات المكتشفة', 'Sheet preview with detected marks')}</h3>
          <div className="flex flex-wrap gap-1">
            <Badge variant="outline" className={sheet.aligned ? 'text-emerald-600' : 'text-red-500'}>
              {sheet.aligned
                ? sheet.alignMethod === 'deskew'
                  ? L('محاذاة: تصحيح ميل', 'aligned: deskew')
                  : L(`محاذاة: ${sheet.alignMethod}`, `aligned: ${sheet.alignMethod}`)
                : L('غير محاذاة', 'not aligned')}
              {` ${Math.round(sheet.alignConfidence * 100)}%`}
            </Badge>
          </div>
        </div>
        <div className="max-h-[44vh] overflow-auto rounded-xl border bg-muted p-2 pw-scroll">
          {canvas ? (
            <canvas ref={canvasRef} className="block h-auto w-full" aria-label={L('معاينة الورقة', 'Sheet preview')} />
          ) : (
            <p className="py-10 text-center text-xs text-muted-foreground">{L('لا معاينة متاحة', 'No preview available')}</p>
          )}
        </div>
        {sheet.flags.length > 0 && (
          <div className="text-[11px] text-amber-700">
            {sheet.flags.map((f) => flagLabel(f, lang)).join(' • ')}
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          <span className="text-[10px] text-muted-foreground">{L('قائمة الأوراق:', 'Sheet list:')}</span>
          {results.slice(0, 40).map((r, i) => (
            <button
              key={r.sheetId}
              type="button"
              onClick={() => selectSheet(r.sheetId)}
              className={`h-6 min-w-6 rounded px-1 text-[10px] font-bold transition ${
                r.sheetId === sheet.sheetId ? 'bg-emerald-600 text-white' : r.flags.length ? 'bg-amber-500/20 text-amber-700' : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
              title={r.fileName}
            >
              {i + 1}
            </button>
          ))}
          {results.length > 40 && <span className="text-[10px] text-muted-foreground">+{results.length - 40}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
