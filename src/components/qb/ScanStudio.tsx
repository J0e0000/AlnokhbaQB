'use client';

// ============================================================
// ALNOKHBA QB — Scan Studio
// Scan/photograph → engine → confidence review → grade → overrides
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Camera, CameraOff, CircleStop, Crosshair, FileScan, Loader2, ScanLine, Stethoscope, Video } from 'lucide-react';
import { apiErrorMessage, prepareUpload } from '@/lib/image/prepareUpload';
import type { QBAnswerStatus, QBScannedAnswer, QBScanGrade } from '@/lib/qb/types';

interface ScanResult {
  scanId: string;
  answers: QBScannedAnswer[];
  grade: QBScanGrade | null;
  studentCode: string | null;
  overallConfidence: number;
  status: string;
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

const statusMeta: Record<QBAnswerStatus, { label: string; cls: string }> = {
  selected: { label: 'محدد', cls: 'bg-success/10 text-success' },
  unanswered: { label: 'فارغ', cls: 'bg-muted text-muted-foreground' },
  multiple: { label: 'متعدد ⚠', cls: 'bg-destructive/10 text-destructive' },
  unclear: { label: 'غير واضح ⚠', cls: 'bg-warning/10 text-warning' },
  invalid: { label: 'غير صالح ⚠', cls: 'bg-destructive/10 text-destructive' },
};

const CORNER_LABELS = ['أعلى اليسار', 'أعلى اليمين', 'أسفل اليمين', 'أسفل اليسار'];

export default function ScanStudio({ onScanned }: { onScanned?: () => void }) {
  const [examVersions, setExamVersions] = useState<{ id: string; label: string }[]>([]);
  const [hintVersion, setHintVersion] = useState<string>('auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [diagOpen, setDiagOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // ---- live camera scanning (in-app viewfinder, same /api/scan pipeline) ----
  const [camActive, setCamActive] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // ---- manual 4-corner fallback (port of legacy nokhba-qb calibration) ----
  const [pendingImage, setPendingImage] = useState<string | null>(null); // data URL of the uploaded sheet
  const [manualMode, setManualMode] = useState(false);
  const [manualPoints, setManualPoints] = useState<Array<{ x: number; y: number }>>([]);
  const imgRef = useRef<HTMLImageElement>(null);

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

  useState(() => {
    void loadVersions();
  });

  // Release the camera when the studio unmounts.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamActive(false);
  }, []);

  const startCamera = async () => {
    setCamError(null);
    try {
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        throw new Error('INSECURE');
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('NO_API');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCamActive(true);
    } catch (e) {
      const name = (e as { name?: string }).name ?? '';
      if (name === 'NotAllowedError') {
        setCamError('تم رفض إذن الكاميرا — اسمح بالكاميرا من إعدادات المتصفح ثم أعد المحاولة، أو ارفع صورة من ملفاتك');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setCamError('لا توجد كاميرا متاحة على هذا الجهاز — ارفع صورة الورقة من ملفاتك');
      } else if (name === 'NotReadableError') {
        setCamError('الكاميرا مستخدمة من تطبيق آخر — أغلقه ثم أعد المحاولة');
      } else {
        setCamError('تعذر تشغيل الكاميرا — ارفع صورة الورقة من ملفاتك');
      }
    }
  };

