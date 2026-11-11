'use client';

// ============================================================
// ALNOKHBA QB — Online exam pane (PHASE 3 + 4)
// Student tab: list published online exams → start/resume → runner.
// Teacher tab: monitor attempts, scores, security events live.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ExamRunner, { type StartedAttempt } from '@/components/qb/ExamRunner';
import { Clock, GraduationCap, Loader2, MonitorPlay, RefreshCw, ShieldAlert, UserRound } from 'lucide-react';

interface ExamListItem {
  id: string;
  title: string;
  subject: string | null;
  status: string;
  questionCount: number;
  onlineEnabled: boolean;
  durationMin: number;
  attemptsAllowed: number;
  randomizeOrder: boolean;
  securityPolicy: string;
  currentVersion: number;
}

interface AttemptRow {
  id: string;
  studentName: string;
  studentCode: string | null;
  startedAt: string;
  expiresAt: string;
  submittedAt: string | null;
  status: string;
  score: number | null;
  maxScore: number | null;
  securityEvents: number;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: 'جارية', cls: 'bg-emerald-100 text-emerald-700' },
  submitted: { label: 'مُسلَّمة', cls: 'bg-slate-100 text-slate-600' },
  expired: { label: 'انتهى وقتها', cls: 'bg-amber-100 text-amber-800' },
  invalidated: { label: 'ملغاة (مخالفة)', cls: 'bg-red-100 text-red-700' },
};

