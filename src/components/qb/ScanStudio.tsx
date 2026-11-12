'use client';

// ============================================================
// ALNOKHBA QB — Scan Studio (2025 rework)
// Tab 1: LIVE CAMERA SCANNER — point at the sheet, auto-capture
//        when the page is stable & readable (QR-aware when the
//        browser exposes BarcodeDetector), manual capture always
//        available, torch + camera switch + upload fallback.
// Tab 2: UPLOAD — images AND multi-page PDFs (batch progress,
//        cursor-resumable, idempotent retries).
// Both paths → /api/scan (or /api/scan/pdf) → review → overrides
// → identity correction → audited save.
// Manual 4-corner fallback fixed: sends [[x,y]×4] (TL,TR,BR,BL).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Camera,
  CameraOff,
  CheckCircle2,
  Crosshair,
  FileScan,
  Flashlight,
  FlashlightOff,
  Loader2,
  RefreshCw,
  ScanLine,
  Stethoscope,
  SwitchCamera,
  Upload,
  UserCheck,
  Zap,
} from 'lucide-react';
import type { QBAnswerStatus, QBScannedAnswer, QBScanGrade } from '@/lib/qb/types';

// ---- types ----

interface ScanResult {
  scanId: string;
  answers: QBScannedAnswer[];
  grade: QBScanGrade | null;
  studentCode: string | null;
  studentId: string | null;
  overallConfidence: number;
  status: string;
  needsReview?: boolean;
  reviewStatus?: string | null;
  duplicate?: boolean;
  diagnostics: Record<string, unknown> & {
    stages?: Record<string, boolean>;
    warnings?: string[];
    errors?: string[];
    strategy?: string;
    rotationDeg?: number;
    templateId?: string;
    examVersionId?: string;
    markersFound?: number;
  };
  images?: { debug?: string | null; corrected?: string | null };
}

// Vercel caps serverless request bodies at 4.5MB — whole-file PDF uploads on
// real scanned stacks (e.g. 100 sheets ≈ 12MB) exceed it with FUNCTION_PAYLOAD_TOO_LARGE.
// Keep whole-file uploads under ~3.4MB of base64 and single-page slices under ~4.2MB.
const PDF_WHOLE_LIMIT = 3_400_000;
const PDF_PAGE_LIMIT = 4_200_000;

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

interface BatchPageResult {
  index: number;
  scanId: string | null;
  duplicate?: boolean;
  ok: boolean;
  error?: string;
  stage?: string;
  studentCode?: string | null;
  studentName?: string | null;
  score?: number | null;
  maxScore?: number | null;
  needsReview?: boolean;
}

// BarcodeDetector typing (Chrome/Android; feature-detected at runtime)
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

const statusMeta: Record<QBAnswerStatus, { label: string; cls: string }> = {
  selected: { label: 'محدد', cls: 'bg-emerald-100 text-emerald-800' },
  unanswered: { label: 'فارغ', cls: 'bg-slate-100 text-slate-600' },
  multiple: { label: 'متعدد ⚠', cls: 'bg-red-100 text-red-700' },
  unclear: { label: 'غير واضح ⚠', cls: 'bg-amber-100 text-amber-800' },
  invalid: { label: 'غير صالح ⚠', cls: 'bg-red-100 text-red-700' },
};

const CORNER_LABELS = ['أعلى اليسار', 'أعلى اليمين', 'أسفل اليمين', 'أسفل اليسار'];

// Scanner state machine
type ScanState =
  | 'IDLE'
  | 'REQUESTING'
  | 'READY'
  | 'SEARCHING'
  | 'PAGE_STABLE'
  | 'CAPTURING'
  | 'PROCESSING'
  | 'COOLDOWN'
  | 'ERROR';

const stateLabel: Record<ScanState, string> = {
  IDLE: 'جاهز للبدء',
  REQUESTING: 'طلب إذن الكاميرا…',
  READY: 'الكاميرا تعمل',
  SEARCHING: 'وجّه الكاميرا نحو ورقة الإجابة…',
  PAGE_STABLE: 'تم رصد ورقة ثابتة — جارٍ الالتقاط…',
  CAPTURING: 'جارٍ التصوير…',
  PROCESSING: 'جارٍ تحليل الورقة…',
  COOLDOWN: 'استعد للورقة التالية…',
  ERROR: 'خطأ في الكاميرا',
};

/** Client-side downscale before upload.
 *  WHY: phone cameras ship 12-108MP frames (3-10MB JPEG → 4-13MB base64).
 *  Serverless request bodies cap at 4.5MB AND the engine's analysis runs at
 *  ~300 DPI canonical resolution anyway — anything past 2400px long edge is
 *  pure upload/latency cost with zero accuracy gain. Keeps the original when
 *  already small; falls back to the input on any decode failure. */
