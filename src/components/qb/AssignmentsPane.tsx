'use client';

// ============================================================
// ALNOKHBA QB — Assignments pane (PHASE 5)
// Student tab: file upload OR graded exam (reuses ExamRunner +
// the server-authoritative attempt engine). Teacher tab: create,
// monitor submissions, grade (score/feedback), open/close, delete.
// Deadlines are enforced SERVER-SIDE; clocks here are display-only.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import ExamRunner, { type StartedAttempt } from '@/components/qb/ExamRunner';
import {
  AlarmClock, ClipboardList, FileUp, GraduationCap, Loader2, NotebookPen,
  Paperclip, RefreshCw, Trash2, UserRound, X,
} from 'lucide-react';

// ---------- types ----------

interface AssignmentRow {
  id: string;
  title: string;
  description: string;
  mode: string; // graded | file
  examId: string | null;
  examTitle: string | null;
  dueAt: string;
  latePolicy: string; // allow | block
  status: string; // open | closed
  submissionCount: number;
  createdAt: string;
}

interface SubmissionRow {
  id: string;
  studentName: string;
  studentCode: string | null;
  attemptId: string | null;
  hasFile: boolean;
  fileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  score: number | null;
  maxScore: number | null;
  feedback: string | null;
  late: boolean;
  status: string; // submitted | graded | expired
  submittedAt: string;
}

interface ExamListItem {
  id: string;
  title: string;
  status: string;
  onlineEnabled: boolean;
}

const SUB_META: Record<string, { label: string; cls: string }> = {
  submitted: { label: 'مُسلَّم', cls: 'bg-slate-100 text-slate-600' },
  graded: { label: 'مُصحَّح', cls: 'bg-emerald-100 text-emerald-700' },
  expired: { label: 'انتهى بدونه', cls: 'bg-amber-100 text-amber-800' },
};

const UPLOAD_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.zip';
const MAX_UPLOAD_MB = 10;