  // Grab the current video frame, then feed the exact same scan pipeline
  // used for uploaded photos (QR → markers → bubbles → grading).
  const captureFrame = async () => {
    const video = videoRef.current;
    if (!video || !camActive || busy) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      setResult(null);
      setOverrides({});
      setManualMode(false);
      setManualPoints([]);
      setPendingImage(dataUrl); // kept for the manual-corner fallback
      await submitScan(dataUrl, undefined);
    } catch {
      toast.error('تعذر التقاط الإطار من الكاميرا');
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.size > 25 * 1024 * 1024) {
      toast.error('حجم الصورة كبير جدًا (الحد 25 ميجابايت)');
      return;
    }
    setBusy(true);
    setResult(null);
    setOverrides({});
    setManualMode(false);
    setManualPoints([]);
    try {
      // Downscale + JPEG re-encode on-device: keeps the base64 JSON body under
      // Vercel's 4.5 MB function payload limit for typical phone photos.
      const prepared = await prepareUpload(file);
      setPendingImage(prepared.dataUrl); // kept for the manual-corner fallback
      await submitScan(prepared.dataUrl, undefined);
    } catch {
      toast.error('تعذر قراءة الصورة');
      setBusy(false);
    }
  };

  const submitScan = useCallback(async (dataUrl: string, manualMarkers?: Array<{ x: number; y: number }>) => {
    setBusy(true);
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
      const data = (await res.json().catch(() => null)) as (ScanResult & {
        error?: string;
        stages?: Record<string, boolean>;
        warnings?: string[];
      }) | null;
      if (!res.ok || !data) {
        const message = await apiErrorMessage(res, 'فشل تحليل الورقة');
        toast.error(message);
        setResult({
          scanId: '',
          answers: [],
          grade: null,
          studentCode: null,
          overallConfidence: 0,
          status: 'FAILED',
          diagnostics: { errors: [data?.error ?? message], stages: data?.stages ?? {}, warnings: data?.warnings ?? [] },
          images: data?.images,
        });
        return;
      }
      setResult(data);
      setManualMode(false);
      onScanned?.();
      const ambiguous = (data.answers as QBScannedAnswer[]).filter((a) => a.status === 'multiple' || a.status === 'unclear');
      if (ambiguous.length > 0) toast.warning(`${ambiguous.length} إجابة تحتاج مراجعة (غير واضحة/متعددة)`);
      else toast.success('تمت قراءة الورقة بنجاح');
    } catch {
      toast.error('تعذر الاتصال بخدمة التحليل');
    } finally {
      setBusy(false);
    }
  }, [hintVersion, onScanned]);

  // ---- manual corner clicking (order: TL, TR, BR, BL — like the original) ----
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
      void submitScan(pendingImage, next);
    }
  };

  const startManualMode = () => {
    if (!pendingImage) {
      toast.error('ارفع صورة الورقة أولًا');
      return;
    }
    setManualMode(true);
    setManualPoints([]);
    setResult(null);
    toast.info('اضغط على العلامات السوداء الأربع بالترتيب: أعلى اليسار → أعلى اليمين → أسفل اليمين → أسفل اليسار');
  };

  const applyOverrides = async () => {
    if (!result?.scanId || Object.keys(overrides).length === 0) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/scans/${result.scanId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult({ ...result, ...data });
        setOverrides({});
        toast.success('تم تطبيق التصحيحات وإعادة الاحتساب');
      } else {
        toast.error(data.error ?? 'فشل التحديث');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" dir="rtl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanLine className="h-5 w-5 text-success" /> مسح ورقة الإجابة
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* The video stays mounted at all times: the MediaStream must attach
              while the element exists, visibility is toggled via CSS. */}
          <div className={`relative overflow-hidden rounded-xl border-2 border-success/40 ${camActive ? 'bg-black' : 'bg-card'}`}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`mx-auto block max-h-[55vh] w-auto max-w-full ${camActive ? 'block' : 'hidden'}`}
              aria-label="معاينة الكاميرا الحية"
            />
            {!camActive && (
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleFiles(e.dataTransfer.files);
                }}
                onClick={() => inputRef.current?.click()}
                className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed border-success/40 bg-success/5 p-6 text-center transition hover:border-success/40 hover:bg-success/10"
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    void handleFiles(e.target.files);
                    e.target.value = ''; // allow re-picking the same photo later
                  }}
                />
                {busy ? (
                  <Loader2 className="h-8 w-8 animate-spin text-success" />
                ) : (
                  <Camera className="h-8 w-8 text-success" />
                )}
                <div className="text-sm font-medium text-success">التقط صورة للورقة أو أفلتها هنا</div>
                <div className="text-[13px] text-muted-foreground">الكاميرا أو الماسح الضوئي — حتى 25 ميجابايت، تُضغط الصور تلقائيًا قبل الإرسال، ويُقرأ رمز QR لتحديد نسخة الامتحان</div>
              </div>
            )}
            {camActive && (
              <div className="flex flex-wrap items-center justify-center gap-2 border-t border-success/40 bg-success/10 p-3">
                <Button
                  className="h-11 gap-1 bg-success px-5 text-white hover:bg-success"
                  disabled={busy}
                  onClick={() => void captureFrame()}
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ScanLine className="h-5 w-5" />}
                  {busy ? 'جارٍ التحليل…' : 'التقط الصفحة وحدّلها'}
                </Button>
                <Button variant="outline" className="h-11 gap-1" onClick={stopCamera} disabled={busy}>
                  <CircleStop className="h-4 w-4" /> إيقاف الكاميرا
                </Button>
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!camActive && (
              <Button className="h-9 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={() => void startCamera()}>
                <Video className="h-4 w-4" /> افتح الكاميرا داخل التطبيق
              </Button>
            )}
            <span className="text-[13px] text-muted-foreground">النسخة (اختياري عند فشل QR):</span>
            <Select value={hintVersion} onValueChange={setHintVersion}>
              <SelectTrigger className="h-9 w-full max-w-64 text-[13px] sm:w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">تلقائي (من رمز QR)</SelectItem>
                {examVersions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8 gap-1 text-[13px]" disabled={busy} onClick={startManualMode}>
              <Crosshair className="h-3.5 w-3.5" /> ضبط الزوايا يدويًا
            </Button>
          </div>
          {camError && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive">
              <CameraOff className="mt-0.5 h-4 w-4 shrink-0" />
              {camError}
            </p>
          )}
          {manualMode && pendingImage && (
            <div className="mt-3 rounded-xl border-2 border-warning/40 bg-warning/10 p-3">
              <div className="mb-2 text-[13px] font-semibold text-warning">
                اضغط على العلامات السوداء الأربع بالترتيب ({manualPoints.length}/4):
                {' '}
                <b>{CORNER_LABELS[Math.min(manualPoints.length, 3)]}</b>
                {' '}
                <button className="text-[13px] text-muted-foreground underline" onClick={() => { setManualMode(false); setManualPoints([]); }}>إلغاء</button>
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
                    className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-destructive/100"
                    style={{ left: `${(p.x / (imgRef.current?.naturalWidth || 1)) * 100}%`, top: `${(p.y / (imgRef.current?.naturalHeight || 1)) * 100}%` }}
                  />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {result && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">النتائج</CardTitle>
              </CardHeader>
              <CardContent>
                {result.answers.length === 0 ? (
                  <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                    {result.diagnostics.errors?.[0] ?? 'تعذر تحليل الورقة'}
                  </div>
                ) : (
                  <div className="max-h-96 space-y-1.5 overflow-y-auto ps-1">
                    {result.answers.map((a) => (
                      <div key={a.number} className="flex items-center gap-3 rounded-lg border px-3 py-1.5">
                        <span className="w-8 text-sm font-bold text-foreground">{a.number}</span>
                        <div className="flex flex-1 gap-1">
                          {Object.entries(a.ratios).map(([letter, ratio]) => (
                            <div key={letter} className="flex-1">
                              <div className="flex justify-between text-[13px] text-muted-foreground">
                                <span>{letter}</span><span>{Math.round(ratio * 100)}%</span>
                              </div>
                              <div className="h-1.5 rounded bg-muted">
                                <div
                                  className={`h-1.5 rounded ${a.detected === letter && a.status === 'selected' ? 'bg-success' : ratio > 0.35 ? 'bg-red-400' : 'bg-secondary'}`}
                                  style={{ width: `${Math.min(100, ratio * 100)}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                        <Badge className={statusMeta[a.status].cls}>{statusMeta[a.status].label}</Badge>
                        <span className="w-14 text-end text-[13px] text-muted-foreground">{Math.round(a.confidence * 100)}%</span>
                        <Select
                          value={overrides[String(a.number)] ?? ''}
                          onValueChange={(v) => setOverrides({ ...overrides, [String(a.number)]: v })}
                        >
                          <SelectTrigger className="h-7 w-16 text-[13px]"><SelectValue placeholder="تعديل" /></SelectTrigger>
                          <SelectContent>
                            {Object.keys(a.ratios).map((l) => (
                              <SelectItem key={l} value={l}>{l}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
                {Object.keys(overrides).length > 0 && (
                  <Button size="sm" className="mt-3 bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={() => void applyOverrides()}>
                    تطبيق التصحيحات وإعادة الاحتساب
                  </Button>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              {result.grade && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base">الدرجة</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="text-center">
                      <div className="text-4xl font-black text-success">{result.grade.score}</div>
                      <div className="text-[13px] text-muted-foreground">من {result.grade.maxScore} ({result.grade.percent}%)</div>
                    </div>
                    <Progress value={result.grade.percent} className="h-2" />
                    <div className="grid grid-cols-2 gap-2 text-[13px]">
                      <div className="rounded-lg bg-success/10 p-2 text-success">صحيحة: {result.grade.correct.length}</div>
                      <div className="rounded-lg bg-destructive/10 p-2 text-destructive">خاطئة: {result.grade.incorrect.length}</div>
                      <div className="rounded-lg bg-warning/10 p-2 text-warning">ملتبسة: {result.grade.ambiguous.length}</div>
                      <div className="rounded-lg bg-muted/60 p-2 text-muted-foreground">فارغة: {result.grade.unanswered.length}</div>
                    </div>
                    {(result.grade.negativeApplied ?? 0) > 0 && (
                      <div className="rounded-lg bg-orange-50 p-2 text-center text-[13px] text-orange-700">
                        مطبَّق خصم {result.grade.negativeApplied} درجة على الإجابات الخاطئة
                      </div>
                    )}
                    {result.studentCode && (
                      <div className="text-center text-[13px] text-muted-foreground">رقم الطالب المقروء: <span className="font-bold text-foreground">{result.studentCode}</span></div>
                    )}
                  </CardContent>
                </Card>
              )}
              <Card>
                <CardContent className="pt-4">
                  <div className="mb-2 flex items-center justify-between text-[13px] text-muted-foreground">
                    <span>الثقة العامة</span>
                    <span className="font-bold text-foreground">{Math.round(result.overallConfidence * 100)}%</span>
                  </div>
                  <Progress value={result.overallConfidence * 100} className="h-2" />
                  <Dialog open={diagOpen} onOpenChange={setDiagOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm" className="mt-3 w-full gap-1 text-[13px]">
                        <Stethoscope className="h-4 w-4" /> التشخيص التفصيلي
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-3xl" dir="rtl">
                      <DialogHeader><DialogTitle className="text-start">تشخيص المسح</DialogTitle></DialogHeader>
                      <ScanDiagnostics result={result} />
                    </DialogContent>
                  </Dialog>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
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
      <div className="grid grid-cols-3 gap-2 text-[13px]">
        {Object.entries(stageLabels).map(([k, label]) => (
          <div key={k} className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 ${stages[k] ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
            <FileScan className="h-3.5 w-3.5" /> {label} {stages[k] ? '✓' : '✕'}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[13px] text-muted-foreground">
        <div>القالب: {String(result.diagnostics.templateId ?? '—')}</div>
        <div>الاستراتيجية: {String(result.diagnostics.strategy ?? '—')}</div>
        <div>الدوران: {String(result.diagnostics.rotationDeg ?? 0)}°</div>
        <div>العلامات المرجعية: {String(result.diagnostics.markersFound ?? '—')}/4</div>
      </div>
      {(result.diagnostics.warnings?.length ?? 0) > 0 && (
        <div className="rounded-lg bg-warning/10 p-2 text-[13px] text-warning">
          {result.diagnostics.warnings?.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
      {(result.diagnostics.errors?.length ?? 0) > 0 && (
        <div className="rounded-lg bg-destructive/10 p-2 text-[13px] text-destructive">
          {result.diagnostics.errors?.map((w, i) => <div key={i}>✕ {w}</div>)}
        </div>
      )}
      {result.images?.debug && (
        <div>
          <div className="mb-1 text-[13px] font-semibold text-muted-foreground">الصورة المعالجة مع الفقاعات المتوقعة:</div>
          <img src={result.images.debug} alt="debug overlay" className="w-full rounded-lg border" />
        </div>
      )}
      {result.images?.corrected && (
        <div>
          <div className="mb-1 text-[13px] font-semibold text-muted-foreground">الورقة بعد تصحيح المنظور:</div>
          <img src={result.images.corrected} alt="corrected" className="w-full rounded-lg border" />
        </div>
      )}
    </div>
  );
}
