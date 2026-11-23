'use client';

// ============================================================
// ALNOKHBA QB — scanned sheet viewer
// The teacher must be able to LOOK at the paper before approving a
// grade: the corrected (flattened) sheet and the same sheet with the
// bubbles the engine actually read. Zoomable, RTL, works with either a
// data URL (serverless, no writable disk) or /api/scans/<id>/images/*.
// ============================================================

import { useState } from 'react';
import { ImageOff, Loader2, Maximize2, Minus, Plus, RotateCcw, ScanLine } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface ScanSheetViewerProps {
  /** flattened sheet, straight-on */
  correctedImage?: string | null;
  /** same sheet with the detected bubbles/markers drawn on it */
  debugImage?: string | null;
  className?: string;
}

type Shot = { key: 'corrected' | 'debug'; label: string; src: string };

function SheetImage({
  src,
  alt,
  className,
  onZoom,
}: {
  src: string;
  alt: string;
  className?: string;
  onZoom?: () => void;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  return (
    <div className={`relative ${className ?? ''}`}>
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
          <Loader2 className="me-1 h-4 w-4 animate-spin" /> جارٍ تحميل صورة الورقة…
        </div>
      )}
      {state === 'error' && (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-slate-50 p-8 text-xs text-slate-500">
          <ImageOff className="h-5 w-5" />
          صورة الورقة غير متاحة لهذه المسحة (لم تُحفظ وقت المسح).
        </div>
      )}
      {state !== 'error' && (
        <img
          src={src}
          alt={alt}
          className={`mx-auto w-full rounded-lg border bg-white object-contain ${state === 'loading' ? 'opacity-0' : 'opacity-100'} ${onZoom ? 'cursor-zoom-in' : ''}`}
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
          onClick={onZoom}
        />
      )}
    </div>
  );
}

export default function ScanSheetViewer({ correctedImage, debugImage, className }: ScanSheetViewerProps) {
  const shots: Shot[] = [
    correctedImage ? { key: 'corrected', label: 'الورقة كما قرأها النظام', src: correctedImage } : null,
    debugImage ? { key: 'debug', label: 'مواضع الفقاعات المقروءة', src: debugImage } : null,
  ].filter((s): s is Shot => s !== null);

  const [zoomSrc, setZoomSrc] = useState<Shot | null>(null);
  const [zoom, setZoom] = useState(1);

  if (shots.length === 0) {
    return (
      <div className={`rounded-xl border border-dashed bg-slate-50 p-4 text-center text-xs text-slate-500 ${className ?? ''}`}>
        <ImageOff className="mx-auto mb-1 h-5 w-5" />
        لا توجد صورة محفوظة لهذه المسحة — أعد مسح الورقة لعرضها هنا.
      </div>
    );
  }

  const openZoom = (shot: Shot) => {
    setZoom(1);
    setZoomSrc(shot);
  };

  return (
    <div className={className}>
      <Tabs defaultValue={shots[0].key} dir="rtl">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <TabsList className="h-8">
            {shots.map((s) => (
              <TabsTrigger key={s.key} value={s.key} className="gap-1 text-[11px]">
                <ScanLine className="h-3.5 w-3.5" /> {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={() => openZoom(shots[0])}
          >
            <Maximize2 className="h-3.5 w-3.5" /> تكبير
          </Button>
        </div>
        {shots.map((s) => (
          <TabsContent key={s.key} value={s.key} className="mt-0">
            <div className="max-h-[52vh] overflow-auto rounded-lg border bg-slate-100/60 p-1">
              <SheetImage
                src={s.src}
                alt={s.label}
                onZoom={() => openZoom(s)}
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <Dialog open={zoomSrc !== null} onOpenChange={(v) => !v && setZoomSrc(null)}>
        <DialogContent className="max-h-[94vh] w-[96vw] max-w-6xl overflow-hidden p-0 sm:max-w-6xl" dir="rtl">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <ScanLine className="h-4 w-4 text-emerald-600" />
              {zoomSrc?.label ?? 'الورقة'}
              <Badge variant="outline" className="text-[10px]">{Math.round(zoom * 100)}%</Badge>
            </DialogTitle>
            <div className="flex items-center gap-1">
              <Button
                type="button" size="icon" variant="outline" className="h-7 w-7"
                onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
                aria-label="تصغير"
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button" size="icon" variant="outline" className="h-7 w-7"
                onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100))}
                aria-label="تكبير"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button" size="icon" variant="outline" className="h-7 w-7"
                onClick={() => setZoom(1)}
                aria-label="إعادة الضبط"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="max-h-[86vh] overflow-auto bg-slate-100 p-2">
            {zoomSrc && (
              <img
                src={zoomSrc.src}
                alt={zoomSrc.label}
                className="mx-auto block rounded border bg-white"
                style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