export default function OnlinePane() {
  const [exams, setExams] = useState<ExamListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadExams = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/exams');
      const data = await res.json();
      const list = (Array.isArray(data) ? data : data.exams ?? []) as ExamListItem[];
      // students may only see exams that are PUBLISHED *and* online-enabled —
      // drafts and archived exams must never appear here
      setExams(list.filter((e) => e.onlineEnabled && e.status === 'PUBLISHED'));
    } catch {
      toast.error('تعذر تحميل الامتحانات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadExams();
  }, [loadExams]);

  return (
    <div className="space-y-4" dir="rtl">
      <Tabs defaultValue="student">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="student" className="gap-1.5 text-xs"><UserRound className="h-3.5 w-3.5" /> وضع الطالب</TabsTrigger>
          <TabsTrigger value="teacher" className="gap-1.5 text-xs"><MonitorPlay className="h-3.5 w-3.5" /> مراقبة المعلم</TabsTrigger>
        </TabsList>

        <TabsContent value="student" className="mt-4">
          {loading ? (
            <div className="flex justify-center py-14"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
          ) : exams.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-slate-200 py-14 text-center text-sm text-slate-400">
              لا توجد امتحانات أونلاين منشورة بعد — أنشئ امتحانًا من بنك الأسئلة أو فعّل الوضع الأونلاين ثم انشر
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {exams.map((e) => (
                <StudentExamCard key={e.id} exam={e} onFinished={() => void loadExams()} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="teacher" className="mt-4">
          <TeacherMonitor exams={exams} onRefreshExams={() => void loadExams()} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- student: card + start dialog + runner ----------

function StudentExamCard({ exam, onFinished }: { exam: ExamListItem; onFinished: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<StartedAttempt | null>(null);

  const start = async () => {
    if (!name.trim()) {
      toast.error('اكتب اسمك');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId: exam.id, studentName: name.trim(), studentCode: code.trim() || null }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? 'تعذر بدء المحاولة');
        return;
      }
      toast.success(d.resumed ? 'استؤنفت محاولتك — نفس الوقت المتبقي' : 'بدأت المحاولة — بالتوفيق!');
      setAttempt({ ...d.attempt, serverNow: d.serverNow });
      setOpen(false);
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  if (attempt) {
    return (
      <div className="md:col-span-2">
        <ExamRunner attempt={attempt} onExit={() => { setAttempt(null); onFinished(); }} />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><GraduationCap className="h-5 w-5 text-emerald-600" /> {exam.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {exam.subject && <Badge variant="outline">{exam.subject}</Badge>}
          <Badge variant="outline">{exam.questionCount} سؤال</Badge>
          <Badge className="gap-1 bg-emerald-100 text-emerald-700"><Clock className="h-3 w-3" /> {exam.durationMin} دقيقة</Badge>
          <Badge variant="outline">{exam.attemptsAllowed} محاولة</Badge>
          {exam.securityPolicy === 'strict' && <Badge className="gap-1 bg-red-100 text-red-700"><ShieldAlert className="h-3 w-3" /> أمان صارم</Badge>}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">اسم الطالب</Label>
            <Input className="h-9 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الثلاثي" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">الرقم (اختياري)</Label>
            <Input className="h-9 text-sm" value={code} onChange={(e) => setCode(e.target.value)} placeholder="مثال: 12" />
          </div>
        </div>
        <Button className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => void start()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'بدء / استئناف المحاولة'}
        </Button>
        <p className="text-[11px] leading-relaxed text-slate-500">
          الوقت يُحسب على الخادم — التحديث أو إعادة الفتح لن يعيده. تُحفظ إجاباتك تلقائيًا كل ٥ ثوانٍ حتى مع انقطاع الشبكة.
          {exam.securityPolicy === 'strict' && ' سياسة صارمة: أي مغادرة للنافذة تُنهي المحاولة.'}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------- teacher monitor ----------

function TeacherMonitor({ exams, onRefreshExams }: { exams: ExamListItem[]; onRefreshExams: () => void }) {
  const [examId, setExamId] = useState<string>('none');
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [busy, setBusy] = useState(false);

  const loadAttempts = useCallback(async (id: string) => {
    if (!id || id === 'none') return;
    setBusy(true);
    try {
      const res = await fetch(`/api/attempts?examId=${encodeURIComponent(id)}`);
      const d = await res.json();
      setAttempts(Array.isArray(d.attempts) ? d.attempts : []);
    } catch {
      toast.error('تعذر تحميل المحاولات');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (examId !== 'none') void loadAttempts(examId);
  }, [examId, loadAttempts]);

  const selected = exams.find((e) => e.id === examId);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <MonitorPlay className="h-5 w-5 text-emerald-600" /> مراقبة المحاولات
          <div className="mr-auto flex items-center gap-2">
            <Select value={examId} onValueChange={setExamId}>
              <SelectTrigger className="h-8 w-64 text-xs"><SelectValue placeholder="اختر امتحانًا أونلاين" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none" disabled>اختر امتحانًا أونلاين</SelectItem>
                {exams.map((e) => <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" disabled={busy || examId === 'none'}
              onClick={() => { void loadAttempts(examId); onRefreshExams(); }}>
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> تحديث
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!selected ? (
          <div className="rounded-xl border-2 border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
            اختر امتحانًا لعرض محاولات الطلاب والدرجات والمخالفات
          </div>
        ) : attempts.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">لا محاولات بعد</div>
        ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto pl-1">
            {attempts.map((a) => {
              const st = STATUS_META[a.status] ?? STATUS_META.submitted;
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <span className="font-bold text-slate-800">{a.studentName}</span>
                  {a.studentCode && <span className="text-xs text-slate-400">({a.studentCode})</span>}
                  <Badge className={`text-[10px] ${st.cls}`}>{st.label}</Badge>
                  {a.score !== null && a.maxScore ? (
                    <Badge className="bg-emerald-600 text-xs">{a.score}/{a.maxScore}</Badge>
                  ) : a.status === 'invalidated' ? (
                    <Badge className="bg-red-100 text-xs text-red-700">بلا درجة</Badge>
                  ) : null}
                  {a.securityEvents > 0 && (
                    <Badge className="gap-1 bg-amber-100 text-[10px] text-amber-800"><ShieldAlert className="h-3 w-3" /> {a.securityEvents} مخالفة</Badge>
                  )}
                  <span className="mr-auto text-[11px] text-slate-400">
                    بدأت {new Date(a.startedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                    {a.submittedAt && ` • سلَّمت ${new Date(a.submittedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {selected && (
          <p className="mt-3 text-[11px] text-slate-500">
            المحاولات المنتهية زمنيًا تُغلق وتُصحَّح تلقائيًا عند أول قراءة. المخالفات مسجلة على الخادم بختم زمني.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
