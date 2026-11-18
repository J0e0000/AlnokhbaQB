'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleDot, Eraser, FileJson, Loader2, Scan, Save, Trash2, Undo2, Crosshair } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { useFormsStore } from '@/lib/forms/store';
import {
  DEFAULT_OPTION_PRESETS,
  omrQuestionOffsets,
  type AreaType,
  type FormArea,
  type FormTemplate,
} from '@/lib/forms/types';
import { downloadBlob } from '@/lib/pw/blob';
import { toGray, normalizeContrast } from '@/lib/forms/image';
import { guessMarkers } from '@/lib/forms/align';
import { templateToJson } from '@/lib/forms/exporters';
import { EmptyState } from '@/components/qb/pane-kit';

interface Props {
  lang: 'ar' | 'en';
  onGenerateSheets: () => void;
}

interface CloudTemplateRow {
  id: string;
  name: string;
  updatedAt: string;
}

const AREA_COLORS: Record<AreaType, string> = {
  omr: '#059669', // emerald-600
  ocr: '#d97706', // amber-600
  bcr: '#7c3aed', // violet-600
};

function uid(): string {
  return `a${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function TemplateStep({ lang, onGenerateSheets }: Props) {
  const { sheets, template, setTemplate, addArea, updateArea, removeArea, setStep } = useFormsStore();
  const L = useCallback((ar: string, en: string) => (lang === 'ar' ? ar : en), [lang]);

  const sample = sheets[0];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  // draft settings for the NEXT drawn area
  const [drawType, setDrawType] = useState<AreaType>('omr');
  const [questions, setQuestions] = useState(20);
  const [labelsInput, setLabelsInput] = useState('ABCDE');
  const [orientation, setOrientation] = useState<'down' | 'across'>('down');
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [markersBusy, setMarkersBusy] = useState(false);
  const [cloudRows, setCloudRows] = useState<CloudTemplateRow[]>([]);
  const [cloudBusy, setCloudBusy] = useState(false);
  const fileImportRef = useRef<HTMLInputElement>(null);

  const labels = useMemo(
    () => [...new Set(labelsInput.trim().toUpperCase().split('').filter(Boolean))],
    [labelsInput]
  );

  const offsets = useMemo(() => omrQuestionOffsets(template.areas), [template.areas]);

  // ---------- canvas rendering ----------
  const render = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !sample) return;
    const sheet = sample.canvas;
    const maxW = wrapRef.current?.clientWidth ?? 800;
    const scale = Math.min(1, maxW / sheet.width, 760 / sheet.height);
    cv.width = Math.round(sheet.width * scale);
    cv.height = Math.round(sheet.height * scale);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(sheet, 0, 0, cv.width, cv.height);

    const W = cv.width;
    const H = cv.height;
    const lw = Math.max(1.5, W / 500);

    template.markers.forEach((m, i) => {
      ctx.save();
      ctx.strokeStyle = '#64748b';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = lw;
      ctx.strokeRect(m.x * W, m.y * H, m.w * W, m.h * H);
      ctx.setLineDash([]);
      ctx.fillStyle = '#64748b';
      ctx.font = `${Math.max(10, W / 55)}px sans-serif`;
      ctx.fillText(`M${i + 1}`, m.x * W, m.y * H - 3);
      ctx.restore();
    });

    template.areas.forEach((a, k) => {
      const x = a.x * W;
      const y = a.y * H;
      const w = a.w * W;
      const h = a.h * H;
      const color = AREA_COLORS[a.type];
      ctx.strokeStyle = color;
      ctx.lineWidth = k === template.areas.length - 1 && !dragRef.current ? lw * 1.4 : lw;
      ctx.strokeRect(x, y, w, h);

      if (a.type === 'omr') {
        const aq = a.questions ?? 1;
        const lbs = a.labels ?? ['A', 'B', 'C', 'D'];
        const rows = a.orientation === 'across' ? lbs.length : aq;
        const cols = a.orientation === 'across' ? aq : lbs.length;
        ctx.lineWidth = 1;
        ctx.strokeStyle = color + '55';
        for (let i = 1; i < rows; i++) {
          ctx.beginPath();
          ctx.moveTo(x, y + (h * i) / rows);
          ctx.lineTo(x + w, y + (h * i) / rows);
          ctx.stroke();
        }
        for (let j = 1; j < cols; j++) {
          ctx.beginPath();
          ctx.moveTo(x + (w * j) / cols, y);
          ctx.lineTo(x + (w * j) / cols, y + h);
          ctx.stroke();
        }
      }
      ctx.fillStyle = color;
      ctx.font = `bold ${Math.max(12, W / 50)}px sans-serif`;
      const name =
        a.type === 'omr'
          ? `Q${(offsets[k] ?? 0) + 1}–${(offsets[k] ?? 0) + (a.questions ?? 1)}`
          : a.type === 'bcr'
            ? L('باركود', 'BARCODE')
            : L('نص', 'TEXT');
      ctx.fillText(name, x + 3, y - 4);
    });

    const drag = dragRef.current;
    if (drag) {
      ctx.strokeStyle = '#ef4444';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = lw * 1.2;
      ctx.strokeRect(
        Math.min(drag.x0, drag.x1),
        Math.min(drag.y0, drag.y1),
        Math.abs(drag.x1 - drag.x0),
        Math.abs(drag.y1 - drag.y0)
      );
      ctx.setLineDash([]);
    }
  }, [sample, template, offsets, L]);

  useEffect(() => {
    render();
    const onResize = () => render();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [render]);

  // ---------- pointer interactions ----------
  const normPt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return { x: 0, y: 0 };
    const r = cv.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * cv.width) / r.width / cv.width,
      y: ((e.clientY - r.top) * cv.height) / r.height / cv.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = normPt(e);
    dragRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const p = normPt(e);
    dragRef.current.x1 = p.x;
    dragRef.current.y1 = p.y;
    render();
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    if (w < 0.01 || h < 0.005) {
      render();
      return;
    }
    const area: FormArea = {
      id: uid(),
      type: drawType,
      name:
        drawType === 'omr'
          ? `${L('شبكة', 'Grid')} ${(offsets.at(-1) ?? 0) + 1}`
          : drawType === 'bcr'
            ? `${L('باركود', 'Barcode')} ${template.areas.filter((a) => a.type === 'bcr').length + 1}`
            : `${L('نص', 'Text')} ${template.areas.filter((a) => a.type === 'ocr').length + 1}`,
      x,
      y,
      w,
      h,
    };
    if (drawType === 'omr') {
      area.questions = Math.max(1, Math.min(500, questions));
      area.labels = labels.length >= 2 ? labels : ['A', 'B', 'C', 'D'];
      area.orientation = orientation;
    } else if (drawType === 'ocr') {
      area.lang = 'eng';
      area.handwriting = false;
    }
    addArea(area);
    setSelectedAreaId(area.id);
    render();
    toast.success(L('تمت إضافة المنطقة', 'Area added'));
  };

  // ---------- template settings ----------
  const selectedArea = template.areas.find((a) => a.id === selectedAreaId) ?? null;

  const exportJson = () => {
    downloadBlob(new Blob([templateToJson(template)], { type: 'application/json' }), `${template.name || 'form'}.template.json`);
    toast.success(L('تم تنزيل القالب', 'Template downloaded'));
  };

  const importJson = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text()) as FormTemplate;
      if (!Array.isArray(raw.areas)) throw new Error('bad');
      setTemplate((t) => ({
        ...t,
        name: raw.name || t.name,
        areas: raw.areas,
        markers: Array.isArray(raw.markers) ? raw.markers : [],
        threshold: Number.isFinite(raw.threshold) ? raw.threshold : t.threshold,
        lenient: Boolean(raw.lenient),
        key: raw.key && typeof raw.key === 'object' ? raw.key : {},
        weights: raw.weights && typeof raw.weights === 'object' ? raw.weights : {},
        negative: Number.isFinite(raw.negative) ? raw.negative : 0,
      }));
      toast.success(L('تم استيراد القالب', 'Template imported'));
    } catch {
      toast.error(L('ملف قالب غير صالح', 'Invalid template file'));
    }
  };

  const autoDetectMarkers = async () => {
    if (!sample) return;
    setMarkersBusy(true);
    try {
      await new Promise((r) => setTimeout(r, 30));
      const gray = normalizeContrast(toGray(sample.canvas));
      const found = guessMarkers(gray);
      if (found.length >= 3) {
        setTemplate((t) => ({ ...t, markers: found }));
        toast.success(
          L(`تم العثور على ${found.length} علامات زاوية`, `Found ${found.length} corner markers`)
        );
      } else {
        toast.error(
          L('لم تُعثر على علامات — استخدم مولّد الأوراق أو ارسم مستطيلات العلامات يدويًا', 'No markers found — use the sheet generator or add marker rectangles manually')
        );
      }
    } finally {
      setMarkersBusy(false);
    }
  };

  // ---------- cloud templates ----------
  const loadCloudList = async () => {
    setCloudBusy(true);
    try {
      const res = await fetch('/api/form-templates');
      if (res.ok) setCloudRows(await res.json());
    } catch {
      /* offline is fine — file JSON always works */
    } finally {
      setCloudBusy(false);
    }
  };
  useEffect(() => {
    void loadCloudList();
  }, []);

  const saveCloud = async () => {
    setCloudBusy(true);
    try {
      const res = await fetch('/api/form-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(template),
      });
      if (res.ok) {
        toast.success(L('حُفظ القالب على الخادم', 'Template saved to the server'));
        void loadCloudList();
      } else toast.error(L('فشل الحفظ', 'Save failed'));
    } finally {
      setCloudBusy(false);
    }
  };

  const loadCloud = async (id: string) => {
    setCloudBusy(true);
    try {
      const res = await fetch(`/api/form-templates/${id}`);
      if (res.ok) {
        const data = (await res.json()) as { data: FormTemplate };
        useFormsStore.getState().loadTemplateObject(data.data);
        toast.success(L('تم تحميل القالب', 'Template loaded'));
      }
    } finally {
      setCloudBusy(false);
    }
  };

  const deleteCloud = async (id: string) => {
    setCloudBusy(true);
    try {
      const res = await fetch(`/api/form-templates/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setCloudRows((rows) => rows.filter((r) => r.id !== id));
        toast.success(L('حُذف القالب', 'Template deleted'));
      }
    } finally {
      setCloudBusy(false);
    }
  };

  if (!sample) {
    return (
      <div dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <EmptyState icon={Scan} title={L('حمّل أوراقًا أولًا', 'Load sheets first')} hint={L('أضف صورًا أو ملفات PDF من خطوة التحميل لتبدأ رسم المناطق.', 'Add images or PDFs from the load step to start drawing areas.')} />
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* canvas */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold">
              2. {L('ارسم المناطق على الورقة المرجعية', 'Draw areas on the reference sheet')}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" className="gap-1" onClick={() => { const last = template.areas[template.areas.length - 1]; if (last) { removeArea(last.id); setSelectedAreaId(null); } }}>
                <Undo2 className="h-3.5 w-3.5" /> {L('تراجع', 'Undo')}
              </Button>
              <Button size="sm" variant="outline" className="gap-1" disabled={markersBusy} onClick={() => void autoDetectMarkers()}>
                {markersBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Crosshair className="h-3.5 w-3.5" />}
                {L('اكتشاف العلامات', 'Detect markers')}
              </Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={onGenerateSheets}>
                <Scan className="h-3.5 w-3.5" /> {L('توليد أوراق للطباعة', 'Generate printable sheets')}
              </Button>
            </div>
          </div>
          <div ref={wrapRef} className="max-h-[64vh] overflow-auto rounded-xl border border-border bg-muted p-2 pw-scroll">
            <canvas
              ref={canvasRef}
              className="block h-auto w-full cursor-crosshair touch-none"
              aria-label={L('محرر المناطق', 'Area editor canvas')}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {L(
              'اسحب مستطيلًا حول شبكة الفقاعات (الفقاعات فقط دون العناوين)، أو حول منطقة النص/الباركود. ترقيم الأسئلة متصل عبر كل شبكات OMR.',
              'Drag a rectangle tightly around a bubble grid (bubbles only, no headers), or around a text/barcode region. Question numbering runs continuously across all OMR areas.'
            )}
          </p>
        </CardContent>
      </Card>

      {/* settings */}
      <div className="space-y-3">
        <Card>
          <CardContent className="space-y-3 p-4">
            <h3 className="text-sm font-bold">{L('إعدادات المنطقة الجديدة', 'New area settings')}</h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px]">{L('النوع', 'Type')}</Label>
                <Select value={drawType} onValueChange={(v) => setDrawType(v as AreaType)}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="omr">{L('شبكة تظليل (OMR)', 'Marks grid (OMR)')}</SelectItem>
                    <SelectItem value="ocr">{L('منطقة نص (OCR)', 'Text region (OCR)')}</SelectItem>
                    <SelectItem value="bcr">{L('باركود/QR', 'Barcode / QR')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {drawType === 'omr' ? (
                <>
                  <div>
                    <Label className="text-[11px]">{L('عدد الأسئلة', 'Questions')}</Label>
                    <Input className="h-8" type="number" min={1} max={500} value={questions} onChange={(e) => setQuestions(Math.max(1, Number(e.target.value) || 1))} />
                  </div>
                  <div>
                    <Label className="text-[11px]">{L('رموز الخيارات', 'Option labels')}</Label>
                    <Input className="h-8" value={labelsInput} onChange={(e) => setLabelsInput(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-[11px]">{L('اتجاه الأسئلة', 'Questions run')}</Label>
                    <Select value={orientation} onValueChange={(v) => setOrientation(v as 'down' | 'across')}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="down">{L('أسفل (صفوف)', 'Down (rows)')}</SelectItem>
                        <SelectItem value="across">{L('عبر (أعمدة)', 'Across (columns)')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2 flex flex-wrap gap-1">
                    {DEFAULT_OPTION_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setLabelsInput(p.labels.join(''))}
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition ${
                          labelsInput === p.labels.join('') ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-border text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="col-span-2 rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                  {drawType === 'bcr'
                    ? L('سيُقرأ المنطقة كرمز QR ثم كباركودات خطية (Code128/EAN/ITF…) مع إعادة المحاولة بالتدوير.', 'Decoded as QR first, then 1D barcodes (Code128/EAN/ITF…) with rotation retries.')
                    : L('سيُستخرج النص المطبوع (Tesseract داخل المتصفح) أو الخط اليدوي عبر نموذج الرؤية إن فُعّل لاحقًا.', 'Printed text via in-browser Tesseract; handwritten text can go to a vision model when enabled.')}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {selectedArea && (
          <Card>
            <CardContent className="space-y-2.5 p-4">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-bold">
                  <CircleDot className="h-4 w-4" style={{ color: AREA_COLORS[selectedArea.type] }} />
                  {L('المنطقة المحددة', 'Selected area')} — {selectedArea.name}
                </h3>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-red-500" onClick={() => { removeArea(selectedArea.id); setSelectedAreaId(null); }}>
                  <Trash2 className="h-3.5 w-3.5" /> {L('حذف', 'Delete')}
                </Button>
              </div>
              {selectedArea.type === 'omr' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[11px]">{L('الأسئلة', 'Questions')}</Label>
                    <Input
                      className="h-8"
                      type="number"
                      min={1}
                      max={500}
                      value={selectedArea.questions ?? 1}
                      onChange={(e) => updateArea(selectedArea.id, { questions: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">{L('الاتجاه', 'Orientation')}</Label>
                    <Select
                      value={selectedArea.orientation ?? 'down'}
                      onValueChange={(v) => updateArea(selectedArea.id, { orientation: v as 'down' | 'across' })}
                    >
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="down">{L('أسفل', 'Down')}</SelectItem>
                        <SelectItem value="across">{L('عبر', 'Across')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {selectedArea.type === 'ocr' && (
                <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                  <div>
                    <div className="text-xs font-semibold">{L('نص يدوي (نموذج رؤية)', 'Handwritten (vision model)')}</div>
                    <div className="text-[10px] text-muted-foreground">{L('يُرسل قصاصة المنطقة إلى الخادم فقط', 'Only this region crop is sent to the server')}</div>
                  </div>
                  <Switch checked={Boolean(selectedArea.handwriting)} onCheckedChange={(v) => updateArea(selectedArea.id, { handwriting: v })} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="space-y-3 p-4">
            <h3 className="text-sm font-bold">{L('المناطق', 'Areas')} ({template.areas.length})</h3>
            {!template.areas.length ? (
              <p className="text-xs text-muted-foreground">{L('لا مناطق بعد — اسحب مستطيلًا على الورقة', 'None yet — drag a rectangle on the sheet')}</p>
            ) : (
              <ul className="max-h-96 space-y-1 overflow-y-auto pw-scroll pe-1">
                {template.areas.map((a, k) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedAreaId(a.id)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                        selectedAreaId === a.id ? 'border-emerald-500 bg-emerald-500/10' : 'border-border hover:bg-accent'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: AREA_COLORS[a.type] }} />
                        {a.type === 'omr' ? `OMR Q${(offsets[k] ?? 0) + 1}–${(offsets[k] ?? 0) + (a.questions ?? 1)} · ${(a.labels ?? []).join('')} · ${a.orientation === 'across' ? L('عبر', 'across') : L('أسفل', 'down')}` : a.type === 'bcr' ? L('باركود', 'Barcode') : L('نص', 'Text')}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{(a.x * 100).toFixed(1)}%,{(a.y * 100).toFixed(1)}%</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <h3 className="text-sm font-bold">{L('إعدادات القراءة', 'Reading settings')}</h3>
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <Label>{L('حساسية التظليل', 'Mark sensitivity')}</Label>
                <span className="font-bold">{template.threshold.toFixed(2)}</span>
              </div>
              <Slider value={[template.threshold]} min={0.03} max={0.4} step={0.01} onValueChange={([v]) => setTemplate({ threshold: v })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <div>
                <div className="text-xs font-semibold">{L('الوضع المتساهل', 'Lenient mode')}</div>
                <div className="text-[10px] text-muted-foreground">{L('إن وُجد تظليل متعدد واضح التفوق يُعتمد الأغمق', 'When multiple marks have a clear darkest cell (≥0.08 margin), take it')}</div>
              </div>
              <Switch checked={template.lenient} onCheckedChange={(v) => setTemplate({ lenient: v })} />
            </div>
            <div className="text-[11px] text-muted-foreground">
              {template.markers.length
                ? L(`${template.markers.length} علامات محاذاة مسجّلة`, `${template.markers.length} alignment markers registered`)
                : L('لا علامات محاذاة — سيُستخدم تصحيح الميل فقط', 'No alignment markers — deskew-only fallback')}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2.5 p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-bold"><Save className="h-4 w-4" /> {L('حفظ القالب', 'Save template')}</h3>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" className="gap-1" onClick={exportJson}>
                <FileJson className="h-3.5 w-3.5" /> {L('تنزيل JSON', 'Download JSON')}
              </Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={() => fileImportRef.current?.click()}>
                <FileJson className="h-3.5 w-3.5" /> {L('استيراد JSON', 'Import JSON')}
              </Button>
              <Button size="sm" variant="outline" className="gap-1" disabled={cloudBusy} onClick={() => void saveCloud()}>
                <Save className="h-3.5 w-3.5" /> {L('حفظ على الخادم', 'Save to server')}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-red-500" onClick={() => (setTemplate((t) => ({ ...t, markers: [] })), toast.success(L('أُزيلت العلامات', 'Markers cleared')))}>
                <Eraser className="h-3.5 w-3.5" /> {L('مسح العلامات', 'Clear markers')}
              </Button>
            </div>
            <input
              ref={fileImportRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importJson(f);
                e.target.value = '';
              }}
            />
            {cloudRows.length > 0 && (
              <ul className="max-h-96 space-y-1 overflow-y-auto pw-scroll pe-1">
                {cloudRows.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={cloudBusy} onClick={() => void loadCloud(row.id)}>
                      {L('تحميل', 'Load')}
                    </Button>
                    <button type="button" aria-label={L('حذف', 'Delete')} className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-500" onClick={() => void deleteCloud(row.id)}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              size="sm"
              className="btn-primary-grad w-full gap-1 border-0 text-white"
              disabled={!template.areas.length}
              onClick={() => setStep('read')}
            >
              {L('التالي: قراءة كل الأوراق', 'Next: read all sheets')} →
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
