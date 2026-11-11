'use client';

// ============================================================
// ALNOKHBA QB — السبورة التفاعلية (Digital Whiteboard)
// لوحة رسم تعليمية للمعلم: قلم، قلم تظليل، ممحاة، أشكال، نص عربي،
// صور، لوحة ألوان، تراجع/إعادة بسجل كامل، مسح مع تأكيد، وتصدير
// PNG/PDF (pdf-lib) بالكامل من جهة العميل.
// لوحة <canvas> واحدة مع devicePixelRatio وأحداث المؤشر
// (فأرة + لمس + قلم رقمي) وإعادة رسم من السجل عند تغيير الحجم.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent as ReactChangeEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import {
  Circle,
  Download,
  Eraser,
  FileDown,
  Highlighter,
  ImagePlus,
  LoaderCircle,
  Minus,
  MoveUpRight,
  Pencil,
  Pipette,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

// ————— ثوابت —————
const MAX_HISTORY = 60; // سقف سجل التراجع
const HIGHLIGHT_ALPHA = 0.35; // شفافية قلم التظليل
const HIGHLIGHT_SCALE = 3.5; // مضاعف سماكة التظليل
const ERASER_SCALE = 2.5; // مضاعف سماكة الممحاة
const FONT_FAMILY = 'Tajawal, "Segoe UI", Tahoma, sans-serif';
const textFontSize = (size: number) => Math.round(14 + size * 1.5);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// ————— الأنواع —————
type Tool = 'pen' | 'highlighter' | 'eraser' | 'shape' | 'text' | 'image';
type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';
type Point = { x: number; y: number };

