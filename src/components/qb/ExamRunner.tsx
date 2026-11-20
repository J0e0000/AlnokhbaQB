'use client';

// ============================================================
// ALNOKHBA QB — Online Exam Runner (PHASE 3 + 4)
// Mobile-first student runner. The SERVER owns the clock: the UI
// only renders remaining time derived from expiresAt + serverNow
// drift correction. Autosave is resilient offline; expiry can never
// be extended from the client. Security events are logged remotely.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Loader2, Send, ShieldAlert, Timer, WifiOff } from 'lucide-react';

interface AttemptQuestion {
  number: number;
  id: string;
  type: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  marks: number;
}

export interface StartedAttempt {
  id: string;
  examId: string;
  examTitle: string;
  studentName: string;
  securityPolicy: 'warning' | 'strict' | string;
  startedAt: string;
  expiresAt: string;
  status: string;
  answers: Record<string, string>;
  questions: AttemptQuestion[];
  /** server clock snapshot at start — used to correct client drift */
  serverNow?: string;
}

interface SubmitResult {
  status: string;
  score: number | null;
  maxScore: number | null;
  percent?: number;
  correct?: number[];
  incorrect?: number[];
  unanswered?: number[];
  answers: Record<string, string>;
  review: Record<string, string>;
  questionCount: number;
}

type SyncState = 'idle' | 'saving' | 'saved' | 'offline';