function fmtBytes(n: number | null): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ك.ب`;
  return `${(n / 1024 / 1024).toFixed(1)} م.ب`;
}

function fmtDue(iso: string, serverSkew: number): string {
  const remaining = new Date(iso).getTime() - (Date.now() + serverSkew);
  if (remaining <= 0) return 'انتهى الموعد';
  const h = Math.floor(remaining / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  if (h >= 24) return `متبقٍ ${Math.floor(h / 24)} يوم`;
  if (h >= 1) return `متبقٍ ${h} س ${m} د`;
  return `متبقٍ ${Math.max(1, m)} دقيقة`;
}

async function downloadSubmissionFile(assignmentId: string, submissionId: string, name: string) {
  try {
    const res = await fetch(`/api/assignments/${assignmentId}/submissions/${submissionId}/file`);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      toast.error(d?.error ?? 'تعذر تنزيل الملف');
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'submission';
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success('تم تنزيل الملف ✓');
  } catch {
    toast.error('تعذر الاتصال بالخادم');
  }
}

// ============================================================
// Root pane
// ============================================================

export default function AssignmentsPane() {
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [serverSkew, setServerSkew] = useState(0); // serverNow - clientNow
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/assignments');
      const d = await res.json();
      setAssignments(Array.isArray(d.assignments) ? d.assignments : []);
      if (d.serverNow) setServerSkew(new Date(d.serverNow).getTime() - Date.now());
    } catch {
      toast.error('تعذر تحميل الواجبات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4" dir="rtl">
      <Tabs defaultValue="student">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="student" className="gap-1.5 text-xs"><UserRound className="h-3.5 w-3.5" /> وضع الطالب</TabsTrigger>
          <TabsTrigger value="teacher" className="gap-1.5 text-xs"><NotebookPen className="h-3.5 w-3.5" /> لوحة المعلم</TabsTrigger>
        </TabsList>

        <TabsContent value="student" className="mt-4">
          {loading ? (
            <div className="flex justify-center py-14"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
          ) : assignments.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-slate-200 py-14 text-center text-sm text-slate-400">
              لا توجد واجبات بعد — أنشئ واجبًا من لوحة المعلم
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {assignments.map((a) => (
                <StudentAssignmentCard key={a.id} assignment={a} serverSkew={serverSkew} onFinished={() => void load()} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="teacher" className="mt-4">
          <TeacherTab assignments={assignments} loading={loading} onReload={() => void load()} serverSkew={serverSkew} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// Student side
// ============================================================

function StudentAssignmentCard({
  assignment, serverSkew, onFinished,
}: { assignment: AssignmentRow; serverSkew: number; onFinished: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<StartedAttempt | null>(null);
  const [mySub, setMySub] = useState<SubmissionRow | null>(null);

  const overdue = new Date(assignment.dueAt).getTime() <= Date.now() + serverSkew;
  const closed = assignment.status !== 'open';
  const canSubmit = !closed && (!overdue || assignment.latePolicy === 'allow');

  const startGraded = async () => {
    if (!name.trim() || !assignment.examId) {
      toast.error('اكتب اسمك');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          examId: assignment.examId,
          studentName: name.trim(),
          studentCode: code.trim() || null,
          assignmentId: assignment.id,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? 'تعذر بدء المحاولة');
        return;
      }
      toast.success(d.resumed ? 'استؤنفت محاولتك — نفس الوقت المتبقي' : 'بدأت المحاولة — بالتوفيق!');
      setAttempt({ ...d.attempt, serverNow: d.serverNow });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  const submitFile = async () => {
    if (!name.trim()) {
      toast.error('اكتب اسمك');
      return;
    }
    if (!file) {
      toast.error('اختر الملف أولًا');
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast.error(`الحد الأقصى ${MAX_UPLOAD_MB} ميجابايت`);
      return;
    }
    setBusy(true);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(new Error('read'));
        r.readAsDataURL(file);
      });
      const res = await fetch(`/api/assignments/${assignment.id}/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: name.trim(),
          studentCode: code.trim() || null,
          fileBase64: b64,
          fileName: file.name,
          fileType: file.type || null,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? 'فشل التسليم');
        return;
      }
      toast.success(d.late ? 'تم التسليم (متأخر — سجل عند المعلم)' : 'تم تسليم الواجب ✓');
      setFile(null);
      setMySub({
        id: d.submission.id, studentName: name.trim(), studentCode: code.trim() || null,
        attemptId: null, hasFile: true, fileName: d.submission.fileName, fileType: null,
        fileSize: d.submission.fileSize, score: null, maxScore: null, feedback: null,
        late: d.late, status: 'submitted', submittedAt: d.submission.submittedAt,
      });
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
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {assignment.mode === 'graded'
            ? <GraduationCap className="h-5 w-5 text-emerald-600" />
            : <FileUp className="h-5 w-5 text-emerald-600" />}
          {assignment.title}
          {assignment.status !== 'open' && <Badge className="bg-red-100 text-red-700">مغلق</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {assignment.description && (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{assignment.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="outline">{assignment.mode === 'graded' ? 'امتحان إلكتروني' : 'رفع ملف'}</Badge>
          {assignment.mode === 'graded'
            ? assignment.examTitle && <Badge variant="outline">{assignment.examTitle}</Badge>
            : null}
          <Badge className={`gap-1 ${overdue ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
            <AlarmClock className="h-3 w-3" /> {fmtDue(assignment.dueAt, serverSkew)}
          </Badge>
          <Badge variant="outline">
            {assignment.latePolicy === 'allow' ? 'يسمح بالتأجيل' : 'لا تسليم بعد الموعد'}
          </Badge>
          {mySub?.late && <Badge className="bg-amber-100 text-amber-800">تسليمك متأخر</Badge>}
        </div>

        {closed ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">أُغلق هذا الواجب — لا يقبل تسليمات جديدة.</p>
        ) : assignment.mode === 'graded' ? (
          <>
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
            {overdue ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">انتهى الموعد — يُسمح بالتسليم المتأخر وسيُسجل كمتأخر.</p>
            ) : null}
            <Button className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => void startGraded()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'بدء / استئناف الحل'}
            </Button>
          </>
        ) : (
          <>
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
            <div className="space-y-1">
              <Label className="text-xs">ملف الواجب (حتى {MAX_UPLOAD_MB} م.ب)</Label>
              <Input
                className="h-9 cursor-pointer text-sm file:mr-2 file:rounded-md file:border-0 file:bg-emerald-50 file:px-2 file:text-xs file:font-medium file:text-emerald-700"
                type="file"
                accept={UPLOAD_ACCEPT}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            {!canSubmit ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-700">انتهى الموعد ولا يُسمح بالتسليم المتأخر.</p>
            ) : (
              <Button className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => void submitFile()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Paperclip className="h-4 w-4" /> تسليم الواجب</>}
              </Button>
            )}
            {mySub && (
              <p className="text-[11px] text-emerald-700">
                آخر تسليم: {mySub.fileName} ({fmtBytes(mySub.fileSize)}) — يمكن إعادة التسليم لاستبداله.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Teacher side
// ============================================================

function TeacherTab({
  assignments, loading, onReload, serverSkew,
}: { assignments: AssignmentRow[]; loading: boolean; onReload: () => void; serverSkew: number }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" className="gap-1.5 bg-emerald-600 text-xs hover:bg-emerald-700" onClick={() => setCreateOpen(true)}>
          <ClipboardList className="h-4 w-4" /> واجب جديد
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={onReload}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> تحديث
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-14"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
      ) : assignments.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-slate-200 py-14 text-center text-sm text-slate-400">
          لا واجبات بعد — أنشئ أول واجب (رفع ملف أو امتحان مصحح آليًا)
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {assignments.map((a) => {
            const overdue = new Date(a.dueAt).getTime() <= Date.now() + serverSkew;
            return (
              <Card key={a.id} className="cursor-pointer transition hover:border-emerald-300" onClick={() => setDetailId(a.id)}>
                <CardHeader className="pb-1.5">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    {a.mode === 'graded' ? <GraduationCap className="h-4 w-4 text-emerald-600" /> : <FileUp className="h-4 w-4 text-emerald-600" />}
                    {a.title}
                    {a.status !== 'open' && <Badge className="bg-red-100 text-red-700">مغلق</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="outline">{a.mode === 'graded' ? 'امتحان إلكتروني' : 'رفع ملف'}</Badge>
                  <Badge className={`gap-1 ${overdue ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
                    <AlarmClock className="h-3 w-3" /> {new Date(a.dueAt).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}
                  </Badge>
                  <Badge variant="outline">{a.submissionCount} تسليم</Badge>
                  {a.examTitle && <span className="text-[10px] text-slate-400">{a.examTitle}</span>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CreateAssignmentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onReload} />
      {detailId && (
        <AssignmentDetailDialog assignmentId={detailId} onClose={() => setDetailId(null)} onChanged={onReload} />
      )}
    </div>
  );
}

// ---------- create dialog ----------

function CreateAssignmentDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'file' | 'graded'>('file');
  const [examId, setExamId] = useState('none');
  const [dueAt, setDueAt] = useState('');
  const [latePolicy, setLatePolicy] = useState<'allow' | 'block'>('allow');
  const [exams, setExams] = useState<ExamListItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || mode !== 'graded') return;
    void (async () => {
      try {
        const res = await fetch('/api/exams');
        const d = await res.json();
        const list = (Array.isArray(d) ? d : d.exams ?? []) as ExamListItem[];
        setExams(list.filter((e) => e.onlineEnabled && e.status === 'PUBLISHED'));
      } catch {
        toast.error('تعذر تحميل الامتحانات');
      }
    })();
  }, [open, mode]);

  const create = async () => {
    if (!title.trim()) {
      toast.error('اكتب عنوان الواجب');
      return;
    }
    if (!dueAt) {
      toast.error('حدد موعد التسليم');
      return;
    }
    const dueIso = new Date(dueAt).toISOString(); // datetime-local → instant
    if (!Number.isFinite(new Date(dueIso).getTime())) {
      toast.error('موعد التسليم غير صالح');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          mode,
          examId: mode === 'graded' && examId !== 'none' ? examId : null,
          dueAt: dueIso,
          latePolicy,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? 'فشل إنشاء الواجب');
        return;
      }
      toast.success('تم إنشاء الواجب ✓');
      onOpenChange(false);
      setTitle(''); setDescription(''); setMode('file'); setExamId('none'); setDueAt(''); setLatePolicy('allow');
      onCreated();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base"><ClipboardList className="h-5 w-5 text-emerald-600" /> واجب جديد</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">العنوان *</Label>
            <Input className="h-9 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: واجب الوحدة الثالثة" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">تعليمات (اختياري)</Label>
            <Textarea className="min-h-16 text-sm" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ما يجب أن يفعله الطالب…" />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">نوع التسليم</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as 'file' | 'graded')}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="file">رفع ملف — يصححه المعلم</SelectItem>
                  <SelectItem value="graded">امتحان إلكتروني — تصحيح آلي</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">موعد التسليم *</Label>
              <Input className="h-9 text-sm" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
          </div>
          {mode === 'graded' && (
            <div className="space-y-1">
              <Label className="text-xs">الامتحان (منشور + مفعّل أونلاين) *</Label>
              <Select value={examId} onValueChange={setExamId}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="اختر امتحانًا" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" disabled>اختر امتحانًا</SelectItem>
                  {exams.map((e) => <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">سياسة التأجيل</Label>
            <Select value={latePolicy} onValueChange={(v) => setLatePolicy(v as 'allow' | 'block')}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">يسمح بالتسليم المتأخر (يُسجل كمتأخر)</SelectItem>
                <SelectItem value="block">يرفض التسليم بعد الموعد</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => void create()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'إنشاء الواجب'}
          </Button>
          <p className="text-[11px] text-slate-500">الموعد يُحفظ على الخادم ويُطبَّق بساعة الخادم — ساعة الجهاز لا تغيّره.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- detail dialog (submissions + grading) ----------

function AssignmentDetailDialog({
  assignmentId, onClose, onChanged,
}: { assignmentId: string; onClose: () => void; onChanged: () => void }) {
  const [assignment, setAssignment] = useState<AssignmentRow | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/assignments/${assignmentId}`);
      if (!res.ok) {
        toast.error('الواجب غير موجود');
        onClose();
        return;
      }
      const d = await res.json();
      setAssignment(d.assignment);
      setSubmissions(Array.isArray(d.submissions) ? d.submissions : []);
    } catch {
      toast.error('تعذر تحميل الواجب');
    } finally {
      setLoading(false);
    }
  }, [assignmentId, onClose]);

  useEffect(() => {
    void load();
  }, [load]);

  const setAssignmentStatus = async (status: 'open' | 'closed') => {
    try {
      const res = await fetch(`/api/assignments/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        toast.error(d?.error ?? 'فشل التحديث');
        return;
      }
      toast.success(status === 'open' ? 'أُعيد فتح الواجب' : 'أُغلق الواجب — لن يُقبل تسليم جديد');
      void load();
      onChanged();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  const remove = async () => {
    try {
      const res = await fetch(`/api/assignments/${assignmentId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('فشل الحذف');
        return;
      }
      toast.success('حُذف الواجب وكل تسليماته');
      onChanged();
      onClose();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            <ClipboardList className="h-5 w-5 text-emerald-600" />
            {assignment?.title ?? '…'}
            {assignment?.status === 'open'
              ? <Badge className="bg-emerald-100 text-emerald-700">مفتوح</Badge>
              : <Badge className="bg-red-100 text-red-700">مغلق</Badge>}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
        ) : assignment ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant="outline">{assignment.mode === 'graded' ? 'امتحان إلكتروني' : 'رفع ملف'}</Badge>
              <Badge variant="outline">
                <AlarmClock className="ml-1 h-3 w-3" />
                {new Date(assignment.dueAt).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })}
              </Badge>
              <Badge variant="outline">{assignment.latePolicy === 'allow' ? 'يسمح بالتأجيل' : 'لا تسليم بعد الموعد'}</Badge>
              {assignment.examTitle && <Badge variant="outline">{assignment.examTitle}</Badge>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {assignment.status === 'open' ? (
                <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => void setAssignmentStatus('closed')}>
                  <X className="h-3.5 w-3.5" /> إغلاق الواجب
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => void setAssignmentStatus('open')}>
                  <RefreshCw className="h-3.5 w-3.5" /> إعادة الفتح
                </Button>
              )}
              {confirmDelete ? (
                <>
                  <Button size="sm" variant="destructive" className="gap-1.5 text-xs" onClick={() => void remove()}>
                    <Trash2 className="h-3.5 w-3.5" /> تأكيد الحذف النهائي
                  </Button>
                  <Button size="sm" variant="ghost" className="text-xs" onClick={() => setConfirmDelete(false)}>إلغاء</Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" className="gap-1.5 text-xs text-red-600 hover:text-red-700" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-3.5 w-3.5" /> حذف الواجب
                </Button>
              )}
            </div>

            <div>
              <div className="mb-2 text-xs font-bold text-slate-600">التسليمات ({submissions.length})</div>
              {submissions.length === 0 ? (
                <div className="rounded-xl border-2 border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">لا تسليمات بعد</div>
              ) : (
                <div className="max-h-96 space-y-2 overflow-y-auto pl-1">
                  {submissions.map((s) => (
                    <SubmissionRowItem key={s.id} assignmentId={assignmentId} submission={s} onGraded={() => void load()} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------- one submission row (grade editor inline) ----------

function SubmissionRowItem({
  assignmentId, submission, onGraded,
}: { assignmentId: string; submission: SubmissionRow; onGraded: () => void }) {
  const [score, setScore] = useState(submission.score !== null ? String(submission.score) : '');
  const [feedback, setFeedback] = useState(submission.feedback ?? '');
  const [busy, setBusy] = useState(false);
  const meta = SUB_META[submission.status] ?? SUB_META.submitted;

  const grade = async () => {
    const parsed = score.trim() === '' ? null : Number(score);
    if (score.trim() !== '' && (!Number.isFinite(parsed) || (parsed as number) < 0)) {
      toast.error('أدخل درجة صالحة');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/submissions/${submission.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: parsed, feedback: feedback.trim() || null }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? 'فشل حفظ الدرجة');
        return;
      }
      toast.success('حُفظت الدرجة ✓');
      onGraded();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-slate-800">{submission.studentName}</span>
        {submission.studentCode && <span className="text-xs text-slate-400">({submission.studentCode})</span>}
        <Badge className={`text-[10px] ${meta.cls}`}>{meta.label}</Badge>
        {submission.late && <Badge className="bg-amber-100 text-[10px] text-amber-800">متأخر</Badge>}
        {submission.score !== null && (
          <Badge className="bg-emerald-600 text-xs">
            {submission.score}{submission.maxScore ? `/${submission.maxScore}` : ''}
          </Badge>
        )}
        {submission.hasFile && (
          <button
            type="button"
            className="mr-auto flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-200"
            onClick={() => void downloadSubmissionFile(assignmentId, submission.id, submission.fileName ?? 'submission')}
          >
            <Paperclip className="h-3 w-3" /> {submission.fileName} ({fmtBytes(submission.fileSize)})
          </button>
        )}
        <span className={`text-[10px] text-slate-400 ${submission.hasFile ? '' : 'mr-auto'}`}>
          {new Date(submission.submittedAt).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}
        </span>
      </div>
      {submission.status !== 'expired' && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="w-20 space-y-0.5">
            <Label className="text-[10px] text-slate-500">الدرجة</Label>
            <Input className="h-8 text-sm" type="number" min={0} step="0.5" value={score} onChange={(e) => setScore(e.target.value)} />
          </div>
          <div className="min-w-40 flex-1 space-y-0.5">
            <Label className="text-[10px] text-slate-500">ملاحظات</Label>
            <Input className="h-8 text-sm" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="ملاحظة للطالب…" />
          </div>
          <Button size="sm" className="h-8 gap-1 bg-emerald-600 text-xs hover:bg-emerald-700" disabled={busy} onClick={() => void grade()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'حفظ'}
          </Button>
        </div>
      )}
    </div>
  );
}
