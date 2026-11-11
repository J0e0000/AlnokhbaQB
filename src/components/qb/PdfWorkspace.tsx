'use client';

// ============================================================
// ALNOKHBA QB — PDF Workspace (مساحة عمل PDF)
// Open → render → thumbnails → page ops → annotations →
// extract for AI → export (original via pdf-lib / flattened)
// Fully client-side: pdfjs-dist v6 + pdf-lib, no uploads.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Eraser,
  FileDown,
  FileUp,
  FolderOpen,
  Hand,
  Highlighter,
  Images,
  Loader2,
  PenLine,
  RotateCw,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/** Payload handed back to the AI extraction module. */
export interface PdfExtractedPage {
  pageNumber: number;
  dataUrl: string;
}

interface PdfWorkspaceProps {
  onExtractPages?: (pages: PdfExtractedPage[]) => void;
}

type ToolId = 'none' | 'pen' | 'highlight' | 'rect' | 'text' | 'eraser';

interface Pt {
  x: number; // normalized 0..1 (relative to rendered page width)
  y: number; // normalized 0..1 (relative to rendered page height)
}

interface AnnBase {
  id: string;
  color: string;
  /** stroke/text size as a fraction of page width (zoom-independent) */
  size: number;
}

interface StrokeAnn extends AnnBase {
  type: 'pen' | 'highlight';
  points: Pt[];
}

interface RectAnn extends AnnBase {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextAnn extends AnnBase {
  type: 'text';
  text: string;
  x: number;
  y: number;
}

type Annotation = StrokeAnn | RectAnn | TextAnn;

interface DrawState {
  cssW: number;
  sizeNorm: number;
  points: Pt[];
  start: Pt;
  current: Pt;
}

// ------------------------------------------------------------
// Constants & pure helpers
// ------------------------------------------------------------

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300];
const THUMB_W = 104;

const TOOLS: { id: ToolId; label: string; icon: typeof PenLine }[] = [
  { id: 'none', label: 'تحريك', icon: Hand },
  { id: 'pen', label: 'قلم', icon: PenLine },
  { id: 'highlight', label: 'تحديد', icon: Highlighter },
  { id: 'rect', label: 'مستطيل', icon: Square },
  { id: 'text', label: 'نص', icon: Type },
  { id: 'eraser', label: 'ممحاة', icon: Eraser },
];

/** Annotation palette — deliberately no blue/indigo (slate/emerald brand). */
const ANN_COLORS = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#1e293b'];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Western digits → Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩). */
const ar = (n: number) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);

const mkId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const normRot = (deg: number) => (((deg % 360) + 360) % 360);

/** Rotate a normalized point around the page center for 90° steps. dir=1 → clockwise. */
const rotPt = (p: Pt, dir: number): Pt => (dir > 0 ? { x: 1 - p.y, y: p.x } : { x: p.y, y: 1 - p.x });

/** Rotate annotation geometry along with its page (90° steps). */
function rotateAnnotation(a: Annotation, dir: number): Annotation {
  if ('points' in a) {
    return { ...a, points: a.points.map((p) => rotPt(p, dir)) };
  }
  if ('w' in a) {
    const c1 = rotPt({ x: a.x, y: a.y }, dir);
    const c2 = rotPt({ x: a.x + a.w, y: a.y + a.h }, dir);
    return {
      ...a,
      x: Math.min(c1.x, c2.x),
      y: Math.min(c1.y, c2.y),
      w: Math.abs(c2.x - c1.x),
      h: Math.abs(c2.y - c1.y),
    };
  }
  return { ...a, ...rotPt({ x: a.x, y: a.y }, dir) };
}

/** Draw one annotation onto a 2D context sized W×H px. */
function drawAnn(ctx: CanvasRenderingContext2D, a: Annotation, W: number, H: number): void {
  ctx.save();
  try {
    if ('points' in a) {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = Math.max(1, a.size * W);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (a.type === 'highlight') ctx.globalAlpha = 0.35;
      ctx.beginPath();
      const first = a.points[0];
      if (!first) return;
      ctx.moveTo(first.x * W, first.y * H);
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x * W, a.points[i].y * H);
      if (a.points.length === 1) ctx.lineTo(first.x * W + 0.01, first.y * H); // single dot
      ctx.stroke();
      return;
    }
    if ('w' in a) {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = Math.max(1, a.size * W);
      ctx.strokeRect(a.x * W, a.y * H, a.w * W, a.h * H);
      return;
    }
    // text note — anchor = top-right corner (natural for Arabic)
    ctx.fillStyle = a.color;
    ctx.font = `600 ${Math.max(10, a.size * W)}px "Tajawal", "Segoe UI", sans-serif`;
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(a.text, a.x * W, a.y * H);
  } finally {
    ctx.restore();
  }
}

/** Hit-test (pixel space) for the eraser — returns true if the click touches the annotation. */
function hitAnn(a: Annotation, px: number, py: number, W: number, H: number): boolean {
  const r = 12;
  if ('points' in a) {
    const rr = Math.max(r, a.size * W);
    return a.points.some((q) => Math.hypot(q.x * W - px, q.y * H - py) <= rr);
  }
  if ('w' in a) {
    const m = r;
    return px >= a.x * W - m && px <= (a.x + a.w) * W + m && py >= a.y * H - m && py <= (a.y + a.h) * H + m;
  }
  return Math.hypot(a.x * W - px, a.y * H - py) <= Math.max(20, a.size * W * 2);
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const canvasToBlob = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );

// ------------------------------------------------------------
// Component
// ------------------------------------------------------------