type StrokeAction = {
  id: number;
  kind: 'stroke';
  tool: 'pen' | 'highlighter' | 'eraser';
  color: string;
  size: number;
  points: Point[];
};
type ShapeAction = {
  id: number;
  kind: 'shape';
  shape: ShapeKind;
  color: string;
  size: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
type TextAction = {
  id: number;
  kind: 'text';
  text: string;
  color: string;
  fontSize: number;
  x: number;
  y: number;
};
type ImageAction = {
  id: number;
  kind: 'image';
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
type Action = StrokeAction | ShapeAction | TextAction | ImageAction;

type StrokeDraft = { type: 'stroke'; drawn: number; action: StrokeAction };
type ShapeDraft = { type: 'shape'; action: ShapeAction };
type Draft = StrokeDraft | ShapeDraft;

type PendingImage = { src: string; w: number; h: number; el: HTMLImageElement };

// ————— بيانات الأدوات والألوان —————
const TOOL_AR: Record<Tool, string> = {
  pen: 'قلم',
  highlighter: 'قلم تظليل',
  eraser: 'ممحاة',
  shape: 'أشكال',
  text: 'نص',
  image: 'صورة',
};
const TOOL_EN: Record<Tool, string> = {
  pen: 'Pen',
  highlighter: 'Highlighter',
  eraser: 'Eraser',
  shape: 'Shapes',
  text: 'Text',
  image: 'Image',
};

const SWATCHES: { color: string; name: string }[] = [
  { color: '#0a0a0a', name: 'أسود' },
  { color: '#ffffff', name: 'أبيض' },
  { color: '#059669', name: 'زمردي' },
  { color: '#16a34a', name: 'أخضر' },
  { color: '#0d9488', name: 'تركوازي' },
  { color: '#d97706', name: 'كهرماني' },
  { color: '#ea580c', name: 'برتقالي' },
  { color: '#dc2626', name: 'أحمر' },
  { color: '#db2777', name: 'وردي' },
];

const SHAPES: { kind: ShapeKind; label: string; en: string; icon: LucideIcon }[] = [
  { kind: 'rect', label: 'مستطيل', en: 'Rectangle', icon: Square },
  { kind: 'ellipse', label: 'بيضاوي', en: 'Ellipse', icon: Circle },
  { kind: 'line', label: 'خط', en: 'Line', icon: Minus },
  { kind: 'arrow', label: 'سهم', en: 'Arrow', icon: MoveUpRight },
];

// ————— دوال الرسم (نقية، على مستوى الوحدة) —————
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** رسم مسار حر بنعومة تربيعية (نقطة المنتصف) — لإعادة رسم السجل. */
const strokeSmooth = (ctx: CanvasRenderingContext2D, pts: Point[]) => {
  if (pts.length === 1) {
    // نقطة مفردة: دائرة ممتلئة (تعمل مع الممحاة destination-out أيضًا)
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(0.6, ctx.lineWidth / 2), 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const m = midpoint(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
};

/** رسم شكل هندسي (مستطيل/بيضاوي/خط/سهم) ثم stroke. */
const drawShapePath = (
  ctx: CanvasRenderingContext2D,
  s: { shape: ShapeKind; x1: number; y1: number; x2: number; y2: number },
) => {
  const x = Math.min(s.x1, s.x2);
  const y = Math.min(s.y1, s.y2);
  const w = Math.abs(s.x2 - s.x1);
  const h = Math.abs(s.y2 - s.y1);
  ctx.beginPath();
  if (s.shape === 'rect') {
    ctx.rect(x, y, w, h);
  } else if (s.shape === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (s.shape === 'line') {
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
  } else {
    // سهم: خط + رأس سهم
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = Math.max(10, ctx.lineWidth * 3);
    for (const spread of [Math.PI * 0.83, -Math.PI * 0.83]) {
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 + head * Math.cos(angle + spread), s.y2 + head * Math.sin(angle + spread));
    }
  }
  ctx.stroke();
};

/** إعادة رسم عنصر واحد من السجل (القلم/التظليل/الممحاة/شكل/نص/صورة). */
const drawAction = (
  ctx: CanvasRenderingContext2D,
  a: Action,
  images: Map<number, HTMLImageElement>,
) => {
  switch (a.kind) {
    case 'stroke': {
      ctx.save();
      ctx.globalCompositeOperation =
        a.tool === 'eraser' ? 'destination-out' : a.tool === 'highlighter' ? 'multiply' : 'source-over';
      ctx.globalAlpha = a.tool === 'highlighter' ? HIGHLIGHT_ALPHA : 1;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      strokeSmooth(ctx, a.points);
      ctx.restore();
      break;
    }
    case 'shape': {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      drawShapePath(ctx, a);
      ctx.restore();
      break;
    }
    case 'text': {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = a.color;
      ctx.font = `700 ${a.fontSize}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.text, a.x, a.y);
      ctx.restore();
      break;
    }
    case 'image': {
      const img = images.get(a.id);
      if (!img) break;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(img, a.x, a.y, a.w, a.h);
      ctx.restore();
      break;
    }
  }
};

/** حساب أبعاد الصورة عند الإدراج (داخل حدود اللوحة، دون تكبير مبالغ فيه). */
const plannedImageSize = (board: { w: number; h: number }, img: { w: number; h: number }) => {
  let w = Math.min(img.w, board.w * 0.6, 340);
  w = Math.max(24, Math.min(w, board.w - 8));
  let h = (w * img.h) / Math.max(1, img.w);
  if (h > board.h - 8) {
    h = Math.max(24, board.h - 8);
    w = (h * img.w) / Math.max(1, img.h);
  }
  return { w, h };
};

/** معاينات فوق اللوحة: شكل أثناء السحب + شبح الصورة قبل وضعها. */
const drawOverlays = (
  ctx: CanvasRenderingContext2D,
  draft: Draft | null,
  ghost: Point | null,
  pending: PendingImage | null,
  board: { w: number; h: number },
) => {
  if (draft?.type === 'shape') {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = draft.action.color;
    ctx.lineWidth = draft.action.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([8, 6]);
    drawShapePath(ctx, draft.action);
    ctx.restore();
  }
  if (ghost && pending) {
    const { w, h } = plannedImageSize(board, pending);
    const x = ghost.x - w / 2;
    const y = ghost.y - h / 2;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.drawImage(pending.el, x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#059669';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
};

/** تنزيل Blob باسم ملف (PNG/PDF). */
const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
};

// ————— زر أداة موحّد (تلميح عربي + تلميح إنجليزي صغير) —————
function ToolButton({
  active,
  label,
  en,
  onClick,
  disabled,
  children,
  danger,
}: {
  active?: boolean;
  label: string;
  en: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  danger?: boolean;
}) {
  const stateClass = active
    ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 hover:text-white'
    : danger
      ? 'border-slate-300 bg-white text-slate-600 hover:border-red-400 hover:bg-red-50 hover:text-red-600'
      : 'border-slate-300 bg-white text-slate-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={`size-9 ${stateClass}`}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span className="text-xs font-bold">{label}</span>
        <span className="mr-1.5 text-[10px] opacity-70" dir="ltr">
          {en}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

// ————— المكوّن الرئيسي —————
export default function Whiteboard() {
  // حالة واجهة
  const [tool, setTool] = useState<Tool>('pen');
  const [shapeKind, setShapeKind] = useState<ShapeKind>('rect');
  const [color, setColor] = useState('#0a0a0a');
  const [size, setSize] = useState(4);
  const [histLen, setHistLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);
  const [textBox, setTextBox] = useState<Point | null>(null);
  const [pendingImage, setPendingImage] = useState<{ src: string; w: number; h: number } | null>(null);
  const [busy, setBusy] = useState<'png' | 'pdf' | null>(null);

  // مراجع الرسم والسجل
  const boardRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const historyRef = useRef<Action[]>([]);
  const redoRef = useRef<Action[]>([]);
  const imagesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const draftRef = useRef<Draft | null>(null);
  const ghostRef = useRef<Point | null>(null);
  const pendingRef = useRef<PendingImage | null>(null);
  const textBoxRef = useRef<Point | null>(null);
  const textValueRef = useRef('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const idRef = useRef(1);
  const strokeRaf = useRef<number | null>(null);
  const previewRaf = useRef<number | null>(null);
  const resizeRaf = useRef<number | null>(null);

  const nextId = () => idRef.current++;

  // ————— إعادة الرسم الكاملة من السجل —————
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const { w, h, dpr } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const a of historyRef.current) drawAction(ctx, a, imagesRef.current);
    drawOverlays(ctx, draftRef.current, ghostRef.current, pendingRef.current, sizeRef.current);
  }, []);

  // ————— إدارة السجل —————
  const pushAction = useCallback(
    (a: Action) => {
      historyRef.current.push(a);
      if (historyRef.current.length > MAX_HISTORY) {
        const dropped = historyRef.current.shift();
        if (dropped) imagesRef.current.delete(dropped.id);
      }
      redoRef.current = [];
      setHistLen(historyRef.current.length);
      setRedoLen(0);
      redraw();
    },
    [redraw],
  );

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.length) return;
    const a = h.pop();
    if (a) redoRef.current.push(a);
    setHistLen(h.length);
    setRedoLen(redoRef.current.length);
    redraw();
  }, [redraw]);

  const redo = useCallback(() => {
    const r = redoRef.current;
    if (!r.length) return;
    const a = r.pop();
    if (a) {
      historyRef.current.push(a);
      if (historyRef.current.length > MAX_HISTORY) {
        const dropped = historyRef.current.shift();
        if (dropped) imagesRef.current.delete(dropped.id);
      }
    }
    setHistLen(historyRef.current.length);
    setRedoLen(r.length);
    redraw();
  }, [redraw]);

  const clearAll = useCallback(() => {
    historyRef.current = [];
    redoRef.current = [];
    imagesRef.current.clear();
    draftRef.current = null;
    ghostRef.current = null;
    setHistLen(0);
    setRedoLen(0);
    redraw();
  }, [redraw]);

  // ————— تغيير الحجم مع الحفاظ على الرسم (إعادة رسم من السجل) —————
  useEffect(() => {
    const board = boardRef.current;
    const canvas = canvasRef.current;
    if (!board || !canvas) return;
    const apply = () => {
      const w = board.clientWidth;
      const h = board.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      sizeRef.current = { w, h, dpr };
      ctxRef.current = ctx;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      redraw();
    };
    apply();
    const ro = new ResizeObserver(() => {
      if (resizeRaf.current !== null) cancelAnimationFrame(resizeRaf.current);
      resizeRaf.current = requestAnimationFrame(apply);
    });
    ro.observe(board);
    return () => {
      ro.disconnect();
      if (resizeRaf.current !== null) cancelAnimationFrame(resizeRaf.current);
    };
  }, [redraw]);

  // ضمان رسم النصوص بخط Tajawal بعد تحميل الخطوط
  useEffect(() => {
    document.fonts.ready.then(() => redraw());
  }, [redraw]);

  // اختصارات لوحة المفاتيح: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pendingRef.current) {
        pendingRef.current = null;
        ghostRef.current = null;
        setPendingImage(null);
        redraw();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, redraw]);

  // إلغاء المؤقتات عند إلغاء التركيب
  useEffect(
    () => () => {
      for (const r of [strokeRaf, previewRaf, resizeRaf]) {
        if (r.current !== null) cancelAnimationFrame(r.current);
      }
    },
    [],
  );

  // شبكة أمان: إن فُكّ التقاط المؤشر وأُفلِت خارج اللوحة، نُنهي السحبة الحالية
  useEffect(() => {
    const end = () => {
      if (draftRef.current) finishStroke(true);
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  // ————— أدوات مساعدة للرسم الحي —————
  const getPos = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const schedulePreview = () => {
    if (previewRaf.current !== null) return;
    previewRaf.current = requestAnimationFrame(() => {
      previewRaf.current = null;
      redraw();
    });
  };

  /** رسم ذيل الخط الحي (مقاطع مستقيمة بين نقاط المؤشر) — تُنعّم نهائيًا عند الإيداع. */
  const drawStrokeTail = () => {
    strokeRaf.current = null;
    const ctx = ctxRef.current;
    const d = draftRef.current;
    if (!ctx || !d || d.type !== 'stroke') return;
    const pts = d.action.points;
    if (pts.length - d.drawn < 2) return;
    ctx.save();
    ctx.globalCompositeOperation =
      d.action.tool === 'eraser'
        ? 'destination-out'
        : d.action.tool === 'highlighter'
          ? 'multiply'
          : 'source-over';
    ctx.globalAlpha = d.action.tool === 'highlighter' ? HIGHLIGHT_ALPHA : 1;
    ctx.strokeStyle = d.action.color;
    ctx.lineWidth = d.action.size;
    // أطراف قاطعة للتظليل تمنع تراكم الشفافية عند المفاصل (تُعاد الرسمة كاملة عند الإيداع)
    ctx.lineCap = d.action.tool === 'highlighter' ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[d.drawn].x, pts[d.drawn].y);
    for (let i = d.drawn + 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
    d.drawn = pts.length - 1;
  };

  const scheduleStroke = () => {
    if (strokeRaf.current !== null) return;
    strokeRaf.current = requestAnimationFrame(drawStrokeTail);
  };

  const finishStroke = (commit: boolean) => {
    const d = draftRef.current;
    draftRef.current = null;
    if (!d) return;
    if (d.type === 'stroke') {
      if (commit && d.action.points.length >= 1) pushAction(d.action);
      else redraw();
    } else {
      const a = d.action;
      if (commit && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) >= 3) pushAction(a);
      else redraw();
    }
  };

  // ————— نص —————
  const commitText = () => {
    const box = textBoxRef.current;
    if (!box) return;
    const value = textValueRef.current.trim();
    textBoxRef.current = null;
    textValueRef.current = '';
    setTextBox(null);
    if (!value) return;
    pushAction({
      id: nextId(),
      kind: 'text',
      text: value,
      color,
      fontSize: textFontSize(size),
      x: box.x,
      y: box.y,
    });
  };

  const cancelText = () => {
    textBoxRef.current = null;
    textValueRef.current = '';
    setTextBox(null);
  };

  // تركيز حقل النص عند فتحه
  useEffect(() => {
    if (textBox) inputRef.current?.focus();
  }, [textBox]);

  // ————— صورة —————
  const onPickImage = (e: ReactChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result ?? '');
      const img = new Image();
      img.onload = () => {
        pendingRef.current = { src, w: img.naturalWidth || 200, h: img.naturalHeight || 200, el: img };
        setPendingImage({ src, w: img.naturalWidth || 200, h: img.naturalHeight || 200 });
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  const placePendingImage = (pos: Point) => {
    const p = pendingRef.current;
    if (!p) return;
    const { w: bw, h: bh } = sizeRef.current;
    const { w, h } = plannedImageSize(sizeRef.current, p);
    const x = clamp(pos.x - w / 2, 4, Math.max(4, bw - w - 4));
    const y = clamp(pos.y - h / 2, 4, Math.max(4, bh - h - 4));
    const id = nextId();
    imagesRef.current.set(id, p.el);
    pendingRef.current = null;
    ghostRef.current = null;
    setPendingImage(null);
    pushAction({ id, kind: 'image', src: p.src, x, y, w, h });
  };

  // ————— تبديل الأداة —————
  const chooseTool = (t: Tool) => {
    if (textBoxRef.current) commitText();
    setTool(t);
    pendingRef.current = null;
    setPendingImage(null);
    ghostRef.current = null;
  };

  // ————— معالجات المؤشر —————
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pos = getPos(e);

    if (tool === 'text') {
      if (textBoxRef.current) commitText();
      textBoxRef.current = pos;
      textValueRef.current = '';
      setTextBox(pos);
      return;
    }

    if (tool === 'image') {
      if (pendingRef.current) placePendingImage(pos);
      return;
    }

    if (draftRef.current) return; // تجاهل الإصبع/الزر الثاني أثناء الرسم

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* بعض المتصفحات قد ترفض الالتقاط — نكمل بدونه */
    }

    if (tool === 'shape') {
      draftRef.current = {
        type: 'shape',
        action: {
          id: nextId(),
          kind: 'shape',
          shape: shapeKind,
          color,
          size,
          x1: pos.x,
          y1: pos.y,
          x2: pos.x,
          y2: pos.y,
        },
      };
      schedulePreview();
      return;
    }

    // قلم / تظليل / ممحاة
    const scaled =
      tool === 'highlighter'
        ? Math.max(size * HIGHLIGHT_SCALE, 12)
        : tool === 'eraser'
          ? Math.max(size * ERASER_SCALE, 10)
          : size;
    draftRef.current = {
      type: 'stroke',
      drawn: 0,
      action: { id: nextId(), kind: 'stroke', tool, color, size: scaled, points: [pos] },
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const pos = getPos(e);
    const d = draftRef.current;
    if (d) {
      if (d.type === 'stroke') {
        const pts = d.action.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(pos.x - last.x, pos.y - last.y) >= 1) {
          pts.push(pos);
          scheduleStroke();
        }
      } else {
        d.action.x2 = pos.x;
        d.action.y2 = pos.y;
        schedulePreview();
      }
      return;
    }
    if (pendingRef.current) {
      ghostRef.current = pos;
      schedulePreview();
    }
  };

  const onPointerUp = () => finishStroke(true);
  const onPointerCancel = () => finishStroke(false);

  const onPointerLeave = () => {
    if (ghostRef.current) {
      ghostRef.current = null;
      schedulePreview();
    }
  };

  // ————— التصدير —————
  /** تركيب اللوحة الحالية فوق خلفية بيضاء (بنفس دقة الجهاز). */
  const compositeOnWhite = (): HTMLCanvasElement | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const c = out.getContext('2d');
    if (!c) return null;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, out.width, out.height);
    c.drawImage(canvas, 0, 0);
    return out;
  };

  const exportPng = async () => {
    const out = compositeOnWhite();
    if (!out) return;
    setBusy('png');
    try {
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
      if (blob) downloadBlob(blob, 'whiteboard.png');
    } finally {
      setBusy(null);
    }
  };

  const exportPdf = async () => {
    const out = compositeOnWhite();
    if (!out) return;
    setBusy('pdf');
    try {
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
      if (!blob) return;
      const buf = await blob.arrayBuffer();
      const { PDFDocument } = await import('pdf-lib');
      const pdf = await PDFDocument.create();
      const png = await pdf.embedPng(buf);
      const page = pdf.addPage([841.89, 595.28]); // A4 أفقي
      const margin = 26;
      const maxW = page.getWidth() - margin * 2;
      const maxH = page.getHeight() - margin * 2;
      const scale = Math.min(maxW / png.width, maxH / png.height);
      const w = png.width * scale;
      const h = png.height * scale;
      page.drawImage(png, {
        x: (page.getWidth() - w) / 2,
        y: (page.getHeight() - h) / 2,
        width: w,
        height: h,
      });
      const bytes = await pdf.save();
      downloadBlob(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'whiteboard.pdf');
    } catch (err) {
      console.error('PDF export failed', err);
    } finally {
      setBusy(null);
    }
  };

  // ————— قيم مشتقة —————
  const cursor =
    tool === 'text'
      ? 'text'
      : tool === 'eraser'
        ? 'cell'
        : tool === 'image'
          ? pendingImage
            ? 'copy'
            : 'default'
          : 'crosshair';
  const isCustomColor = !SWATCHES.some((s) => s.color === color);
  const CurrentShapeIcon = SHAPES.find((s) => s.kind === shapeKind)?.icon ?? Square;
  const toolLabel = tool === 'shape' ? `أشكال — ${SHAPES.find((s) => s.kind === shapeKind)?.label ?? ''}` : TOOL_AR[tool];

  return (
    <div className="w-full">
      <div className="rounded-2xl border border-slate-200 bg-slate-100 p-2 shadow-sm sm:p-3" dir="rtl">
        {/* ————— شريط الأدوات ————— */}
        <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="أدوات السبورة">
          <ToolButton active={tool === 'pen'} label={TOOL_AR.pen} en={TOOL_EN.pen} onClick={() => chooseTool('pen')}>
            <Pencil className="size-4" />
          </ToolButton>
          <ToolButton
            active={tool === 'highlighter'}
            label={TOOL_AR.highlighter}
            en={TOOL_EN.highlighter}
            onClick={() => chooseTool('highlighter')}
          >
            <Highlighter className="size-4" />
          </ToolButton>
          <ToolButton
            active={tool === 'eraser'}
            label={TOOL_AR.eraser}
            en={TOOL_EN.eraser}
            onClick={() => chooseTool('eraser')}
          >
            <Eraser className="size-4" />
          </ToolButton>

          {/* الأشكال: قائمة منبثقة لاختيار النوع */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={TOOL_AR.shape}
                    aria-pressed={tool === 'shape'}
                    aria-haspopup="true"
                    className={`size-9 ${tool === 'shape' ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 hover:text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700'}`}
                  >
                    <CurrentShapeIcon className="size-4" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="text-xs font-bold">{TOOL_AR.shape}</span>
                <span className="mr-1.5 text-[10px] opacity-70" dir="ltr">
                  {TOOL_EN.shape}
                </span>
              </TooltipContent>
            </Tooltip>
            <PopoverContent dir="rtl" align="start" className="w-auto p-2">
              <div className="grid grid-cols-2 gap-1">
                {SHAPES.map((s) => {
                  const on = shapeKind === s.kind;
                  return (
                    <button
                      key={s.kind}
                      type="button"
                      aria-label={s.label}
                      aria-pressed={on}
                      onClick={() => {
                        setShapeKind(s.kind);
                        chooseTool('shape');
                      }}
                      className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition ${
                        on
                          ? 'border-emerald-600 bg-emerald-600 text-white'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700'
                      }`}
                    >
                      <s.icon className="size-4" />
                      {s.label}
                      <span className="text-[9px] font-normal opacity-60" dir="ltr">
                        {s.en}
                      </span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          <ToolButton active={tool === 'text'} label={TOOL_AR.text} en={TOOL_EN.text} onClick={() => chooseTool('text')}>
            <Type className="size-4" />
          </ToolButton>
          <ToolButton
            active={tool === 'image'}
            label={TOOL_AR.image}
            en={TOOL_EN.image}
            onClick={() => {
              chooseTool('image');
              fileRef.current?.click();
            }}
          >
            <ImagePlus className="size-4" />
          </ToolButton>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={onPickImage}
          />

          <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-slate-300 sm:block" />

          {/* لوحة الألوان */}
          <div className="flex items-center gap-1" role="group" aria-label="لوحة الألوان">
            {SWATCHES.map((s) => (
              <button
                key={s.color}
                type="button"
                aria-label={`اللون ${s.name}`}
                aria-pressed={color === s.color}
                onClick={() => setColor(s.color)}
                className={`size-9 rounded-lg border shadow-sm transition hover:scale-105 ${
                  color === s.color ? 'border-emerald-600 ring-2 ring-emerald-600 ring-offset-2 ring-offset-slate-100' : 'border-slate-300'
                }`}
                style={{ backgroundColor: s.color }}
              />
            ))}
            <label
              className="relative flex size-9 cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-400 bg-white shadow-sm transition hover:border-emerald-500"
              title="لون مخصص"
            >
              <Pipette className="size-4 text-slate-600" />
              <input
                type="color"
                aria-label="اختيار لون مخصص"
                value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#0a0a0a'}
                onChange={(e) => setColor(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
              {isCustomColor && (
                <span
                  aria-hidden="true"
                  className="absolute -left-1 -top-1 size-3 rounded-full border border-white shadow"
                  style={{ backgroundColor: color }}
                />
              )}
            </label>
          </div>

          <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-slate-300 sm:block" />

          {/* سماكة الخط */}
          <div className="flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 shadow-sm">
            <span className="text-xs font-semibold text-slate-500">السماكة</span>
            <Slider
              value={[size]}
              min={2}
              max={40}
              step={1}
              onValueChange={(v) => setSize(v[0] ?? 4)}
              className="w-24"
              aria-label="سماكة خط الرسم"
            />
            <span className="min-w-6 text-center text-xs font-bold tabular-nums text-slate-700" dir="ltr">
              {size}
            </span>
          </div>

          <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-slate-300 sm:block" />

          {/* تراجع / إعادة / مسح */}
          <ToolButton label="تراجع" en="Undo" onClick={undo} disabled={histLen === 0}>
            <Undo2 className="size-4" />
          </ToolButton>
          <ToolButton label="إعادة" en="Redo" onClick={redo} disabled={redoLen === 0}>
            <Redo2 className="size-4" />
          </ToolButton>
          <AlertDialog>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="مسح اللوحة بالكامل"
                    className="size-9 border-slate-300 bg-white text-slate-600 hover:border-red-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </AlertDialogTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="text-xs font-bold">مسح الكل</span>
                <span className="mr-1.5 text-[10px] opacity-70" dir="ltr">
                  Clear
                </span>
              </TooltipContent>
            </Tooltip>
            <AlertDialogContent dir="rtl">
              <AlertDialogHeader className="text-right sm:text-right">
                <AlertDialogTitle>مسح اللوحة بالكامل؟</AlertDialogTitle>
                <AlertDialogDescription>
                  سيتم حذف كل الرسومات والنصوص والصور نهائيًا، ولا يمكن التراجع عن هذه الخطوة بعد التأكيد.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="sm:justify-start">
                <AlertDialogCancel>إلغاء</AlertDialogCancel>
                <AlertDialogAction
                  onClick={clearAll}
                  className="bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600/40"
                >
                  نعم، امسح الكل
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-slate-300 sm:block" />

          {/* تنزيل PNG / PDF */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportPng}
            disabled={busy !== null}
            aria-label="تنزيل اللوحة كصورة PNG"
            className="h-9 gap-1.5 border-slate-300 bg-white px-3 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
          >
            {busy === 'png' ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
            <span>
              تنزيل <span dir="ltr" className="font-bold">PNG</span>
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportPdf}
            disabled={busy !== null}
            aria-label="تنزيل اللوحة كملف PDF"
            className="h-9 gap-1.5 border-slate-300 bg-white px-3 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
          >
            {busy === 'pdf' ? <LoaderCircle className="size-4 animate-spin" /> : <FileDown className="size-4" />}
            <span>
              تنزيل <span dir="ltr" className="font-bold">PDF</span>
            </span>
          </Button>
        </div>

        {/* ————— اللوحة ————— */}
        <div
          ref={boardRef}
          className="relative mt-2 h-[min(62vh,620px)] min-h-[340px] w-full overflow-hidden rounded-xl border border-slate-300 bg-white shadow-inner"
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="لوحة الرسم البيضاء التفاعلية"
            className="absolute inset-0 h-full w-full touch-none select-none"
            style={{ cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onPointerLeave={onPointerLeave}
            onContextMenu={(e) => e.preventDefault()}
          />

          {/* حقل النص العائم (يدعم العربية) */}
          {textBox && (
            <input
              ref={inputRef}
              type="text"
              dir="auto"
              placeholder="اكتب ثم اضغط Enter"
              onChange={(e) => {
                textValueRef.current = e.target.value;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitText();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelText();
                }
              }}
              onBlur={commitText}
              className="absolute z-10 w-56 -translate-x-1/2 -translate-y-1/2 rounded-lg border-2 border-dashed border-emerald-500 bg-white/90 px-2 py-1 text-center shadow-md outline-none placeholder:text-slate-400 focus:border-emerald-600"
              style={{
                left: textBox.x,
                top: textBox.y,
                color,
                fontSize: textFontSize(size),
                fontFamily: FONT_FAMILY,
                fontWeight: 700,
              }}
            />
          )}

          {/* تلميح وضع الصورة */}
          {pendingImage && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <span className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white shadow-lg">
                انقر على اللوحة لوضع الصورة — Esc للإلغاء
              </span>
            </div>
          )}
        </div>

        {/* ————— شريط الحالة ————— */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            الأداة: <b className="font-bold text-slate-700">{toolLabel}</b>
            <span className="text-slate-300">•</span>
            اللون:
            <span
              aria-hidden="true"
              className="inline-block size-3 rounded-full border border-slate-300 align-middle"
              style={{ backgroundColor: color }}
            />
          </span>
          <span dir="ltr" className="hidden sm:inline">
            Ctrl+Z / Ctrl+Y
          </span>
        </div>
      </div>
    </div>
  );
}