async function downscaleImage(dataUrl: string, maxEdge = 2400, quality = 0.9): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const long = Math.max(w, h);
      if (!w || !h || long <= maxEdge) {
        resolve(dataUrl);
        return;
      }
      const scale = maxEdge / long;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export default function ScanStudio({ onScanned }: { onScanned?: () => void }) {
  const [tab, setTab] = useState<'live' | 'upload'>('live');

  // ---- shared
  const [examVersions, setExamVersions] = useState<{ id: string; label: string }[]>([]);
  const [hintVersion, setHintVersion] = useState<string>('auto');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [diagOpen, setDiagOpen] = useState(false);
  const [linkCode, setLinkCode] = useState('');
  const [linking, setLinking] = useState(false);
  // ---- manual 4-corner fallback
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualPoints, setManualPoints] = useState<Array<{ x: number; y: number }>>([]);
  const imgRef = useRef<HTMLImageElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- live camera
  const [scanState, setScanState] = useState<ScanState>('IDLE');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null); // 320px analysis canvas
  const capCanvasRef = useRef<HTMLCanvasElement | null>(null); // full-res capture
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const stableCountRef = useRef(0);
  const busyRef = useRef(false);
  const cooldownUntilRef = useRef(0);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const loopRef = useRef<number | null>(null);

  // ---- PDF batch
  const [batch, setBatch] = useState<{
    running: boolean;
    total: number;
    done: number;
    okCount: number;
    failCount: number;
    dupCount: number;
    pages: BatchPageResult[];
  } | null>(null);

  const loadVersions = useCallback(async () => {
    try {
      const res = await fetch('/api/exams');
      const exams = (await res.json()) as { id: string; title: string; currentVersion: number; status: string }[];
      const versions: { id: string; label: string }[] = [];
      for (const ex of exams.filter((e) => e.currentVersion > 0)) {
        versions.push({ id: `${ex.id}`, label: `${ex.title} — نسخة ${ex.currentVersion}` });
      }
      setExamVersions(versions);
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    void loadVersions();
    return () => {
      stopCamera();
    };
  }, []);
  // ================= SUBMIT PATHS =================

  const submitScan = async (
    dataUrl: string,
    manualMarkers?: Array<[number, number]>
  ) => {
    busyRef.current = true;
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: dataUrl,
          examVersionIdHint: hintVersion === 'auto' ? undefined : hintVersion,
          manualMarkers,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'فشل تحليل الورقة');
        setResult({
          scanId: '',
          answers: [],
          grade: null,
          studentCode: null,
          studentId: null,
          overallConfidence: 0,
          status: 'FAILED',
          diagnostics: {
            errors: [data.error ?? 'unknown'],
            stages: data.stages ?? {},
            warnings: data.warnings ?? [],
          },
          images: data.images,
        });
        return;
      }
      if (data.duplicate) {
        toast.info('هذه الورقة ممسوحة مسبقًا — تم تجاهل التكرار');
      } else if (data.needsReview) {
        toast.warning('تمت القراءة مع ملاحظات تحتاج مراجعة');
      } else {
        toast.success('تمت قراءة الورقة واعتمادها');
      }
      setResult(data);
      setManualMode(false);
      onScanned?.();
      const ambiguous = (data.answers as QBScannedAnswer[]).filter(
        (a) => a.status === 'multiple' || a.status === 'unclear'
      );
      if (ambiguous.length > 0) {
        toast.warning(`${ambiguous.length} إجابة تحتاج مراجعة (غير واضحة/متعددة)`);
      }
    } catch {
      toast.error('تعذر الاتصال بخدمة التحليل');
    } finally {
      busyRef.current = false;
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (file.size > 40 * 1024 * 1024) {
      toast.error('حجم الملف كبير جدًا (الحد 40 ميجابايت)');
      return;
    }
    setResult(null);
    setOverrides({});
    setManualMode(false);
    setManualPoints([]);
    try {
      if (isPdf) {
        // Whole-file vs client-side per-page slicing: Vercel caps function
        // request bodies at 4.5MB — real scanned stacks must be sliced.
        const bytes = new Uint8Array(await file.arrayBuffer());
        const b64Estimate = Math.ceil(bytes.length / 3) * 4;
        if (b64Estimate > PDF_WHOLE_LIMIT) {
          await runPdfChunked(bytes);
        } else {
          const rawUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = reject;
            r.readAsDataURL(file);
          });
          await runPdfBatch(rawUrl);
        }
      } else {
        // downscale BEFORE anything that keeps the image (manual-corner map
        // uses the SAME downscaled pixels the engine receives — consistent)
        const rawUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        const dataUrl = await downscaleImage(rawUrl);
        setPendingImage(dataUrl); // kept for the manual-corner fallback
        busyRef.current = true;
        setScanState('PROCESSING');
        try {
          await submitScan(dataUrl);
        } finally {
          busyRef.current = false;
          setScanState('SEARCHING');
        }
      }
    } catch {
      toast.error('تعذر قراءة الملف');
    }
  };

  const runPdfChunked = async (srcBytes: Uint8Array) => {
    let batchId: string | undefined;
    let resolvedVersion: string | undefined = hintVersion === 'auto' ? undefined : hintVersion;
    try {
      const { PDFDocument } = await import('pdf-lib');
      const src = await PDFDocument.load(srcBytes);
      const total = src.getPageCount();
      setBatch({ running: true, total, done: 0, okCount: 0, failCount: 0, dupCount: 0, pages: [] });
      for (let i = 0; i < total; i++) {
        try {
          const doc = await PDFDocument.create();
          const [page] = await doc.copyPages(src, [i]);
          doc.addPage(page);
          const slice = await doc.save();
          const sliceDataUrl = bytesToDataUrl(slice, 'application/pdf');
          if (sliceDataUrl.length > PDF_PAGE_LIMIT) {
            setBatch((b) =>
              b
                ? {
                    ...b,
                    done: i + 1,
                    failCount: b.failCount + 1,
                    pages: [
                      ...b.pages,
                      {
                        index: i,
                        scanId: null,
                        ok: false,
                        error: 'الصفحة أكبر من حد الرفع — أعد مسحها بدقة أقل',
                      },
                    ],
                  }
                : b
            );
            continue;
          }
          const res = await fetch('/api/scan/pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pdfBase64: sliceDataUrl,
              batchId,
              examVersionIdHint: resolvedVersion,
              pageChunk: { index: i, total },
            }),
          });
          const data = await res.json();
          if (!res.ok) {
            toast.error(data.error ?? `فشل معالجة الصفحة ${i + 1}`);
            setBatch((b) =>
              b
                ? {
                    ...b,
                    done: i + 1,
                    failCount: b.failCount + 1,
                    pages: [
                      ...b.pages,
                      {
                        index: i,
                        scanId: null,
                        ok: false,
                        error: data.error ?? `فشل معالجة الصفحة ${i + 1}`,
                      },
                    ],
                  }
                : b
            );
            if (res.status >= 500) break; // engine/platform issue — stop the batch
            continue;
          }
          batchId = data.batchId;
          if (data.examVersionId) resolvedVersion = data.examVersionId;
          const results: BatchPageResult[] = data.results ?? [];
          setBatch((b) =>
            b
              ? {
                  ...b,
                  done: data.nextFrom ?? i + results.length,
                  okCount: b.okCount + results.filter((r) => r.ok && !r.duplicate).length,
                  dupCount: b.dupCount + results.filter((r) => r.duplicate).length,
                  failCount: b.failCount + results.filter((r) => !r.ok).length,
                  pages: [...b.pages, ...results],
                }
              : b
          );
          if (results.some((r) => r.transportAbort)) {
            toast.warning(data.warning ?? 'انقطع الاتصال بمحرك المعالجة — أعد المحاولة');
            break;
          }
        } catch {
          toast.error('تعذر الاتصال بخدمة التحليل');
          break;
        }
      }
      setBatch((b) => (b ? { ...b, running: false } : b));
      onScanned?.();
    } catch {
      toast.error('تعذر قراءة ملف PDF');
      setBatch((b) => (b ? { ...b, running: false } : b));
    }
  };

  const runPdfBatch = async (dataUrl: string) => {
    setBatch({ running: true, total: 0, done: 0, okCount: 0, failCount: 0, dupCount: 0, pages: [] });
    let fromPage = 0;
    let batchId: string | undefined;
    let resolvedVersion: string | undefined = hintVersion === 'auto' ? undefined : hintVersion;
    let guard = 0;
    try {
      while (guard++ < 60) {
        const res = await fetch('/api/scan/pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdfBase64: dataUrl,
            fromPage,
            batchSize: 6,
            batchId,
            examVersionIdHint: resolvedVersion,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error ?? 'فشل معالجة ملف PDF');
          break;
        }
        batchId = data.batchId;
        if (data.examVersionId) resolvedVersion = data.examVersionId;
        const results: BatchPageResult[] = data.results ?? [];
        setBatch((b) =>
          b
            ? {
                ...b,
                total: data.total ?? b.total,
                done: data.nextFrom ?? b.done + results.length,
                okCount: b.okCount + results.filter((r) => r.ok && !r.duplicate).length,
                dupCount: b.dupCount + results.filter((r) => r.duplicate).length,
                failCount: b.failCount + results.filter((r) => !r.ok).length,
                pages: [...b.pages, ...results],
              }
            : b
        );
        fromPage = data.nextFrom ?? fromPage + results.length;
        if (data.done) break;
        if (data.warning) toast.warning(data.warning);
      }
      setBatch((b) => (b ? { ...b, running: false } : b));
      onScanned?.();
    } catch {
      toast.error('تعذر الاتصال بخدمة التحليل');
      setBatch((b) => (b ? { ...b, running: false } : b));
    }
  };

  // ================= LIVE CAMERA =================

  const stopCamera = useCallback(() => {
    if (loopRef.current) {
      window.clearInterval(loopRef.current);
      loopRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    prevFrameRef.current = null;
    stableCountRef.current = 0;
    detectorRef.current = null;
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  const startCamera = async () => {
    setCameraError(null);
    setScanState('REQUESTING');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('المتصفح لا يدعم الكاميرا المباشرة — استخدم الرفع من ملف');
      setScanState('ERROR');
      return;
    }
    if (!window.isSecureContext) {
      setCameraError('الكاميرا تتطلب اتصالًا آمنًا (HTTPS) — استخدم الرفع من ملف أو افتح الموقع عبر الرابط الآمن');
      setScanState('ERROR');
      return;
    }
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      // torch capability (never claimed unless the track exposes it)
      const track = stream.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
      setTorchSupported(!!caps?.torch);
      // QR detector (feature-detect; optional in all browsers)
      const BDCtor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (BDCtor) {
        try {
          detectorRef.current = new BDCtor({ formats: ['qr_code'] });
        } catch {
          detectorRef.current = null;
        }
      }
      setScanState('SEARCHING');
      startAnalysisLoop();
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError') {
        setCameraError('تم رفض إذن الكاميرا — اسمح بالوصول من إعدادات المتصفح ثم أعد المحاولة');
      } else if (name === 'NotFoundError') {
        setCameraError('لا توجد كاميرا متاحة على هذا الجهاز');
      } else {
        setCameraError('تعذر تشغيل الكاميرا — استخدم الرفع من ملف');
      }
      setScanState('ERROR');
    }
  };

  const startAnalysisLoop = () => {
    if (loopRef.current) window.clearInterval(loopRef.current);
    const work = workCanvasRef.current ?? document.createElement('canvas');
    workCanvasRef.current = work;
    work.width = 320;
    work.height = 240;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    loopRef.current = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !wctx) return;
      if (busyRef.current || Date.now() < cooldownUntilRef.current) return;
      wctx.drawImage(video, 0, 0, 320, 240);
      const frame = wctx.getImageData(0, 0, 320, 240);

      // stability: mean |Δ| vs previous frame
      let diff = 0;
      if (prevFrameRef.current && prevFrameRef.current.length === frame.data.length) {
        let acc = 0;
        for (let i = 0; i < frame.data.length; i += 16) {
          acc += Math.abs(frame.data[i] - prevFrameRef.current[i]);
        }
        diff = acc / (frame.data.length / 16);
      }
      prevFrameRef.current = new Uint8ClampedArray(frame.data);

      // brightness gate (rough): reject too dark / blown-out frames
      let lum = 0;
      for (let i = 0; i < frame.data.length; i += 64) {
        lum += (frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3;
      }
      lum = lum / (frame.data.length / 64);
      const brightOk = lum > 50 && lum < 235;

      const stable = diff < 5.5;
      if (!stable || !brightOk) {
        stableCountRef.current = 0;
        if (scanStateRef.current === 'PAGE_STABLE') setScanState('SEARCHING');
        return;
      }
      stableCountRef.current += 1;

      // QR-aware confirmation when the platform provides BarcodeDetector;
      // otherwise stability + brightness alone triggers capture (the server
      // performs the full page detection and reports any problems).
      const detector = detectorRef.current;
      if (stableCountRef.current >= 3) {
        if (detector) {
          detector
            .detect(work)
            .then((codes) => {
              if (codes.length > 0) {
                setScanState('PAGE_STABLE');
                void captureFrame();
              } else if (stableCountRef.current >= 8) {
                // no QR readable but the frame has been rock-stable a while →
                // still attempt (server-side page detection decides)
                setScanState('PAGE_STABLE');
                void captureFrame();
              }
            })
            .catch(() => undefined);
        } else if (stableCountRef.current >= 5) {
          setScanState('PAGE_STABLE');
          void captureFrame();
        }
      }
    }, 300);
  };

  const scanStateRef = useRef<ScanState>('IDLE');
  useEffect(() => {
    scanStateRef.current = scanState;
  }, [scanState]);

  const captureFrame = async () => {
    const video = videoRef.current;
    if (!video || busyRef.current) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    busyRef.current = true;
    setScanState('CAPTURING');
    try {
      const cap = capCanvasRef.current ?? document.createElement('canvas');
      capCanvasRef.current = cap;
      cap.width = vw;
      cap.height = vh;
      const ctx = cap.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, vw, vh);
      const rawUrl = cap.toDataURL('image/jpeg', 0.92);
      // bound the upload: see downscaleImage — camera frames are 12MP+ and
      // everything past 2400px is latency with no accuracy gain
      const dataUrl = await downscaleImage(rawUrl);
      setPendingImage(dataUrl);
      setScanState('PROCESSING');
      await submitScan(dataUrl);
    } finally {
      busyRef.current = false;
      stableCountRef.current = 0;
      prevFrameRef.current = null;
      // wait for the sheet to change / be replaced before the next auto shot
      cooldownUntilRef.current = Date.now() + 2500;
      setScanState('COOLDOWN');
      window.setTimeout(() => {
        if (streamRef.current && scanStateRef.current === 'COOLDOWN') setScanState('SEARCHING');
      }, 2500);
    }
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] } as MediaTrackConstraints);
      setTorchOn((v) => !v);
    } catch {
      toast.error('الفلاش غير مدعوم على هذه الكاميرا');
      setTorchSupported(false);
    }
  };

  const switchCamera = async () => {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanState('READY');
    // restart with the new facing mode
    window.setTimeout(() => void startCameraWith(next), 100);
  };

  const startCameraWith = async (mode: 'environment' | 'user') => {
    setCameraError(null);
    setScanState('REQUESTING');
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: mode }, width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      const track = stream.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
      setTorchSupported(!!caps?.torch);
      setTorchOn(false);
      setScanState('SEARCHING');
      startAnalysisLoop();
    } catch {
      setCameraError('تعذر تبديل الكاميرا');
      setScanState('ERROR');
    }
  };

  // ================= MANUAL CORNERS =================

  const onManualClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || manualPoints.length >= 4) return;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    const next = [...manualPoints, { x, y }];
    setManualPoints(next);
    if (next.length === 4) {
      if (hintVersion === 'auto') {
        toast.error('اختر نسخة الامتحان من القائمة أولًا (الضبط اليدوي لا يقرأ QR)');
        setManualPoints([]);
        return;
      }
      if (!pendingImage) return;
      toast.info('تم تحديد الزوايا — جارٍ التصحيح…');
      // API expects [[x,y]×4] — TL,TR,BR,BL in ORIGINAL image pixels
      void submitScan(pendingImage, next.map((p) => [p.x, p.y] as [number, number]));
    }
  };

  const startManualMode = () => {
    if (!pendingImage) {
      toast.error('ارفع صورة الورقة أولًا (الضبط اليدوي يعمل على الصور، وليس ملفات PDF)');
      return;
    }
    setManualMode(true);
    setManualPoints([]);
    setResult(null);
    toast.info('اضغط على العلامات السوداء الأربع بالترتيب: أعلى اليسار → أعلى اليمين → أسفل اليمين → أسفل اليسار');
  };

  // ================= REVIEW / CORRECTIONS =================

  const applyOverrides = async () => {
    if (!result?.scanId || Object.keys(overrides).length === 0) return;
    try {
      const res = await fetch(`/api/scans/${result.scanId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult({ ...result, ...data, status: data.status ?? 'REVIEWED' });
        setOverrides({});
        toast.success('تم تطبيق التصحيحات وإعادة الاحتساب');
      } else {
        toast.error(data.error ?? 'فشل التحديث');
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  const linkStudent = async () => {
    if (!result?.scanId || !linkCode.trim()) return;
    setLinking(true);
    try {
      const res = await fetch(`/api/scans/${result.scanId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentCode: linkCode.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult({ ...result, studentCode: data.studentCode, studentId: data.studentId });
        toast.success(`تم ربط الورقة بالطالب رقم ${data.studentCode}`);
      } else {
        toast.error(data.error ?? 'فشل ربط الطالب');
      }
    } finally {
      setLinking(false);
    }
  };

  // ================= RENDER =================

  return (
    <div className="space-y-4" dir="rtl">
      {/* tabs */}
      <div className="flex gap-2">
        <Button
          variant={tab === 'live' ? 'default' : 'outline'}
          className={tab === 'live' ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
          onClick={() => setTab('live')}
        >
          <Camera className="ml-1 h-4 w-4" /> كاميرا مباشرة
        </Button>
        <Button
          variant={tab === 'upload' ? 'default' : 'outline'}
          className={tab === 'upload' ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
          onClick={() => setTab('upload')}
        >
          <Upload className="ml-1 h-4 w-4" /> رفع صور / PDF
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanLine className="h-5 w-5 text-emerald-600" />
            {tab === 'live' ? 'مسح مباشر بجوار الكاميرا' : 'رفع ورقة الإجابة'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tab === 'live' ? (
            <div className="space-y-3">
              <div className="relative overflow-hidden rounded-xl bg-black" style={{ minHeight: 260 }}>
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className={`block h-auto w-full ${scanState === 'IDLE' || scanState === 'ERROR' ? 'hidden' : ''}`}
                />
                {(scanState === 'IDLE' || scanState === 'ERROR') && (
                  <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 p-6 text-center text-slate-300">
                    <CameraOff className="h-10 w-10" />
                    <div className="text-sm">{cameraError ?? 'اضغط «تشغيل الكاميرا» ووجّه الجهاز نحو الورقة — يلتقط النظام الصورة تلقائيًا عند ثبات الورقة'}</div>
                  </div>
                )}
                {scanState !== 'IDLE' && scanState !== 'ERROR' && (
                  <>
                    {/* framing guide */}
                    <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-dashed border-white/40" />
                    <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white">
                      {scanState === 'PROCESSING' || scanState === 'CAPTURING' ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {stateLabel[scanState]}
                        </span>
                      ) : scanState === 'PAGE_STABLE' ? (
                        <span className="flex items-center gap-1 text-emerald-300">
                          <Zap className="h-3.5 w-3.5" /> {stateLabel[scanState]}
                        </span>
                      ) : (
                        stateLabel[scanState]
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {scanState === 'IDLE' || scanState === 'ERROR' ? (
                  <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => void startCamera()}>
                    <Camera className="ml-1 h-4 w-4" /> تشغيل الكاميرا
                  </Button>
                ) : (
                  <>
                    <Button variant="secondary" onClick={() => void captureFrame()} disabled={busyRef.current}>
                      <Camera className="ml-1 h-4 w-4" /> التقاط الآن
                    </Button>
                    <Button variant="outline" size="icon" onClick={() => void toggleTorch()} disabled={!torchSupported} title={torchSupported ? 'الفلاش' : 'الفلاش غير مدعوم'}>
                      {torchOn ? <Flashlight className="h-4 w-4" /> : <FlashlightOff className="h-4 w-4" />}
                    </Button>
                    <Button variant="outline" size="icon" onClick={() => void switchCamera()} title="تبديل الكاميرا">
                      <SwitchCamera className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      title="إيقاف الكاميرا"
                      onClick={() => {
                        stopCamera();
                        setScanState('IDLE');
                      }}
                    >
                      <CameraOff className="h-4 w-4" />
                    </Button>
                    <span className="text-xs text-slate-500">
                      {torchSupported ? '' : 'الفلاش غير متاح على هذا الجهاز — '}
                      الالتقاط تلقائي عند ثبات الورقة
                    </span>
                  </>
                )}
              </div>
              {cameraError && scanState === 'ERROR' && (
                <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700">{cameraError}</div>
              )}
            </div>
          ) : (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void handleFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 p-6 text-center transition hover:border-emerald-400 hover:bg-emerald-50"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                capture="environment"
                className="hidden"
                onChange={(e) => void handleFiles(e.target.files)}
              />
              {batch?.running ? (
                <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
              ) : (
                <FileScan className="h-8 w-8 text-emerald-600" />
              )}
              <div className="text-sm font-medium text-emerald-800">
                التقط صورة أو أفلت ملفًا هنا — صور أو PDF متعدد الصفحات
              </div>
              <div className="text-xs text-slate-500">
                يُقرأ رمز QR تلقائيًا لتحديد نسخة الامتحان • ملف PDF يُعالَج صفحة صفحة مع شريط تقدم
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">النسخة (اختياري عند فشل QR):</span>
            <Select value={hintVersion} onValueChange={setHintVersion}>
              <SelectTrigger className="h-8 w-64 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">تلقائي (من رمز QR)</SelectItem>
                {examVersions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={batch?.running} onClick={startManualMode}>
              <Crosshair className="h-3.5 w-3.5" /> ضبط الزوايا يدويًا
            </Button>
          </div>

          {manualMode && pendingImage && (
            <div className="mt-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-3">
              <div className="mb-2 text-xs font-semibold text-amber-800">
                اضغط على العلامات السوداء الأربع بالترتيب ({manualPoints.length}/4):{' '}
                <b>{CORNER_LABELS[Math.min(manualPoints.length, 3)]}</b>{' '}
                <button
                  className="text-[10px] text-slate-500 underline"
                  onClick={() => {
                    setManualMode(false);
                    setManualPoints([]);
                  }}
                >
                  إلغاء
                </button>
              </div>
              <div className="relative max-h-[60vh] overflow-auto rounded-lg bg-black">
                <img
                  ref={imgRef}
                  src={pendingImage}
                  alt="ورقة الإجابة"
                  className="block w-full cursor-crosshair select-none"
                  onClick={onManualClick}
                />
                {manualPoints.map((p, i) => (
                  <span
                    key={i}
                    className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-red-500"
                    style={{
                      left: `${(p.x / (imgRef.current?.naturalWidth || 1)) * 100}%`,
                      top: `${(p.y / (imgRef.current?.naturalHeight || 1)) * 100}%`,
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* PDF batch progress */}
      {batch && (batch.running || batch.pages.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">معالجة ملف PDF {batch.running ? '…' : '— انتهت'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>
                {batch.done} / {batch.total} صفحة
              </span>
              <span className="flex gap-3">
                <span className="text-emerald-600">نجحت: {batch.okCount}</span>
                <span className="text-sky-600">مكررة: {batch.dupCount}</span>
                <span className="text-red-600">فاشلة: {batch.failCount}</span>
              </span>
            </div>
            <Progress value={batch.total ? (batch.done / batch.total) * 100 : 0} className="h-2" />
            <div className="max-h-56 overflow-y-auto rounded-lg border">
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="p-2">صفحة</th>
                    <th className="p-2">الحالة</th>
                    <th className="p-2">رقم الطالب</th>
                    <th className="p-2">الدرجة</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {batch.pages.map((p) => (
                    <tr key={p.index} className="border-t">
                      <td className="p-2 font-bold">{p.index + 1}</td>
                      <td className="p-2">
                        {p.duplicate ? (
                          <Badge className="bg-sky-100 text-sky-700">مكررة</Badge>
                        ) : p.ok ? (
                          <Badge className="bg-emerald-100 text-emerald-700">تمت</Badge>
                        ) : (
                          <Badge className="bg-red-100 text-red-700">فشلت</Badge>
                        )}
                        {p.needsReview && ' ⚠'}
                      </td>
                      <td className="p-2">{p.studentCode ?? '—'}</td>
                      <td className="p-2">
                        {p.score != null ? `${p.score}/${p.maxScore ?? ''}` : '—'}
                      </td>
                      <td className="p-2 text-red-600">{p.error ? String(p.error).slice(0, 60) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">النتائج</CardTitle>
            </CardHeader>
            <CardContent>
              {(result.answers ?? []).length === 0 ? (
                <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
                  {result.diagnostics?.errors?.[0] ?? 'تعذر تحليل الورقة'}
                </div>
              ) : (
                <div className="max-h-96 space-y-1.5 overflow-y-auto pl-1">
                  {(result.answers ?? []).map((a) => (
                    <div key={a.number} className="flex items-center gap-3 rounded-lg border px-3 py-1.5">
                      <span className="w-8 text-sm font-bold text-slate-700">{a.number}</span>
                      <div className="flex flex-1 gap-1">
                        {Object.entries(a.ratios).map(([letter, ratio]) => (
                          <div key={letter} className="flex-1">
                            <div className="flex justify-between text-[9px] text-slate-400">
                              <span>{letter}</span>
                              <span>{Math.round(ratio * 100)}%</span>
                            </div>
                            <div className="h-1.5 rounded bg-slate-100">
                              <div
                                className={`h-1.5 rounded ${
                                  a.detected === letter && a.status === 'selected'
                                    ? 'bg-emerald-500'
                                    : ratio > 0.35
                                      ? 'bg-red-400'
                                      : 'bg-slate-300'
                                }`}
                                style={{ width: `${Math.min(100, ratio * 100)}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                      <Badge className={statusMeta[a.status].cls}>{statusMeta[a.status].label}</Badge>
                      <span className="w-14 text-left text-[10px] text-slate-400">
                        {Math.round(a.confidence * 100)}%
                      </span>
                      <Select
                        value={overrides[String(a.number)] ?? ''}
                        onValueChange={(v) => setOverrides({ ...overrides, [String(a.number)]: v })}
                      >
                        <SelectTrigger className="h-7 w-16 text-[10px]">
                          <SelectValue placeholder="تعديل" />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.keys(a.ratios).map((l) => (
                            <SelectItem key={l} value={l}>
                              {l}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              )}
              {Object.keys(overrides).length > 0 && (
                <Button
                  size="sm"
                  className="mt-3 bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => void applyOverrides()}
                >
                  تطبيق التصحيحات وإعادة الاحتساب
                </Button>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            {result.grade && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">الدرجة</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="text-center">
                    <div className="text-4xl font-black text-emerald-600">{result.grade.score}</div>
                    <div className="text-xs text-slate-500">
                      من {result.grade.maxScore} ({result.grade.percent}%)
                    </div>
                  </div>
                  <Progress value={result.grade.percent} className="h-2" />
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
                      صحيحة: {result.grade.correct.length}
                    </div>
                    <div className="rounded-lg bg-red-50 p-2 text-red-600">
                      خاطئة: {result.grade.incorrect.length}
                    </div>
                    <div className="rounded-lg bg-amber-50 p-2 text-amber-700">
                      ملتبسة: {result.grade.ambiguous.length}
                    </div>
                    <div className="rounded-lg bg-slate-50 p-2 text-slate-600">
                      فارغة: {result.grade.unanswered.length}
                    </div>
                  </div>
                  {(result.grade.negativeApplied ?? 0) > 0 && (
                    <div className="rounded-lg bg-orange-50 p-2 text-center text-xs text-orange-700">
                      مطبَّق خصم {result.grade.negativeApplied} درجة على الإجابات الخاطئة
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* identity / review */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <UserCheck className="h-4 w-4 text-emerald-600" /> هوية الطالب
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {result.studentCode ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    <span>
                      رقم الطالب المقروء: <b>{result.studentCode}</b>
                      {result.studentId ? (
                        <span className="text-xs text-emerald-600"> — مرتبط بسجل طالب</span>
                      ) : (
                        <span className="text-xs text-amber-600"> — غير موجود في قاعدة البيانات (تحتاج مراجعة)</span>
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="text-xs text-amber-600">
                    لم يُقرأ رقم الطالب من الفقاعات — يمكنك ربط الورقة يدويًا:
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    value={linkCode}
                    onChange={(e) => setLinkCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="رقم الطالب"
                    inputMode="numeric"
                    className="h-8 flex-1 text-sm"
                  />
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={linking || !linkCode.trim()} onClick={() => void linkStudent()}>
                    {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : 'ربط'}
                  </Button>
                </div>
                {result.needsReview && (
                  <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
                    هذه الورقة في قائمة المراجعة (إجابات ملتبسة / هوية غير مؤكدة / ثقة منخفضة) —
                    صحّح ثم اعتمد.
                  </div>
                )}
                {result.reviewStatus === 'APPROVED' && (
                  <div className="rounded-lg bg-emerald-50 p-2 text-xs text-emerald-700">تم اعتماد الورقة</div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                  <span>الثقة العامة</span>
                  <span className="font-bold text-slate-700">{Math.round((result.overallConfidence ?? 0) * 100)}%</span>
                </div>
                <Progress value={(result.overallConfidence ?? 0) * 100} className="h-2" />
                <Dialog open={diagOpen} onOpenChange={setDiagOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" className="mt-3 w-full gap-1 text-xs">
                      <Stethoscope className="h-4 w-4" /> التشخيص التفصيلي
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-3xl" dir="rtl">
                    <DialogHeader>
                      <DialogTitle className="text-right">تشخيص المسح</DialogTitle>
                      <DialogDescription className="text-right">تفاصيل تقنية لعملية المسح: رمز QR، التصحيح الهندسي، ونسب تظليل الفقاعات.</DialogDescription>
                    </DialogHeader>
                    <ScanDiagnostics result={result} />
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function ScanDiagnostics({ result }: { result: ScanResult }) {
  const stages = result.diagnostics.stages ?? {};
  const stageLabels: Record<string, string> = {
    imageLoaded: 'استلام الصورة',
    preprocessed: 'المعالجة المسبقة',
    sheetDetected: 'اكتشاف الورقة',
    perspectiveCorrected: 'تصحيح المنظور',
    orientationFixed: 'تصحيح الاتجاه',
    templateIdentified: 'تحديد القالب',
    bubblesLoaded: 'تحميل مناطق الفقاعات',
    answersExtracted: 'استخراج الإجابات',
    graded: 'التصحيح',
  };
  return (
    <div className="space-y-3" dir="rtl">
      <div className="grid grid-cols-3 gap-2 text-xs">
        {Object.entries(stageLabels).map(([k, label]) => (
          <div
            key={k}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 ${
              stages[k] ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
            }`}
          >
            <FileScan className="h-3.5 w-3.5" /> {label} {stages[k] ? '✓' : '✕'}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
        <div>القالب: {String(result.diagnostics.templateId ?? '—')}</div>
        <div>الاستراتيجية: {String(result.diagnostics.strategy ?? '—')}</div>
        <div>الدوران: {String(result.diagnostics.rotationDeg ?? 0)}°</div>
        <div>العلامات المرجعية: {String(result.diagnostics.markersFound ?? '—')}/4</div>
      </div>
      {(result.diagnostics.warnings?.length ?? 0) > 0 && (
        <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
          {result.diagnostics.warnings?.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
      {(result.diagnostics.errors?.length ?? 0) > 0 && (
        <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700">
          {result.diagnostics.errors?.map((w, i) => <div key={i}>✕ {w}</div>)}
        </div>
      )}
      {result.images?.debug && (
        <div>
          <div className="mb-1 text-xs font-semibold text-slate-600">الصورة المعالجة مع الفقاعات المتوقعة:</div>
          <img src={result.images.debug} alt="debug overlay" className="w-full rounded-lg border" />
        </div>
      )}
      {result.images?.corrected && (
        <div>
          <div className="mb-1 text-xs font-semibold text-slate-600">الورقة بعد تصحيح المنظور:</div>
          <img src={result.images.corrected} alt="corrected" className="w-full rounded-lg border" />
        </div>
      )}
      <div className="flex items-center gap-2 text-[10px] text-slate-400">
        <RefreshCw className="h-3 w-3" /> يعاد تحليل الصورة على الخادم عند كل تعديل
      </div>
    </div>
  );
}
