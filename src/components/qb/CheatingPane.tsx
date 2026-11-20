'use client';

// ============================================================
// ALNOKHBA QB — Cheating Detection (كود الجلوس + كشف الغش)
// Two-phase workflow:
//   1. Seating registry: one-time numeric codes per physical seat.
//      The student fills THE SEAT's code in the OMR ID bubbles —
//      identity travels with the seat, not the person.
//   2. Analysis: nearby seats (|Δseat| ≤ proximity) whose answers
//      match on ≥ threshold% of common questions → suspected pair.
//      Identical WRONG answers are surfaced as the strongest signal.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BadgeAlert,
  BadgeCheck,
  CircleDot,
  ClipboardList,
  Copy,
  Eraser,
  Eye,
  Fingerprint,
  Loader2,
  Printer,
  ScanLine,
  Search,
  ShieldAlert,
  UserX,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, PaneHeader, StatCard } from '@/components/qb/pane-kit';

// ---- types ----

interface ExamRow {
  id: string;
  title: string;
  status: string;
}

interface Sitting {
  id: string;
  code: string;
  seatNumber: number;
  studentName: string | null;
  studentCode: string | null;
  status: string; // unused | used | invalidated
  scanId: string | null;
  usedAt: string | null;
  createdAt: string;
}

interface SittingsPayload {
  sittings: Sitting[];
  summary?: {
    total: number;
    used: number;
    unused: number;
    invalidated: number;
    assigned: number;
  };
}

interface PairResult {
  seatA: number | null;
  seatB: number | null;
  codeA: string;
  codeB: string;
  studentNameA: string | null;
  studentNameB: string | null;
  seatGap: number;
  commonQuestions: number;
  sameAnswers: number;
  matchPct: number;
  bothWrongOverlap: number;
  sameWrong: number;
  sameWrongPct: number;
  flagged: boolean;
  severity: 'high' | 'medium';
}

interface AnalysisPayload {
  mode: 'sitting-codes' | 'seat-fallback';
  settings: { proximity: number; threshold: number; minOverlap: number };
  stats: {
    scansCount: number;
    seatedCount: number;
    sittingsCount: number;
    compared: number;
    flaggedCount: number;
    highestMatch: number;
    unlinkedCodes: string[];
  };
  pairs: PairResult[];
}

const STEPS: Array<{ icon: typeof Wand2; title: string; hint: string }> = [
  {
    icon: Wand2,
    title: '١. ولّد أكواد الجلوس',
    hint: 'كود رقمي واحد لكل مقعد — يُستخدم مرة واحدة فقط',
  },
  {
    icon: Fingerprint,
    title: '٢. الطالب يكتب كود الجلوس',
    hint: 'في خانة الرقم على ورقة OMR بدل رقم الطالب',
  },
  {
    icon: ScanLine,
    title: '٣. امسح وصحح كالمعتاد',
    hint: 'كل ورقة تُربط تلقائيًا برقم مقعدها',
  },
  {
    icon: ShieldAlert,
    title: '٤. شغّل كشف الغش',
    hint: 'مقاعد قريبة + تشابه إجابات ≥ الحد = اشتباه',
  },
];

function statusChip(status: string) {
  if (status === 'used') {
    return (
      <Badge className="gap-1 bg-success/10 text-success">
        <BadgeCheck className="h-3 w-3" /> مستخدم
      </Badge>
    );
  }
  if (status === 'invalidated') {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <UserX className="h-3 w-3" /> ملغي
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 border-warning/40 text-warning dark:text-warning">
      <CircleDot className="h-3 w-3" /> متاح
    </Badge>
  );
}

function matchTone(sev: 'high' | 'medium'): string {
  return sev === 'high' ? 'text-destructive dark:text-destructive' : 'text-warning dark:text-warning';
}