export default function ExamRunner({ attempt, onExit }: { attempt: StartedAttempt; onExit: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>(attempt.answers ?? {});
  const [current, setCurrent] = useState(0);
  const [sync, setSync] = useState<SyncState>('idle');
  const [remainingSec, setRemainingSec] = useState(() =>
    Math.max(0, Math.floor((new Date(attempt.expiresAt).getTime() - Date.now()) / 1000))
  );
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [invalidated, setInvalidated] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);

  const dirtyRef = useRef<Record<string, string> | null>(null); // pending unsaved answers
  const answersRef = useRef(answers);
  answersRef.current = answers;
  // server clock offset: clientNow - serverNow (re-synced on every response)
  const offsetRef = useRef(
    attempt.serverNow ? Date.now() - new Date(attempt.serverNow).getTime() : 0
  );
  const expiresRef = useRef(new Date(attempt.expiresAt).getTime());
  const lastWarnRef = useRef<Record<string, number>>({});
  const closedRef = useRef(false);

  const question = attempt.questions[current];
  const answeredCount = useMemo(() => Object.values(answers).filter(Boolean).length, [answers]);

  // ---------- timer (client renders, server decides) ----------
  useEffect(() => {
    const t = setInterval(() => {
      const serverNow = Date.now() - offsetRef.current;
      setRemainingSec(Math.max(0, Math.floor((expiresRef.current - serverNow) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const flush = useCallback(async (): Promise<boolean> => {
    const pending = dirtyRef.current;
    if (!pending || closedRef.current) return true;
    try {
      setSync('saving');
      const res = await fetch(`/api/attempts/${attempt.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: pending, serverNow: undefined }),
      });
      const d = await res.json();
      // re-sync the clock drift on every server response
      if (d?.serverNow) offsetRef.current = Date.now() - new Date(d.serverNow as string).getTime();
      if (res.status === 409 && (d.finalized || d.invalidated)) {
        closedRef.current = true;
        if (d.invalidated) setInvalidated(d.error ?? 'أُلغيت المحاولة');
        else if (d.grade) {
          setResult({ status: 'expired', score: d.grade.score, maxScore: d.grade.maxScore, percent: d.grade.percent, correct: d.grade.correct, incorrect: d.grade.incorrect, unanswered: d.grade.unanswered, answers: answersRef.current, review: d.grade.review, questionCount: attempt.questions.length });
        } else {
          try {
            const g = await fetch(`/api/attempts/${attempt.id}/submit`, { method: 'POST' });
            const gd = await g.json();
            if (g.ok) setResult({ status: gd.status, score: gd.score, maxScore: gd.maxScore, answers: gd.answers ?? {}, review: gd.review ?? {}, questionCount: gd.questionCount ?? attempt.questions.length });
          } catch { /* result screen shows closed state */ }
        }
        dirtyRef.current = null;
        return true;
      }
      if (!res.ok) {
        setSync('offline');
        return false;
      }
      dirtyRef.current = null;
      setSync('saved');
      return true;
    } catch {
      setSync('offline');
      return false;
    }
  }, [attempt.id, attempt.questions.length]);

  // ---------- autosave loop ----------
  useEffect(() => {
    const t = setInterval(() => void flush(), 5000);
    return () => clearInterval(t);
  }, [flush]);

  // online → flush immediately
  useEffect(() => {
    const onOnline = () => void flush();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flush]);

  // ---------- auto-submit at zero (server enforces authoritatively anyway) ----------
  useEffect(() => {
    if (remainingSec <= 0 && !result && !invalidated && !closedRef.current) {
      closedRef.current = true;
      void (async () => {
        await flush();
        await doSubmit(true);
      })();
    }
  }, [remainingSec]);

  // ---------- security listeners (PHASE 4) ----------
  useEffect(() => {
    if (result || invalidated) return;
    const report = async (type: string, message: string) => {
      if (closedRef.current) return;
      if (attempt.securityPolicy === 'warning') {
        const now = Date.now();
        if (now - (lastWarnRef.current[type] ?? 0) < 30_000) return;
        lastWarnRef.current[type] = now;
        toast.warning(message);
      }
      try {
        const res = await fetch(`/api/attempts/${attempt.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ securityEvent: type }),
        });
        const d = await res.json();
        if (d?.serverNow) offsetRef.current = Date.now() - new Date(d.serverNow as string).getTime();
        if (res.status === 409 && d.invalidated) {
          closedRef.current = true;
          setInvalidated(d.error ?? 'أُلغيت المحاولة');
        }
      } catch {
        /* offline — event is re-reportable by design; nothing extends the timer */
      }
    };
    const onVis = () => { if (document.hidden) void report('tab_hidden', 'تم رصد مغادرة تبويب الامتحان'); };
    const onBlur = () => void report('window_blur', 'فقد التركيز على نافذة الامتحان');
    const onFsChange = () => { if (!document.fullscreenElement) void report('fullscreen_exit', 'تم الخروج من وضع ملء الشاشة'); };
    const onPageHide = () => void report('page_leave', 'تم مغادرة صفحة الامتحان');
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [attempt.id, attempt.securityPolicy, result, invalidated]);

  const pick = (optionId: string) => {
    if (!question || closedRef.current) return;
    const next = { ...answersRef.current, [String(question.number)]: optionId };
    setAnswers(next);
    dirtyRef.current = { ...(dirtyRef.current ?? {}), [String(question.number)]: optionId };
    setSync('idle');
  };

  const doSubmit = async (auto = false) => {
    if (submitBusy) return;
    setSubmitBusy(true);
    try {
      if (!auto) await flush();
      const res = await fetch(`/api/attempts/${attempt.id}/submit`, { method: 'POST' });
      const d = (await res.json()) as SubmitResult & { error?: string };
      if (!res.ok) {
        if (res.status === 409 && d.status === 'invalidated') setInvalidated(d.error ?? 'أُلغيت المحاولة');
        else toast.error(d.error ?? 'فشل التسليم');
        return;
      }
      closedRef.current = true;
      setResult(d);
      toast.success(auto ? 'انتهى الوقت — تم التسليم تلقائيًا' : 'تم تسليم إجاباتك');
    } catch {
      toast.error('تعذر الاتصال — سيُسلَّم تلقائيًا عند انتهاء الوقت');
    } finally {
      setSubmitBusy(false);
    }
  };

  // ---------- closed states ----------
  if (invalidated) {
    return (
      <ClosedScreen icon={<ShieldAlert className="h-12 w-12 text-red-500" />} title="تم إنهاء المحاولة"
        body={invalidated} note="أُرسلت آخر إجابات متزامنة إلى المعلم. تواصل مع المعلم إذا كان لديك اعتراض." onExit={onExit} />
    );
  }
  if (result) {
    return <ResultScreen result={result} attempt={attempt} onExit={onExit} />;
  }

  const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
  const ss = String(remainingSec % 60).padStart(2, '0');
  const lowTime = remainingSec <= 120;

  return (
    <div className="mx-auto max-w-3xl space-y-3" dir="rtl">
      {/* sticky status bar */}
      <div className="sticky top-16 z-30 rounded-xl border bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{attempt.examTitle}</div>
            <div className="text-[11px] text-slate-500">{attempt.studentName} • {answeredCount}/{attempt.questions.length} مجاب</div>
          </div>
          <div className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-lg font-black tabular-nums ${lowTime ? 'animate-pulse bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
            <Timer className="h-4 w-4" /> {mm}:{ss}
          </div>
        </div>
        <Progress className="mt-2 h-1.5" value={(answeredCount / Math.max(1, attempt.questions.length)) * 100} />
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
          <span className="flex items-center gap-1">
            {sync === 'offline' ? (<><WifiOff className="h-3 w-3 text-red-500" /> غير متصل — سيُحفظ تلقائيًا عند العودة</>)
              : sync === 'saving' ? 'جارٍ الحفظ…'
              : sync === 'saved' ? 'محفوظ ✓'
              : 'الحفظ التلقائي مفعّل'}
          </span>
          <span>المحاولة مُقيَّدة على الخادم — لا يمكن تمديد الوقت</span>
        </div>
      </div>

      {/* question card */}
      {question && (
        <div className="rounded-xl border bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <Badge className="bg-emerald-600">سؤال {question.number} من {attempt.questions.length}</Badge>
            <Badge variant="outline">{question.marks} درجة</Badge>
          </div>
          <p className="mb-4 whitespace-pre-wrap text-base font-medium leading-relaxed">{question.prompt}</p>
          <div className="space-y-2">
            {question.options.map((o) => {
              const active = answers[String(question.number)] === o.id;
              return (
                <button key={o.id} onClick={() => pick(o.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-right text-sm transition ${active ? 'border-emerald-500 bg-emerald-50' : 'hover:border-emerald-300 hover:bg-slate-50'}`}>
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${active ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{o.id}</span>
                  <span className="flex-1">{o.text || '—'}</span>
                  {active && <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* navigation */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" disabled={current === 0} onClick={() => setCurrent((c) => c - 1)}>
          <ChevronRight className="h-4 w-4" /> السابق
        </Button>
        <div className="flex max-w-[55%] flex-wrap justify-center gap-1">
          {attempt.questions.map((q, i) => (
            <button key={q.id} onClick={() => setCurrent(i)}
              className={`h-7 w-7 rounded-lg text-[11px] font-bold transition ${i === current ? 'bg-emerald-600 text-white' : answers[String(q.number)] ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
              {q.number}
            </button>
          ))}
        </div>
        {current < attempt.questions.length - 1 ? (
          <Button variant="outline" size="sm" onClick={() => setCurrent((c) => c + 1)}>
            التالي <ChevronLeft className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setConfirmOpen(true)}>
            <Send className="h-4 w-4" /> تسليم
          </Button>
        )}
      </div>

      <Button variant="outline" size="sm" className="w-full" onClick={() => setConfirmOpen(true)}>
        تسليم الامتحان الآن
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader><DialogTitle className="text-right">تأكيد التسليم</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-600">
            أجبت على {answeredCount} من {attempt.questions.length} سؤال.
            {answeredCount < attempt.questions.length && ' الأسئلة غير المجابة ستُحسب فارغة.'}
            بعد التسليم لا يمكن التعديل.
          </p>
          <div className="flex gap-2">
            <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700" disabled={submitBusy} onClick={() => { setConfirmOpen(false); void doSubmit(false); }}>
              {submitBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'تسليم نهائي'}
            </Button>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>متابعة الحل</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- result screen ----------

function ResultScreen({ result, attempt, onExit }: { result: SubmitResult; attempt: StartedAttempt; onExit: () => void }) {
  const percent = result.percent ?? (result.maxScore ? Math.round(((result.score ?? 0) / result.maxScore) * 1000) / 10 : 0);
  return (
    <div className="mx-auto max-w-2xl space-y-4" dir="rtl">
      <div className="rounded-2xl border bg-white p-6 text-center">
        {result.status === 'expired' ? (
          <div className="mb-2 flex items-center justify-center gap-1.5 text-sm text-amber-700"><AlertTriangle className="h-4 w-4" /> انتهى الوقت — تم التسليم تلقائيًا</div>
        ) : (
          <div className="mb-2 flex items-center justify-center gap-1.5 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" /> تم تسليم الامتحان بنجاح</div>
        )}
        {result.score !== null && result.score !== undefined ? (
          <>
            <div className="text-5xl font-black text-emerald-600">{result.score}</div>
            <div className="mt-1 text-sm text-slate-500">من {result.maxScore} ({percent}%)</div>
            <Progress className="mx-auto mt-3 h-2 max-w-xs" value={percent} />
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">صحيحة: {result.correct?.length ?? 0}</div>
              <div className="rounded-lg bg-red-50 p-2 text-red-600">خاطئة: {result.incorrect?.length ?? 0}</div>
              <div className="rounded-lg bg-slate-50 p-2 text-slate-600">فارغة: {result.unanswered?.length ?? 0}</div>
            </div>
          </>
        ) : (
          <div className="text-sm text-slate-500">أُرسلت إجاباتك — تظهر الدرجة بعد اعتماد المعلم.</div>
        )}
      </div>

      {result.review && Object.keys(result.review).length > 0 && (
        <div className="rounded-2xl border bg-white p-4">
          <div className="mb-2 text-sm font-bold">مراجعة الإجابات</div>
          <div className="max-h-96 space-y-2 overflow-y-auto pl-1">
            {attempt.questions.map((q) => {
              const mine = result.answers[String(q.number)];
              const key = result.review[String(q.number)];
              const state = !mine ? 'empty' : mine === key ? 'correct' : 'wrong';
              return (
                <div key={q.id} className="rounded-lg border p-3">
                  <div className="flex items-start gap-2">
                    {state === 'correct' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      : state === 'wrong' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                      : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{q.number}. {q.prompt}</div>
                      <div className="mt-1 space-y-0.5 text-xs text-slate-500">
                        <div>إجابتك: <b className={state === 'wrong' ? 'text-red-600' : state === 'correct' ? 'text-emerald-700' : 'text-slate-400'}>
                          {mine ? q.options.find((o) => o.id === mine)?.text || mine : 'بلا إجابة'}</b></div>
                        <div>الصحيحة: <b className="text-emerald-700">{q.options.find((o) => o.id === key)?.text ?? key}</b></div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Button variant="outline" className="w-full" onClick={onExit}>رجوع</Button>
    </div>
  );
}

function ClosedScreen({ icon, title, body, note, onExit }: { icon: React.ReactNode; title: string; body: string; note: string; onExit: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border bg-white p-8 text-center" dir="rtl">
      <div className="mb-3 flex justify-center">{icon}</div>
      <div className="mb-1 text-lg font-bold">{title}</div>
      <p className="mb-2 text-sm text-slate-600">{body}</p>
      <p className="mb-4 text-xs text-slate-400">{note}</p>
      <Button variant="outline" onClick={onExit}>رجوع</Button>
    </div>
  );
}