export default function PdfWorkspace({ onExtractPages }: PdfWorkspaceProps) {
  // ---- document state ----
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [fileName, setFileName] = useState('');
  const [lastFileName, setLastFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // ---- page-ops plan (applied to loaded doc state) ----
  const [order, setOrder] = useState<number[]>([]); // original 0-based indices, current display order
  const [rotations, setRotations] = useState<Record<number, number>>({}); // extra rotation per original index
  const [planChips, setPlanChips] = useState<string[]>([]);
  const [displayPage, setDisplayPage] = useState(1); // 1-based position within `order`

  // ---- view ----
  const [zoom, setZoom] = useState(100);
  const [fitWidth, setFitWidth] = useState(true);
  const [containerW, setContainerW] = useState(0);
  const [lastScale, setLastScale] = useState(1);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});

  // ---- annotations ----
  const [tool, setTool] = useState<ToolId>('none');
  const [annColor, setAnnColor] = useState(ANN_COLORS[0]);
  const [annSize, setAnnSize] = useState(3);
  const [annotations, setAnnotations] = useState<Record<number, Annotation[]>>({}); // per original page index
  const [pendingText, setPendingText] = useState<{ x: number; y: number; value: string } | null>(null);

  // ---- extract selection (display page numbers, 1-based) ----
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // ---- jump-to-page input ----
  const [jumpInput, setJumpInput] = useState('1');

  // ---- refs ----
  const originalBytesRef = useRef<Uint8Array | null>(null); // kept intact for pdf-lib export
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null); // owns worker/doc lifecycle
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderGenRef = useRef(0);
  const thumbGenRef = useRef(0);
  const thumbsMapRef = useRef<Record<number, string>>({});
  const thumbRotRef = useRef<Record<number, number>>({});
  const drawingRef = useRef<DrawState | null>(null);
  const annotationsRef = useRef<Record<number, Annotation[]>>({});
  const rotationsRef = useRef<Record<number, number>>({});
  const origIdxRef = useRef<number | undefined>(undefined);
  const lastCommitRef = useRef(0);

  const origIdx = order[displayPage - 1];
  const busyLock = busy !== null;

  // keep refs in sync for stable callbacks (drawing, eraser, exports)
  useEffect(() => {
    annotationsRef.current = annotations;
    rotationsRef.current = rotations;
    origIdxRef.current = origIdx;
  });

  useEffect(() => {
    docRef.current = pdfDoc;
  }, [pdfDoc]);

  useEffect(() => {
    setJumpInput(String(displayPage));
  }, [displayPage]);

  // ------------------------------------------------------------
  // Annotation overlay redraw (zoom-independent — normalized coords)
  // ------------------------------------------------------------

  const redrawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const key = origIdxRef.current;
    if (!overlay || key === undefined) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    for (const a of annotationsRef.current[key] ?? []) drawAnn(ctx, a, overlay.width, overlay.height);
  }, []);

  const redrawOverlayRef = useRef(redrawOverlay);
  useEffect(() => {
    redrawOverlayRef.current = redrawOverlay;
  });

  // redraw when annotations or current page change
  useEffect(() => {
    redrawOverlay();
  }, [annotations, origIdx, redrawOverlay]);

  // ------------------------------------------------------------
  // Main page rendering (devicePixelRatio-aware, fit-width or zoom)
  // ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!pdfDoc || origIdx === undefined || !canvas || !overlay) return;

    let cancelled = false;
    const gen = ++renderGenRef.current;
    renderTaskRef.current?.cancel();

    void (async () => {
      try {
        const page = await pdfDoc.getPage(origIdx + 1);
        if (cancelled || gen !== renderGenRef.current) return;
        const totalRot = normRot(page.rotate + (rotations[origIdx] ?? 0));
        const base = page.getViewport({ scale: 1, rotation: totalRot });
        const scale = fitWidth && containerW > 40 ? containerW / base.width : zoom / 100;
        const viewport = page.getViewport({ scale, rotation: totalRot });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        const cssW = Math.max(1, Math.floor(viewport.width));
        const cssH = Math.max(1, Math.floor(viewport.height));
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        overlay.width = canvas.width;
        overlay.height = canvas.height;
        overlay.style.width = `${cssW}px`;
        overlay.style.height = `${cssH}px`;

        const task = page.render({
          canvas,
          viewport,
          transform: dpr > 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled || gen !== renderGenRef.current) return;
        setLastScale(scale);
        redrawOverlayRef.current();
      } catch (e) {
        const name = (e as Error)?.name ?? '';
        if (cancelled || name === 'RenderingCancelledException' || name === 'AbortException') return;
        setError('تعذّر عرض الصفحة — قد تحتوي على عناصر غير مدعومة. جرّب ملفًا آخر.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, origIdx, rotations, zoom, fitWidth, containerW]);

  // observe the scrollable area width for fit-width
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setContainerW(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdfDoc]);

  // unmount cleanup
  useEffect(
    () => () => {
      renderGenRef.current++;
      renderTaskRef.current?.cancel();
      void loadingTaskRef.current?.destroy().catch(() => undefined);
    },
    [],
  );

  // ------------------------------------------------------------
  // Thumbnails (sequential lazy small-scale renders)
  // ------------------------------------------------------------

  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    const gen = ++thumbGenRef.current;

    void (async () => {
      for (const orig of order) {
        if (cancelled || gen !== thumbGenRef.current) return;
        const wantRot = normRot(rotations[orig] ?? 0);
        if (thumbsMapRef.current[orig] && thumbRotRef.current[orig] === wantRot) continue;
        try {
          const page = await pdfDoc.getPage(orig + 1);
          if (cancelled || gen !== thumbGenRef.current) return;
          const totalRot = normRot(page.rotate + wantRot);
          const base = page.getViewport({ scale: 1, rotation: totalRot });
          const viewport = page.getViewport({ scale: THUMB_W / base.width, rotation: totalRot });
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.floor(viewport.width));
          c.height = Math.max(1, Math.floor(viewport.height));
          await page.render({ canvas: c, viewport }).promise;
          if (cancelled || gen !== thumbGenRef.current) return;
          thumbsMapRef.current = { ...thumbsMapRef.current, [orig]: c.toDataURL('image/jpeg', 0.75) };
          thumbRotRef.current = { ...thumbRotRef.current, [orig]: wantRot };
          setThumbs(thumbsMapRef.current);
        } catch {
          /* thumbnail failures are non-fatal */
        }
        await new Promise((r) => setTimeout(r, 25)); // yield to keep UI responsive
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, order, rotations]);

  // ------------------------------------------------------------
  // Open file (input + drag & drop)
  // ------------------------------------------------------------

  const openFile = async (file: File) => {
    if (busyLock) return;
    setError(null);
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setError('الملف المختار ليس ملف PDF. اختر ملفًا بامتداد .pdf');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`حجم الملف ${ar(Math.ceil(file.size / (1024 * 1024)))} ميجابايت ويتجاوز الحد (٤٠ ميجابايت).`);
      return;
    }
    setBusy('جارٍ فتح الملف…');
    const prevTask = loadingTaskRef.current;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      // pdf.js transfers (detaches) the buffer it receives → pass a copy,
      // keep the original intact in a ref for pdf-lib exports.
      loadingTask = pdfjs.getDocument({ data: bytes.slice() });
      loadingTaskRef.current = loadingTask;
      const doc = await loadingTask.promise;

      renderGenRef.current++;
      renderTaskRef.current?.cancel();
      thumbGenRef.current++;
      if (prevTask) void prevTask.destroy().catch(() => undefined);

      originalBytesRef.current = bytes;
      docRef.current = doc;
      thumbsMapRef.current = {};
      thumbRotRef.current = {};

      setPdfDoc(doc);
      setPageCount(doc.numPages);
      setOrder(Array.from({ length: doc.numPages }, (_, i) => i));
      setRotations({});
      setPlanChips([]);
      setAnnotations({});
      setThumbs({});
      setSelected(new Set());
      setDisplayPage(1);
      setZoom(100);
      setFitWidth(true);
      setFileName(file.name);
      setLastFileName(file.name);
      toast.success(`تم فتح «${file.name}» — ${ar(doc.numPages)} صفحة`);
    } catch (e) {
      // discard the failed loading task, keep the previous working one for cleanup
      if (loadingTask) void loadingTask.destroy().catch(() => undefined);
      loadingTaskRef.current = prevTask;
      if (!prevTask) originalBytesRef.current = null;
      const name = (e as Error)?.name ?? '';
      if (name === 'PasswordException') {
        setError('الملف محمي بكلمة مرور ولا يمكن فتحه في مساحة العمل.');
      } else if (name === 'InvalidPDFException') {
        setError('الملف تالف أو ليس ملف PDF صالحًا. تأكد من سلامة الملف وأعد المحاولة.');
      } else {
        setError('تعذّر فتح الملف — قد يكون تالفًا أو أن محرّك العرض لم يعمل. أعد المحاولة أو اختر ملفًا آخر.');
      }
    } finally {
      setBusy(null);
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void openFile(f);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void openFile(f);
  };

  // ------------------------------------------------------------
  // Page-ops plan actions
  // ------------------------------------------------------------

  const addChip = (text: string) => setPlanChips((prev) => [...prev.slice(-5), text]);

  const rotateCurrent = () => {
    const key = origIdxRef.current;
    if (key === undefined) return;
    setRotations((prev) => ({ ...prev, [key]: normRot((prev[key] ?? 0) + 90) }));
    setAnnotations((prev) =>
      prev[key]?.length ? { ...prev, [key]: prev[key].map((a) => rotateAnnotation(a, 1)) } : prev,
    );
    addChip(`دوران ٩٠° — صفحة ${ar(displayPage)}`);
  };

  const rotateAll = () => {
    setRotations((prev) => {
      const next = { ...prev };
      for (const i of order) next[i] = normRot((next[i] ?? 0) + 90);
      return next;
    });
    setAnnotations((prev) => {
      const next = { ...prev };
      for (const i of order) if (next[i]?.length) next[i] = next[i].map((a) => rotateAnnotation(a, 1));
      return next;
    });
    addChip('دوران ٩٠° — كل الصفحات');
  };

  const movePage = (dp: number, delta: -1 | 1) => {
    const target = dp + delta;
    if (target < 1 || target > order.length) return;
    setOrder((prev) => {
      const n = [...prev];
      const tmp = n[dp - 1];
      n[dp - 1] = n[target - 1];
      n[target - 1] = tmp;
      return n;
    });
    setDisplayPage(target);
    addChip('ترتيب جديد');
  };

  const deleteCurrent = () => {
    const dp = displayPage;
    if (order.length <= 1) {
      toast.error('لا يمكن حذف الصفحة الأخيرة');
      return;
    }
    setOrder((prev) => prev.filter((_, i) => i !== dp - 1));
    setSelected((prev) => new Set([...prev].filter((d) => d !== dp).map((d) => (d > dp ? d - 1 : d))));
    setDisplayPage(Math.min(dp, order.length - 1));
    addChip(`حُذفت صفحة ${ar(dp)}`);
    toast.success(`حُذفت صفحة ${ar(dp)} — يمكن التراجع قبل التصدير`);
  };

  const resetPlan = () => {
    // un-rotate annotation geometry back to the original orientation
    setAnnotations((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(prev)) {
        const orig = Number(k);
        const steps = -Math.round((rotationsRef.current[orig] ?? 0) / 90);
        if (!steps || !next[orig]?.length) continue;
        let list = next[orig];
        for (let s = 0; s < Math.abs(steps); s++) list = list.map((a) => rotateAnnotation(a, Math.sign(steps)));
        next[orig] = list;
      }
      return next;
    });
    setOrder(Array.from({ length: pageCount }, (_, i) => i));
    setRotations({});
    setPlanChips([]);
    setDisplayPage(1);
    setSelected(new Set());
    toast.success('تمت إعادة الصفحات إلى حالتها الأصلية');
  };

  // ------------------------------------------------------------
  // Annotation drawing (pointer events on the overlay canvas)
  // ------------------------------------------------------------

  const normPos = (e: React.PointerEvent<HTMLCanvasElement>): Pt | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  };

  const drawLive = () => {
    redrawOverlay();
    const overlay = overlayRef.current;
    const d = drawingRef.current;
    if (!overlay || !d) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    const W = overlay.width;
    const H = overlay.height;
    if (tool === 'rect' && d.start && d.current) {
      drawAnn(
        ctx,
        {
          id: '',
          type: 'rect',
          color: annColor,
          size: d.sizeNorm,
          x: Math.min(d.start.x, d.current.x),
          y: Math.min(d.start.y, d.current.y),
          w: Math.abs(d.current.x - d.start.x),
          h: Math.abs(d.current.y - d.start.y),
        },
        W,
        H,
      );
    } else if ((tool === 'pen' || tool === 'highlight') && d.points.length) {
      drawAnn(ctx, { id: '', type: tool, color: annColor, size: d.sizeNorm, points: d.points }, W, H);
    }
  };

  const onOverlayPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pdfDoc || busyLock || origIdx === undefined || tool === 'none') return;
    if (tool === 'text') {
      const p = normPos(e);
      if (p) setPendingText({ x: p.x, y: p.y, value: '' });
      return;
    }
    if (tool === 'eraser') {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const list = annotationsRef.current[origIdx] ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (hitAnn(list[i], px, py, rect.width, rect.height)) {
          const id = list[i].id;
          setAnnotations((prev) => ({ ...prev, [origIdx]: (prev[origIdx] ?? []).filter((a) => a.id !== id) }));
          return;
        }
      }
      return;
    }
    const p = normPos(e);
    if (!p) return;
    const cssW = e.currentTarget.getBoundingClientRect().width || 1;
    drawingRef.current = { cssW, sizeNorm: annSize / cssW, points: [p], start: p, current: p };
    e.currentTarget.setPointerCapture(e.pointerId);
    drawLive();
  };

  const onOverlayPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drawingRef.current;
    if (!d || tool === 'none' || tool === 'eraser' || tool === 'text') return;
    const p = normPos(e);
    if (!p) return;
    if (tool === 'pen' || tool === 'highlight') d.points.push(p);
    d.current = p;
    drawLive();
  };

  const onOverlayPointerUp = () => {
    const d = drawingRef.current;
    drawingRef.current = null;
    if (!d || origIdx === undefined) return;
    let created: Annotation | null = null;
    if ((tool === 'pen' || tool === 'highlight') && d.points.length) {
      created = { id: mkId(), type: tool, color: annColor, size: d.sizeNorm, points: d.points };
    } else if (tool === 'rect' && d.start && d.current) {
      const w = Math.abs(d.current.x - d.start.x);
      const h = Math.abs(d.current.y - d.start.y);
      if (w > 0.004 && h > 0.004) {
        created = {
          id: mkId(),
          type: 'rect',
          color: annColor,
          size: d.sizeNorm,
          x: Math.min(d.start.x, d.current.x),
          y: Math.min(d.start.y, d.current.y),
          w,
          h,
        };
      }
    }
    if (created) {
      const key = origIdx;
      const ann = created;
      setAnnotations((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), ann] }));
    } else {
      redrawOverlay();
    }
  };

  const commitText = () => {
    if (Date.now() - lastCommitRef.current < 120) return; // Enter+blur double-fire guard
    lastCommitRef.current = Date.now();
    const pt = pendingText;
    const overlay = overlayRef.current;
    const key = origIdxRef.current;
    setPendingText(null);
    if (!pt || !overlay || key === undefined || !pt.value.trim()) return;
    const cssW = overlay.getBoundingClientRect().width || 1;
    const created: TextAnn = {
      id: mkId(),
      type: 'text',
      text: pt.value.trim(),
      color: annColor,
      size: Math.max(0.012, (annSize * 4) / cssW),
      x: pt.x,
      y: pt.y,
    };
    setAnnotations((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), created] }));
  };

  const clearPageAnnotations = () => {
    const key = origIdxRef.current;
    if (key === undefined) return;
    setAnnotations((prev) => ({ ...prev, [key]: [] }));
    toast.success('مُسحت تعليقات هذه الصفحة');
  };

  // ------------------------------------------------------------
  // Rendering helper for extraction / flattened export (scale 2)
  // ------------------------------------------------------------

  const renderPageToCanvas = async (orig: number, scale: number, withAnnotations: boolean) => {
    const doc = docRef.current;
    if (!doc) throw new Error('no document');
    const page = await doc.getPage(orig + 1);
    const totalRot = normRot(page.rotate + (rotationsRef.current[orig] ?? 0));
    const viewport = page.getViewport({ scale, rotation: totalRot });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(viewport.width));
    c.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas: c, viewport }).promise;
    if (withAnnotations) {
      const ctx = c.getContext('2d');
      if (ctx) for (const a of annotationsRef.current[orig] ?? []) drawAnn(ctx, a, c.width, c.height);
    }
    return c;
  };

  // ------------------------------------------------------------
  // Extract selected pages → onExtractPages or PNG downloads
  // ------------------------------------------------------------

  const toggleSelect = (dp: number) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(dp)) n.delete(dp);
      else n.add(dp);
      return n;
    });

  const selectAll = () => setSelected(new Set(order.map((_, i) => i + 1)));
  const clearSelection = () => setSelected(new Set());

  const extractSelected = async () => {
    if (!pdfDoc || selected.size === 0) return;
    setBusy('جارٍ استخراج الصفحات المحددة…');
    try {
      const pages: PdfExtractedPage[] = [];
      for (const dp of [...selected].sort((a, b) => a - b)) {
        const orig = order[dp - 1];
        if (orig === undefined) continue;
        const canvas = await renderPageToCanvas(orig, 2, true);
        pages.push({ pageNumber: dp, dataUrl: canvas.toDataURL('image/png') });
      }
      if (pages.length === 0) throw new Error('nothing extracted');
      if (onExtractPages) {
        onExtractPages(pages);
        toast.success(`أُرسلت ${ar(pages.length)} صفحة إلى وحدة الاستخراج الذكي`);
      } else {
        for (let i = 0; i < pages.length; i++) {
          const blob = await (await fetch(pages[i].dataUrl)).blob();
          downloadBlob(blob, `page-${pages[i].pageNumber}.png`);
          if (i < pages.length - 1) await new Promise((r) => setTimeout(r, 300));
        }
        toast.success(`نُزّلت ${ar(pages.length)} صورة (صفحة-رقم.png)`);
      }
    } catch {
      toast.error('تعذّر استخراج الصفحات — أعد المحاولة');
    } finally {
      setBusy(null);
    }
  };

  // ------------------------------------------------------------
  // Exports (pdf-lib, client-side, from the ORIGINAL bytes)
  // ------------------------------------------------------------

  const exportOriginal = async () => {
    if (!originalBytesRef.current || !pdfDoc) return;
    if (order.length === 0) {
      toast.error('كل الصفحات محذوفة — لا يوجد ما يُصدَّر');
      return;
    }
    setBusy('جارٍ التصدير الأصلي (جودة كاملة)…');
    try {
      const { PDFDocument, degrees } = await import('pdf-lib');
      const src = await PDFDocument.load(originalBytesRef.current, { ignoreEncryption: true });
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, order);
      copied.forEach((page, i) => {
        const orig = order[i];
        const baseRot = normRot(src.getPage(orig).getRotation().angle);
        const extra = normRot(rotationsRef.current[orig] ?? 0);
        page.setRotation(degrees(normRot(baseRot + extra)));
        out.addPage(page);
      });
      const bytes = await out.save();
      downloadBlob(new Blob([bytes.slice()], { type: 'application/pdf' }), 'pdf-workspace-original.pdf');
      toast.success('صُدِّرت النسخة الأصلية بجودة كاملة (مع تعديلات الصفحات)');
    } catch {
      toast.error('تعذّر التصدير — قد يكون الملف محميًا بكلمة مرور أو يحتوي عناصر غير مدعومة');
    } finally {
      setBusy(null);
    }
  };

  const exportFlattened = async () => {
    if (!pdfDoc) return;
    if (order.length === 0) {
      toast.error('كل الصفحات محذوفة — لا يوجد ما يُصدَّر');
      return;
    }
    setBusy('جارٍ تصدير النسخة المُسطّحة…');
    try {
      const { PDFDocument } = await import('pdf-lib');
      const out = await PDFDocument.create();
      const A4 = { w: 595.28, h: 841.89 };
      for (const orig of order) {
        const canvas = await renderPageToCanvas(orig, 2, true);
        const blob = await canvasToBlob(canvas);
        const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
        const landscape = canvas.width > canvas.height;
        const pw = landscape ? A4.h : A4.w;
        const ph = landscape ? A4.w : A4.h;
        const s = Math.min(pw / img.width, ph / img.height);
        const w = img.width * s;
        const h = img.height * s;
        const page = out.addPage([pw, ph]);
        page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
      const bytes = await out.save();
      downloadBlob(new Blob([bytes.slice()], { type: 'application/pdf' }), 'pdf-workspace-annotated.pdf');
      toast.success('صُدِّرت النسخة مع التعليقات (مُسطّحة كصور)');
    } catch {
      toast.error('تعذّر التصدير المُسطّح — أعد المحاولة');
    } finally {
      setBusy(null);
    }
  };

  // ------------------------------------------------------------
  // View helpers
  // ------------------------------------------------------------

  const goJump = () => {
    const n = parseInt(jumpInput, 10);
    if (Number.isNaN(n)) return;
    setDisplayPage(Math.min(Math.max(1, n), Math.max(1, order.length)));
  };
  const zoomBy = (dir: 1 | -1) => {
    const cur = fitWidth ? Math.round(lastScale * 100) : zoom;
    const next =
      dir > 0
        ? ZOOM_STEPS.find((z) => z > cur) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
        : [...ZOOM_STEPS].reverse().find((z) => z < cur) ?? ZOOM_STEPS[0];
    setZoom(next);
    setFitWidth(false);
  };

  const hasPageAnns = origIdx !== undefined && (annotations[origIdx]?.length ?? 0) > 0;
  const planDirty =
    planChips.length > 0 || Object.keys(rotations).length > 0 || order.some((v, i) => v !== i);

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------

  return (
    <div
      dir="rtl"
      className={cn('flex w-full flex-col gap-3', dragOver && 'ring-2 ring-emerald-600 ring-offset-2 rounded-2xl')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        onChange={onInputChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* error banner */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1 leading-relaxed">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="إغلاق التنبيه"
            className="rounded-md p-1 hover:bg-red-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {!pdfDoc ? (
        /* ---------------- empty state / drop zone ---------------- */
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busyLock}
          aria-label="فتح ملف PDF — اسحب وأفلت أو اضغط للاختيار"
          className={cn(
            'relative flex min-h-[340px] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-colors',
            dragOver ? 'border-emerald-600 bg-emerald-50' : 'border-slate-300 bg-white hover:border-emerald-400 hover:bg-emerald-50/40',
            busyLock && 'cursor-wait opacity-80',
          )}
        >
          {busyLock ? (
            <>
              <Loader2 className="h-10 w-10 animate-spin text-emerald-600" />
              <span className="text-sm font-medium text-emerald-800">{busy}</span>
            </>
          ) : (
            <>
              <span className="flex size-16 items-center justify-center rounded-full bg-emerald-100">
                <FileUp className="h-8 w-8 text-emerald-600" />
              </span>
              <span className="text-lg font-bold text-slate-800">افتح ملف PDF لبدء العمل</span>
              <span className="text-sm text-slate-500">
                اسحب الملف وأفلته هنا، أو اضغط للاختيار من جهازك
                <span className="ms-2 text-xs text-slate-400">PDF Workspace — open a PDF to begin</span>
              </span>
              <Badge variant="outline" className="border-emerald-300 text-emerald-700">
                حتى ٤٠ ميجابايت · معالجة محلية بالكامل
              </Badge>
              <span className="text-xs text-slate-400">
                لا يُرفع الملف إلى أي خادم — كل العمليات تجري في متصفحك
              </span>
              {lastFileName && <span className="text-xs text-slate-400">آخر ملف فُتح: {lastFileName}</span>}
            </>
          )}
        </button>
      ) : (
        <>
          {/* ---------------- toolbar ---------------- */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2 shadow-sm">
            <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={busyLock}>
              <FolderOpen className="h-4 w-4" />
              فتح ملف آخر
            </Button>
            <Badge variant="secondary" className="max-w-48 truncate font-normal">
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-600" aria-hidden />
              {fileName}
            </Badge>

            <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" aria-hidden />

            {/* page navigation */}
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setDisplayPage((p) => Math.max(1, p - 1))}
                disabled={busyLock || displayPage <= 1}
                aria-label="الصفحة السابقة"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Input
                type="text"
                inputMode="numeric"
                dir="ltr"
                value={jumpInput}
                onChange={(e) => setJumpInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && goJump()}
                onBlur={goJump}
                disabled={busyLock}
                aria-label="انتقال إلى رقم صفحة"
                className="h-9 w-14 px-2 text-center"
              />
              <span className="min-w-24 text-center text-sm text-slate-600" aria-live="polite">
                صفحة {ar(displayPage)} من {ar(order.length)}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setDisplayPage((p) => Math.min(order.length, p + 1))}
                disabled={busyLock || displayPage >= order.length}
                aria-label="الصفحة التالية"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </div>

            <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" aria-hidden />

            {/* zoom */}
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="icon" onClick={() => zoomBy(-1)} disabled={busyLock} aria-label="تصغير">
                <ZoomOut className="h-4 w-4" />
              </Button>
              <Select
                value={fitWidth ? 'fit' : String(zoom)}
                onValueChange={(v) => {
                  if (v === 'fit') setFitWidth(true);
                  else {
                    setZoom(Number(v));
                    setFitWidth(false);
                  }
                }}
              >
                <SelectTrigger className="h-9 w-32" aria-label="مستوى التكبير">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fit">ملاءمة العرض</SelectItem>
                  {ZOOM_STEPS.map((z) => (
                    <SelectItem key={z} value={String(z)}>
                      {z}%
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={() => zoomBy(1)} disabled={busyLock} aria-label="تكبير">
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* ---------------- tabs: tools / page ops / extract & export ---------------- */}
          <Tabs defaultValue="annotate">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1">
              <TabsTrigger value="annotate" className="gap-1.5">
                التعليقات
                <span className="text-[10px] font-normal text-slate-400">Annotate</span>
              </TabsTrigger>
              <TabsTrigger value="pages" className="gap-1.5">
                عمليات الصفحات
                <span className="text-[10px] font-normal text-slate-400">Pages</span>
              </TabsTrigger>
              <TabsTrigger value="export" className="gap-1.5">
                الاستخراج والتصدير
                <span className="text-[10px] font-normal text-slate-400">Export</span>
              </TabsTrigger>
            </TabsList>

            {/* annotation tools */}
            <TabsContent value="annotate" className="mt-2">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2 shadow-sm">
                {TOOLS.map((t) => (
                  <Button
                    key={t.id}
                    variant={tool === t.id ? 'default' : 'outline'}
                    onClick={() => setTool(t.id)}
                    disabled={busyLock}
                    aria-pressed={tool === t.id}
                    aria-label={`أداة: ${t.label}`}
                    className={cn('min-w-9 gap-1.5', tool === t.id && 'bg-emerald-600 text-white hover:bg-emerald-700')}
                  >
                    <t.icon className="h-4 w-4" />
                    {t.label}
                  </Button>
                ))}

                <span className="mx-1 h-6 w-px bg-slate-200" aria-hidden />

                <div className="flex items-center gap-1" role="group" aria-label="لون التعليق">
                  {ANN_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setAnnColor(c)}
                      disabled={busyLock}
                      aria-pressed={annColor === c}
                      aria-label={`لون ${c}`}
                      className={cn(
                        'flex size-9 items-center justify-center rounded-md transition',
                        annColor === c ? 'bg-emerald-100 ring-2 ring-emerald-600' : 'hover:bg-slate-100',
                      )}
                    >
                      <span className="size-5 rounded-full border border-slate-300" style={{ background: c }} />
                    </button>
                  ))}
                </div>

                <span className="mx-1 h-6 w-px bg-slate-200" aria-hidden />

                <label className="flex items-center gap-2 text-xs text-slate-500">
                  السماكة
                  <Slider
                    value={[annSize]}
                    onValueChange={(v) => setAnnSize(v[0] ?? annSize)}
                    min={1}
                    max={12}
                    step={1}
                    disabled={busyLock}
                    aria-label="سماكة التعليق"
                    className="w-24 [&_[data-slot=slider-thumb]]:size-5"
                  />
                </label>

                <Button
                  variant="ghost"
                  onClick={clearPageAnnotations}
                  disabled={busyLock || !hasPageAnns}
                  className="text-red-700 hover:bg-red-50 hover:text-red-800"
                >
                  <Trash2 className="h-4 w-4" />
                  مسح تعليقات الصفحة
                </Button>
                {tool === 'eraser' && (
                  <span className="text-xs text-slate-500">اضغط على أي تعليق لحذفه بالكامل</span>
                )}
                {tool === 'text' && (
                  <span className="text-xs text-slate-500">اضغط على الصفحة لتحديد موضع النص</span>
                )}
              </div>
            </TabsContent>

            {/* page operations */}
            <TabsContent value="pages" className="mt-2">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2 shadow-sm">
                <Button variant="outline" onClick={rotateCurrent} disabled={busyLock}>
                  <RotateCw className="h-4 w-4" />
                  تدوير الصفحة ٩٠°
                </Button>
                <Button variant="outline" onClick={rotateAll} disabled={busyLock}>
                  <RotateCw className="h-4 w-4" />
                  تدوير الكل ٩٠°
                </Button>
                <span className="mx-1 h-6 w-px bg-slate-200" aria-hidden />
                <Button variant="outline" onClick={() => movePage(displayPage, -1)} disabled={busyLock || displayPage <= 1}>
                  <ArrowUp className="h-4 w-4" />
                  نقل لأعلى
                </Button>
                <Button
                  variant="outline"
                  onClick={() => movePage(displayPage, 1)}
                  disabled={busyLock || displayPage >= order.length}
                >
                  <ArrowDown className="h-4 w-4" />
                  نقل لأسفل
                </Button>
                <span className="mx-1 h-6 w-px bg-slate-200" aria-hidden />
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" disabled={busyLock || order.length <= 1}>
                      <Trash2 className="h-4 w-4" />
                      حذف الصفحة
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent dir="rtl">
                    <AlertDialogHeader>
                      <AlertDialogTitle>حذف الصفحة {ar(displayPage)}؟</AlertDialogTitle>
                      <AlertDialogDescription>
                        ستُزال الصفحة من الترتيب الحالي ولا تُنسخ عند التصدير. يمكنك التراجع عن جميع تعديلات
                        الصفحات بزر «تراجع عن تعديلات الصفحات» قبل التصدير.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>إلغاء</AlertDialogCancel>
                      <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={deleteCurrent}>
                        حذف
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button variant="ghost" onClick={resetPlan} disabled={busyLock || !planDirty}>
                  <Undo2 className="h-4 w-4" />
                  تراجع عن تعديلات الصفحات
                </Button>
              </div>
            </TabsContent>

            {/* extract & export */}
            <TabsContent value="export" className="mt-2">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2 shadow-sm">
                <span className="text-sm text-slate-600">
                  المحدد للاستخراج: <strong className="text-emerald-700">{ar(selected.size)}</strong> صفحة
                  <span className="ms-1 text-[10px] text-slate-400">select pages from the sidebar</span>
                </span>
                <Button variant="outline" size="sm" className="h-9" onClick={selectAll} disabled={busyLock}>
                  تحديد الكل
                </Button>
                <Button variant="ghost" size="sm" className="h-9" onClick={clearSelection} disabled={busyLock || !selected.size}>
                  إلغاء التحديد
                </Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => void extractSelected()}
                  disabled={busyLock || selected.size === 0}
                >
                  <Sparkles className="h-4 w-4" />
                  استخراج الصفحات المحددة للذكاء الاصطناعي
                </Button>
                <span className="mx-1 h-6 w-px bg-slate-200" aria-hidden />
                <Button variant="outline" onClick={() => void exportOriginal()} disabled={busyLock}>
                  <FileDown className="h-4 w-4" />
                  تصدير أصلي (جودة كاملة)
                </Button>
                <Button variant="outline" onClick={() => void exportFlattened()} disabled={busyLock}>
                  <Images className="h-4 w-4" />
                  تصدير مع التعليقات (مُسطّح)
                </Button>
              </div>
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
                تنبيه: «تصدير مع التعليقات» يُسطّح كل صفحة مع تعليقاتها إلى صورة داخل PDF —
                <strong> يُفقد النص القابل للتحديد والبحث</strong> (Flattened = images). أما «التصدير الأصلي»
                فيحافظ على النصوص والجودة الكاملة ويطبّق تعديلات الصفحات فقط، دون التعليقات.
              </p>
            </TabsContent>
          </Tabs>

          {/* ---------------- page-ops plan chips ---------------- */}
          {planDirty && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2">
              <span className="text-xs font-semibold text-emerald-800">خطة تعديل الصفحات:</span>
              {planChips.map((c, i) => (
                <Badge key={`${c}-${i}`} variant="outline" className="border-emerald-300 bg-white text-emerald-800">
                  {c}
                </Badge>
              ))}
              {planChips.length === 0 && (
                <Badge variant="outline" className="border-emerald-300 bg-white text-emerald-800">
                  تعديلات على الترتيب/الدوران
                </Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ms-auto h-9 text-emerald-800 hover:bg-emerald-100"
                onClick={resetPlan}
                disabled={busyLock}
              >
                <Undo2 className="h-4 w-4" />
                تراجع عن تعديلات الصفحات
              </Button>
            </div>
          )}

          {/* ---------------- body: main view + thumbnails ---------------- */}
          <div className="flex items-start gap-3">
            {/* main canvas area */}
            <ScrollArea className="min-w-0 flex-1">
              <div ref={areaRef} className="relative max-h-[75vh] min-h-[320px]">
                {order.length === 0 ? (
                  <div className="flex min-h-[320px] items-center justify-center rounded-xl border bg-slate-50 text-sm text-slate-500">
                    لا توجد صفحات — جرّب «تراجع عن تعديلات الصفحات»
                  </div>
                ) : (
                  <div className="flex justify-center p-4">
                    <div className="relative w-fit shadow-lg ring-1 ring-slate-300">
                      <canvas
                        ref={canvasRef}
                        role="img"
                        aria-label={`معاينة الصفحة ${ar(displayPage)}`}
                        className="block rounded-sm bg-white"
                      />
                      <canvas
                        ref={overlayRef}
                        aria-hidden="true"
                        className={cn(
                          'absolute inset-0 touch-none',
                          tool === 'eraser' ? 'cursor-pointer' : tool === 'none' ? 'cursor-default' : 'cursor-crosshair',
                        )}
                        onPointerDown={onOverlayPointerDown}
                        onPointerMove={onOverlayPointerMove}
                        onPointerUp={onOverlayPointerUp}
                        onPointerCancel={onOverlayPointerUp}
                      />
                      {pendingText && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            commitText();
                          }}
                          className="absolute z-20 -translate-y-1/2"
                          style={{ left: `${pendingText.x * 100}%`, top: `${pendingText.y * 100}%` }}
                        >
                          <Input
                            autoFocus
                            dir="rtl"
                            value={pendingText.value}
                            onChange={(e) => setPendingText((p) => (p ? { ...p, value: e.target.value } : p))}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                lastCommitRef.current = Date.now(); // block the follow-up blur commit
                                setPendingText(null);
                              }
                            }}
                            onBlur={commitText}
                            placeholder="اكتب النص ثم Enter"
                            aria-label="نص التعليق"
                            className="h-8 w-44 bg-white text-sm shadow-md"
                          />
                        </form>
                      )}
                    </div>
                  </div>
                )}
                {busyLock && (
                  <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-white/70 backdrop-blur-[1px]">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
                    <span className="text-sm font-medium text-emerald-800">{busy}</span>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* thumbnails sidebar */}
            <aside className="w-28 shrink-0 sm:w-40">
              <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-xs font-medium text-slate-500">الصفحات</span>
                <span className="text-[10px] text-slate-400">Thumbs</span>
              </div>
              <ScrollArea className="max-h-[70vh] rounded-xl border bg-white">
                <div className="flex flex-col gap-2 p-2">
                  {order.map((orig, i) => {
                    const dp = i + 1;
                    const isCurrent = dp === displayPage;
                    return (
                      <div
                        key={orig}
                        className={cn(
                          'rounded-lg border-2 p-1 transition-colors',
                          isCurrent ? 'border-emerald-600 bg-emerald-50' : 'border-transparent hover:border-slate-300',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setDisplayPage(dp)}
                          disabled={busyLock}
                          aria-label={`الانتقال إلى صفحة ${ar(dp)}`}
                          aria-current={isCurrent ? 'page' : undefined}
                          className="block w-full"
                        >
                          {thumbs[orig] ? (
                            <img
                              src={thumbs[orig]}
                              alt={`مصغّر الصفحة ${ar(dp)}`}
                              draggable={false}
                              className="w-full rounded border border-slate-200"
                            />
                          ) : (
                            <span className="flex h-24 items-center justify-center">
                              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                            </span>
                          )}
                        </button>
                        <div className="mt-1 flex items-center justify-between px-0.5">
                          <span
                            className={cn(
                              'text-[11px] font-medium',
                              isCurrent ? 'text-emerald-700' : 'text-slate-500',
                            )}
                          >
                            {ar(dp)}
                          </span>
                          <span className="rounded p-1 hover:bg-slate-100">
                            <Checkbox
                              checked={selected.has(dp)}
                              onCheckedChange={() => toggleSelect(dp)}
                              disabled={busyLock}
                              aria-label={`تحديد صفحة ${ar(dp)} للاستخراج`}
                              className="size-5"
                            />
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </aside>
          </div>

          <p className="text-center text-[11px] text-slate-400">
            كل المعالجة تجري محليًا في متصفحك — pdf.js + pdf-lib · لا يتم رفع الملف إلى أي خادم
          </p>
        </>
      )}
    </div>
  );
}