export default function CheatingPane() {
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [examsLoading, setExamsLoading] = useState(true);
  const [examId, setExamId] = useState<string>('');

  // registry
  const [sittings, setSittings] = useState<Sitting[]>([]);
  const [sittingsLoading, setSittingsLoading] = useState(false);
  const [genFrom, setGenFrom] = useState('1');
  const [genTo, setGenTo] = useState('40');
  const [genDigits, setGenDigits] = useState('6');
  const [generating, setGenerating] = useState(false);

  // analysis
  const [proximity, setProximity] = useState(2);
  const [threshold, setThreshold] = useState(85);
  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setExamsLoading(true);
      try {
        const res = await fetch('/api/exams', { cache: 'no-store' });
        const data = (await res.json()) as ExamRow[];
        if (alive) setExams(Array.isArray(data) ? data : []);
      } catch {
        toast.error('تعذر تحميل الامتحانات');
      } finally {
        if (alive) setExamsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const loadSittings = useCallback(async (id: string) => {
    if (!id) return;
    setSittingsLoading(true);
    try {
      const res = await fetch(`/api/exams/${id}/sittings`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as SittingsPayload;
      setSittings(Array.isArray(data.sittings) ? data.sittings : []);
    } catch {
      toast.error('تعذر تحميل سجل الجلوس');
      setSittings([]);
    } finally {
      setSittingsLoading(false);
    }
  }, []);

  const pickExam = (id: string) => {
    setExamId(id);
    setAnalysis(null);
    void loadSittings(id);
  };

  const generate = async () => {
    if (!examId) return;
    const from = parseInt(genFrom, 10);
    const to = parseInt(genTo, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
      toast.error('نطاق المقاعد غير صالح');
      return;
    }
    if (to - from + 1 > 500) {
      toast.error('الحد الأقصى 500 مقعد');
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch(`/api/exams/${examId}/sittings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatFrom: from, seatTo: to, digits: parseInt(genDigits, 10) || 6 }),
      });
      const data = (await res.json()) as SittingsPayload & { created?: number; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'تعذر توليد الأكواد');
        return;
      }
      setSittings(Array.isArray(data.sittings) ? data.sittings : []);
      toast.success(`تم توليد ${data.created ?? 0} كود جلوس جديد`);
    } catch {
      toast.error('تعذر توليد الأكواد');
    } finally {
      setGenerating(false);
    }
  };

  const clearUnused = async () => {
    if (!examId) return;
    const res = await fetch(`/api/exams/${examId}/sittings?scope=unused`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('تعذر الحذف');
      return;
    }
    const data = (await res.json()) as { deleted: number };
    toast.info(`تم حذف ${data.deleted} كود غير مستخدم`);
    void loadSittings(examId);
  };

  const invalidate = async (sitting: Sitting) => {
    if (!examId) return;
    const next = sitting.status === 'invalidated' ? 'unused' : 'invalidated';
    const res = await fetch(`/api/exams/${examId}/sittings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sitting.id, status: next }),
    });
    if (!res.ok) {
      toast.error('تعذر التحديث');
      return;
    }
    setSittings((prev) =>
      prev.map((s) => (s.id === sitting.id ? { ...s, status: next } : s))
    );
  };

  const summary = useMemo(() => {
    const used = sittings.filter((s) => s.status === 'used').length;
    const invalidated = sittings.filter((s) => s.status === 'invalidated').length;
    return {
      total: sittings.length,
      used,
      available: sittings.length - used - invalidated,
      invalidated,
    };
  }, [sittings]);

  const copyCodes = async () => {
    if (!sittings.length) return;
    const text = sittings
      .filter((s) => s.status !== 'invalidated')
      .map((s) => `مقعد ${s.seatNumber} — ${s.code}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('تم نسخ قائمة الأكواد');
    } catch {
      toast.error('تعذر النسخ');
    }
  };

  const printRoster = () => {
    if (!sittings.length) return;
    const rows = sittings
      .filter((s) => s.status !== 'invalidated')
      .map(
        (s) =>
          `<tr><td>${s.seatNumber}</td><td class="code">${s.code}</td><td>${s.studentName ?? ''}</td></tr>`
      )
      .join('');
    const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>كشف أكواد الجلوس</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, sans-serif; padding: 32px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.meta { color: #555; font-size: 12px; margin: 0 0 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #999; padding: 7px 10px; text-align: center; }
  th { background: #eee; }
  td.code { font-weight: 800; letter-spacing: 3px; font-size: 16px; }
</style></head><body>
<h1>كشف أكواد الجلوس</h1>
<p class="meta">اكتب كود الجلوس الخاص بمقعدك في خانة الرقم على ورقة الإجابة — كل كود يُستخدم مرة واحدة فقط.</p>
<table><thead><tr><th>رقم المقعد</th><th>كود الجلوس</th><th>الطالب (اختياري)</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
    const win = window.open('', '_blank');
    if (!win) {
      toast.error('المتصفح منع فتح نافذة الطباعة');
      return;
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  };

  const runAnalysis = async () => {
    if (!examId) return;
    setAnalyzing(true);
    try {
      const res = await fetch(
        `/api/exams/${examId}/cheating?proximity=${proximity}&threshold=${threshold}`,
        { cache: 'no-store' }
      );
      const data = (await res.json()) as AnalysisPayload & { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'تعذر تشغيل التحليل');
        return;
      }
      setAnalysis(data);
      if (data.stats.flaggedCount > 0) {
        toast.warning(`تم اكتشاف ${data.stats.flaggedCount} حالة اشتباه`);
      } else {
        toast.success('لا توجد حالات اشتباه بالحدود الحالية');
      }
    } catch {
      toast.error('تعذر تشغيل التحليل');
    } finally {
      setAnalyzing(false);
    }
  };

  const selectedExam = exams.find((e) => e.id === examId);
  const flagged = analysis?.pairs.filter((p) => p.flagged) ?? [];
  const others = analysis?.pairs.filter((p) => !p.flagged) ?? [];

  // ---- render ----

  if (!examsLoading && exams.length === 0) {
    return (
      <div className="space-y-4">
        <PaneHeader
          icon={ShieldAlert}
          title="كشف الغش — أكواد الجلوس"
          desc="هوية الجلوس تنتقل بالمقعد لا بالطالب: كود رقمي واحد لكل مقعد، والتحليل يقارن إجابات المقاعد المتجاورة"
        />
        <EmptyState
          icon={ClipboardList}
          title="لا توجد امتحانات بعد"
          hint="أنشئ امتحانًا أولًا من معالج OMR، ثم ولّد أكواد الجلوس ووزّعها على المقاعد"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PaneHeader
        icon={ShieldAlert}
        title="كشف الغش — أكواد الجلوس"
        desc="هوية الجلوس تنتقل بالمقعد لا بالطالب: كود رقمي واحد لكل مقعد، والتحليل يقارن إجابات المقاعد المتجاورة"
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div
              key={s.title}
              className="flex items-start gap-2 rounded-xl border bg-background/60 p-2.5"
            >
              <s.icon className="mt-0.5 h-4 w-4 shrink-0 text-success dark:text-success" />
              <div className="min-w-0">
                <div className="text-[12px] font-bold leading-tight">{s.title}</div>
                <div className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
                  {s.hint}
                </div>
              </div>
            </div>
          ))}
        </div>
      </PaneHeader>

      {/* exam picker */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[240px] flex-1 space-y-1.5">
            <Label htmlFor="cheat-exam">الامتحان</Label>
            <Select value={examId} onValueChange={pickExam} disabled={examsLoading}>
              <SelectTrigger id="cheat-exam" aria-label="اختر الامتحان">
                <SelectValue placeholder={examsLoading ? 'جارٍ التحميل…' : 'اختر امتحانًا'} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {exams.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.title} {e.status === 'PUBLISHED' ? '• منشور' : '• مسودة'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedExam && (
            <div className="flex flex-wrap items-center gap-2 pb-1.5">
              <Badge variant="outline">{summary.total} جلوس مسجل</Badge>
              <Badge className="bg-success/10 text-success">
                {summary.used} مستخدم
              </Badge>
              <Badge variant="outline" className="border-warning/40 text-warning dark:text-warning">
                {summary.available} متاح
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {!examId ? (
        <EmptyState
          icon={Fingerprint}
          title="اختر امتحانًا للبدء"
          hint="سجل أكواد الجلوس لهذا الامتحان، وبعد المسح والتصحيح شغّل تحليل التشابه للكشف عن حالات الغش المحتملة"
        />
      ) : (
        <Tabs defaultValue="registry" className="space-y-4">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="registry" className="gap-1.5">
              <ClipboardList className="h-4 w-4" /> سجل الجلوس
            </TabsTrigger>
            <TabsTrigger value="analysis" className="gap-1.5">
              <Search className="h-4 w-4" /> تحليل الغش
            </TabsTrigger>
          </TabsList>

          {/* ================= REGISTRY ================= */}
          <TabsContent value="registry" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">توليد أكواد الجلوس</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-24 space-y-1.5">
                    <Label htmlFor="seat-from">من مقعد</Label>
                    <Input
                      id="seat-from"
                      type="number"
                      min={1}
                      value={genFrom}
                      onChange={(e) => setGenFrom(e.target.value)}
                    />
                  </div>
                  <div className="w-24 space-y-1.5">
                    <Label htmlFor="seat-to">إلى مقعد</Label>
                    <Input
                      id="seat-to"
                      type="number"
                      min={1}
                      value={genTo}
                      onChange={(e) => setGenTo(e.target.value)}
                    />
                  </div>
                  <div className="w-28 space-y-1.5">
                    <Label htmlFor="code-digits">خانات الكود</Label>
                    <Select value={genDigits} onValueChange={setGenDigits}>
                      <SelectTrigger id="code-digits">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {['4', '5', '6', '7'].map((d) => (
                          <SelectItem key={d} value={d}>
                            {d} خانات
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={() => void generate()}
                    disabled={generating}
                    className="gap-1.5"
                  >
                    {generating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Wand2 className="h-4 w-4" />
                    )}
                    توليد الأكواد
                  </Button>
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  اجعل عدد الخانات مطابقًا لخانات «رقم الطالب» في ورقة OMR حتى يستطيع الطالب
                  تعبئة الكود في الفقاعات. المقاعد التي لها كود بالفعل تحتفظ بكودها ما لم تُحذف.
                </p>
              </CardContent>
            </Card>

            {sittingsLoading ? (
              <Card>
                <CardContent className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" /> جارٍ التحميل…
                </CardContent>
              </Card>
            ) : sittings.length === 0 ? (
              <EmptyState
                icon={Fingerprint}
                title="لا توجد أكواد جلوس لهذا الامتحان"
                hint="حدد نطاق المقاعد (مثال: من 1 إلى 40) واضغط توليد الأكواد، ثم اطبع الكشف ووزّع كل كود على مقعده"
              />
            ) : (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-2 pb-3">
                  <CardTitle className="text-sm">
                    سجل الجلوس — {sittings.length} مقعد
                  </CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void copyCodes()}>
                      <Copy className="h-3.5 w-3.5" /> نسخ القائمة
                    </Button>
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={printRoster}>
                      <Printer className="h-3.5 w-3.5" /> طباعة الكشف
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-destructive hover:text-destructive dark:text-destructive"
                      onClick={() => void clearUnused()}
                    >
                      <Eraser className="h-3.5 w-3.5" /> حذف غير المستخدم
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="max-h-96 overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow>
                          <TableHead className="w-16 text-center">المقعد</TableHead>
                          <TableHead className="text-center">كود الجلوس</TableHead>
                          <TableHead className="text-center">الطالب</TableHead>
                          <TableHead className="text-center">الحالة</TableHead>
                          <TableHead className="w-20 text-center">إجراء</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sittings.map((s) => (
                          <TableRow key={s.id}>
                            <TableCell className="text-center font-bold">{s.seatNumber}</TableCell>
                            <TableCell className="text-center">
                              <span className="select-all rounded-md bg-muted px-2.5 py-1 font-mono text-[13px] font-extrabold tracking-[0.2em]">
                                {s.code}
                              </span>
                            </TableCell>
                            <TableCell className="text-center text-[13px] text-muted-foreground">
                              {s.studentName ?? '—'}
                            </TableCell>
                            <TableCell className="text-center">{statusChip(s.status)}</TableCell>
                            <TableCell className="text-center">
                              <Button
                                variant="ghost"
                                size="sm"
                                className={`h-7 px-2 text-[13px] ${
                                  s.status === 'invalidated'
                                    ? 'text-success dark:text-success'
                                    : 'text-destructive dark:text-destructive'
                                }`}
                                onClick={() => void invalidate(s)}
                              >
                                {s.status === 'invalidated' ? 'إلغاء الإلغاء' : 'إبطال'}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ================= ANALYSIS ================= */}
          <TabsContent value="analysis" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">إعدادات الكشف</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>قرب المقاعد المسموح</Label>
                      <Badge variant="outline">± {proximity} مقعد</Badge>
                    </div>
                    <Slider
                      value={[proximity]}
                      min={1}
                      max={5}
                      step={1}
                      onValueChange={(v) => setProximity(v[0] ?? 2)}
                      aria-label="نطاق قرب المقاعد"
                    />
                    <p className="text-[10.5px] text-muted-foreground">
                      يُقارن كل طالب فقط بمن جلس ضمن هذا النطاق من رقم مقعده
                    </p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>حد تشابه الإجابات</Label>
                      <Badge variant="outline">{threshold}%</Badge>
                    </div>
                    <Slider
                      value={[threshold]}
                      min={50}
                      max={100}
                      step={5}
                      onValueChange={(v) => setThreshold(v[0] ?? 85)}
                      aria-label="حد نسبة تشابه الإجابات"
                    />
                    <p className="text-[10.5px] text-muted-foreground">
                      تشابه الإجابات على الأسئلة المشتركة يساوي هذا الحد أو أكثر = اشتباه
                    </p>
                  </div>
                </div>
                <Button onClick={() => void runAnalysis()} disabled={analyzing} className="gap-1.5">
                  {analyzing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  تشغيل التحليل
                </Button>
              </CardContent>
            </Card>

            {analysis && (
              <>
                {analysis.mode === 'seat-fallback' && (
                  <Alert>
                    <CircleDot className="h-4 w-4" />
                    <AlertTitle>وضع الرقم المباشر</AlertTitle>
                    <AlertDescription>
                      هذا الامتحان ليس لديه أكواد جلوس مسجلة — التحليل حاليًا يعامل الرقم المكتوب
                      في الورقة كرقم مقعد مباشرة. ولّد أكواد الجلوس من تبويب «سجل الجلوس» للحصول
                      على هوية مقعد دقيقة.
                    </AlertDescription>
                  </Alert>
                )}
                {analysis.stats.unlinkedCodes.length > 0 && (
                  <Alert variant="destructive">
                    <BadgeAlert className="h-4 w-4" />
                    <AlertTitle>أكواد غير مطابقة لسجل الجلوس</AlertTitle>
                    <AlertDescription>
                      أوراق ممسوحة بكود جلوس غير موجود في السجل:{' '}
                      <span className="font-mono">{analysis.stats.unlinkedCodes.join('، ')}</span>
                      — قد تكون أكواد امتحان آخر أو خطأ في التعبئة.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <StatCard icon={ScanLine} label="أوراق ممسوحة" value={analysis.stats.scansCount} />
                  <StatCard icon={Eye} label="أزواج قورنت" value={analysis.stats.compared} />
                  <StatCard
                    icon={ShieldAlert}
                    label="حالات اشتباه"
                    value={analysis.stats.flaggedCount}
                    tone={analysis.stats.flaggedCount > 0 ? 'red' : 'emerald'}
                  />
                  <StatCard
                    icon={BadgeCheck}
                    label="أعلى تشابه"
                    value={`${analysis.stats.highestMatch}%`}
                    tone={analysis.stats.highestMatch >= threshold ? 'gold' : 'neutral'}
                  />
                </div>

                {analysis.stats.scansCount === 0 ? (
                  <EmptyState
                    icon={ScanLine}
                    title="لا توجد أوراق ممسوحة لهذا الامتحان"
                    hint="امسح أوراق OMR من صفحة «مسح وتصحيح» أولًا، ثم شغّل التحليل"
                  />
                ) : flagged.length === 0 ? (
                  <EmptyState
                    icon={BadgeCheck}
                    title="لا توجد حالات اشتباه بالحدود الحالية"
                    hint={`لم يُسجل أي زوج مقاعد متجاورة تشابهًا ≥ ${threshold}% على الأسئلة المشتركة`}
                  />
                ) : (
                  <div className="space-y-3">
                    <h3 className="flex items-center gap-1.5 text-sm font-bold">
                      <ShieldAlert className="h-4 w-4 text-destructive dark:text-destructive" />
                      الحالات المشتبه فيها ({flagged.length})
                    </h3>
                    {flagged.map((p, i) => (
                      <PairCard key={`f-${i}`} pair={p} />
                    ))}
                    {others.length > 0 && (
                      <details className="rounded-2xl border bg-card">
                        <summary className="cursor-pointer px-4 py-3 text-[13px] font-bold text-muted-foreground">
                          أزواج أخرى مُقارنة ({others.length}) — تحت الحد
                        </summary>
                        <div className="space-y-2 border-t p-3">
                          {others.map((p, i) => (
                            <PairCard key={`o-${i}`} pair={p} compact />
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ---- pair card ----

function PairCard({ pair, compact = false }: { pair: PairResult; compact?: boolean }) {
  const tone = matchTone(pair.severity);
  return (
    <Card className={pair.severity === 'high' ? 'border-destructive/40 dark:border-destructive/40' : 'border-warning/40 dark:border-warning/40'}>
      <CardContent className={compact ? 'space-y-2 p-3' : 'space-y-3 p-4'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono font-bold">
              مقعد {pair.seatA ?? '؟'}
            </Badge>
            <span className="text-[13px] text-muted-foreground">مقابل</span>
            <Badge variant="outline" className="font-mono font-bold">
              مقعد {pair.seatB ?? '؟'}
            </Badge>
            <Badge variant="secondary" className="text-[13px]">
              الفرق {pair.seatGap}
            </Badge>
          </div>
          <Badge
            className={
              pair.severity === 'high'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-warning/10 text-warning'
            }
          >
            {pair.severity === 'high' ? 'اشتباه مرتفع' : 'اشتباه متوسط'}
          </Badge>
        </div>

        {!compact && (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <span className="rounded-md bg-muted px-2 py-0.5 font-mono">{pair.codeA}</span>
            {(pair.studentNameA || pair.studentNameB) && (
              <span>
                {pair.studentNameA ?? 'طالب'} ↔ {pair.studentNameB ?? 'طالب'}
              </span>
            )}
            <span className="rounded-md bg-muted px-2 py-0.5 font-mono">{pair.codeB}</span>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[13px]">
            <span className="font-bold">تشابه الإجابات</span>
            <span className={`font-extrabold ${tone}`}>{pair.matchPct}%</span>
          </div>
          <Progress
            value={Math.min(100, pair.matchPct)}
            aria-label={`نسبة التشابه ${pair.matchPct}%`}
            className={`h-2 ${pair.severity === 'high' ? '[&>div]:bg-destructive/100' : '[&>div]:bg-warning/100'}`}
          />
        </div>

        <div className="grid grid-cols-3 gap-2 text-center text-[13px]">
          <div className="rounded-lg bg-muted px-2 py-1.5">
            <div className="font-extrabold">{pair.commonQuestions}</div>
            <div className="text-muted-foreground">أسئلة مشتركة</div>
          </div>
          <div className="rounded-lg bg-muted px-2 py-1.5">
            <div className="font-extrabold text-success dark:text-success">
              {pair.sameAnswers}
            </div>
            <div className="text-muted-foreground">نفس الإجابة</div>
          </div>
          <div className="rounded-lg bg-muted px-2 py-1.5">
            <div className={`font-extrabold ${pair.sameWrong > 0 ? 'text-destructive dark:text-destructive' : ''}`}>
              {pair.sameWrong}
            </div>
            <div className="text-muted-foreground">
              نفس الخطأ من {pair.bothWrongOverlap} خطأ مشترك
            </div>
          </div>
        </div>

        {!compact && pair.sameWrong > 0 && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            دليل قوي: الطالبان أخطآ في نفس الأسئلة واختارا نفس الإجابة الخاطئة في{' '}
            <span className="font-bold text-destructive dark:text-destructive">{pair.sameWrong}</span> سؤالًا
            ({pair.sameWrongPct}% من أخطائهما المشتركة) — النقل ينتج أخطاء متطابقة.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
