'use client';

// ============================================================
// النخبة QB — امتحاناتي (/exams)
// "كمّل من حيث توقفت" banner + exam table (not a card grid).
// Same API calls the old dashboard used: /api/exams, publish, delete.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { RegistrationMark } from '@/components/shell/Wordmark';
import { t } from '@/lib/ui/strings';
import { Archive, FileDown, Files, MoreHorizontal, PencilRuler, Plus, Eye } from 'lucide-react';

interface ExamRow {
  id: string;
  title: string;
  subject: string | null;
  status: string;
  questionCount: number;
  omrEnabled: boolean;
  currentVersion: number;
  updatedAt: string;
}

function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'PUBLISHED') return <Badge className="border-0 bg-success/10 text-success">{t('statusPublished')}</Badge>;
  if (status === 'ARCHIVED') return <Badge className="border-0 bg-muted text-muted-foreground">{t('statusArchived')}</Badge>;
  return <Badge className="border-0 bg-warning/10 text-warning">{t('statusDraft')}</Badge>;
}

export default function ExamsList() {
  const router = useRouter();
  const [exams, setExams] = useState<ExamRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [direction, setDirection] = useState<'rtl' | 'ltr'>('rtl');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/exams');
      const data = await res.json();
      setExams(Array.isArray(data) ? data : data.exams ?? []);
    } catch {
      toast.error('تعذر تحميل الامتحانات — تحقق من الاتصال ثم أعد المحاولة');
      setExams([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => {
    const list = [...(exams ?? [])].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (statusFilter !== 'all') return list.filter((e) => e.status === statusFilter);
    return list;
  }, [exams, statusFilter]);

  const lastEdited = useMemo(() => {
    const list = (exams ?? []).filter((e) => e.status !== 'ARCHIVED');
    return list.length > 0
      ? [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
      : null;
  }, [exams]);

  const create = async () => {
    if (!title.trim()) {
      setTitleError('اكتب عنوان الامتحان');
      return;
    }
    setTitleError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/exams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, subject, direction }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success('تم إنشاء الامتحان');
        setCreateOpen(false);
        setTitle('');
        setSubject('');
        router.push(`/exams/${data.exam?.id ?? data.id}/design`);
      } else {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(d?.error ?? 'فشل الإنشاء — أعد المحاولة');
      }
    } finally {
      setBusy(false);
    }
  };

  const publish = async (id: string) => {
    const res = await fetch(`/api/exams/${id}/publish`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      toast.success(`تم النشر — النسخة ${data.version} محفوظة`);
      void load();
    } else {
      toast.error(data.error ?? 'فشل النشر');
    }
  };

  const archive = async (id: string) => {
    const res = await fetch(`/api/exams/${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.success('تمت الأرشفة — سجلات الامتحان محفوظة');
      void load();
    } else {
      toast.error('تعذر الأرشفة — أعد المحاولة');
    }
  };

  if (exams === null) {
    return <div className="p-6 text-[15px] text-muted-foreground">جارٍ التحميل…</div>;
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6" dir="rtl">
      {lastEdited && (
        <Card className="border-paper bg-paper">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-3">
              <RegistrationMark className="h-7 w-7 text-primary" />
              <div>
                <div className="text-[13px] text-muted-foreground">كمّل من حيث توقفت</div>
                <div className="font-print text-lg font-bold leading-tight">{lastEdited.title}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
                <Link href={`/exams/${lastEdited.id}/design`}>
                  <PencilRuler className="me-1 h-4 w-4" /> أكمل التصميم
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-bold">{t('navExams')}</h1>
          <span className="tabular-nums text-[13px] text-muted-foreground">
            {(exams ?? []).length} امتحان
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger aria-label="تصفية بالحالة" className="h-10 w-36 bg-paper">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الحالات</SelectItem>
              <SelectItem value="DRAFT">{t('statusDraft')}</SelectItem>
              <SelectItem value="PUBLISHED">{t('statusPublished')}</SelectItem>
              <SelectItem value="ARCHIVED">{t('statusArchived')}</SelectItem>
            </SelectContent>
          </Select>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="h-10 bg-primary text-primary-foreground hover:bg-primary/90">
                <Plus className="me-1 h-4 w-4" /> {t('createExam')}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md rounded-xl" dir="rtl">
              <DialogHeader>
                <DialogTitle className="text-start">إنشاء امتحان</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="exam-title">عنوان الامتحان</Label>
                  <Input
                    id="exam-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    aria-invalid={Boolean(titleError)}
                    aria-describedby={titleError ? 'exam-title-error' : undefined}
                  />
                  {titleError && (
                    <p id="exam-title-error" className="text-[13px] text-destructive">{titleError}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="exam-subject">المادة</Label>
                  <Input id="exam-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="exam-direction">اتجاه الورقة</Label>
                  <Select value={direction} onValueChange={(v) => setDirection(v as 'rtl' | 'ltr')}>
                    <SelectTrigger id="exam-direction"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rtl">عربي (يمين ← يسار)</SelectItem>
                      <SelectItem value="ltr">English (left → right)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={() => void create()}>
                  إنشاء والانتقال للتصميم
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {exams.length === 0 ? (
        <Card className="border-paper bg-paper">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <RegistrationMark className="h-9 w-9 text-border" />
            <p className="max-w-md text-[15px] text-muted-foreground">{t('examsEmpty')}</p>
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setCreateOpen(true)}>
              <Plus className="me-1 h-4 w-4" /> {t('createExam')}
            </Button>
          </CardContent>
        </Card>
      ) : sorted.length === 0 ? (
        <Card className="border-paper bg-paper">
          <CardContent className="py-10 text-center text-[15px] text-muted-foreground">
            لا توجد امتحانات بهذه الحالة — اختر «كل الحالات» من التصفية
          </CardContent>
        </Card>
      ) : (
        <Card className="border-paper bg-paper p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/60 hover:bg-muted/60">
                  <TableHead className="text-start">العنوان</TableHead>
                  <TableHead className="text-start">المادة</TableHead>
                  <TableHead className="text-start tabular-nums">الأسئلة</TableHead>
                  <TableHead className="text-start">الحالة</TableHead>
                  <TableHead className="text-start">آخر تعديل</TableHead>
                  <TableHead className="text-start"><span className="sr-only">إجراءات</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((exam) => (
                  <TableRow key={exam.id} className="text-[15px]">
                    <TableCell className="max-w-64">
                      <Link href={`/exams/${exam.id}/design`} className="font-medium hover:underline">
                        {exam.title}
                      </Link>
                      {exam.omrEnabled && (
                        <span className="ms-2 rounded bg-success/10 px-1.5 py-0.5 text-[13px] text-success">OMR</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{exam.subject ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{exam.questionCount}</TableCell>
                    <TableCell><StatusBadge status={exam.status} /></TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{fmtDate(exam.updatedAt)}</TableCell>
                    <TableCell className="w-12">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`إجراءات ${exam.title}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="rounded-lg">
                          <DropdownMenuItem onClick={() => router.push(`/exams/${exam.id}/design`)}>
                            <PencilRuler className="me-2 h-4 w-4" /> {t('stageDesign')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => router.push(`/exams/${exam.id}/preview`)}>
                            <Eye className="me-2 h-4 w-4" /> {t('stagePreview')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => router.push(`/exams/${exam.id}/omr`)}>
                            <Files className="me-2 h-4 w-4" /> {t('stageOmr')}
                          </DropdownMenuItem>
                          {exam.status !== 'PUBLISHED' && (
                            <DropdownMenuItem onClick={() => void publish(exam.id)}>
                              <FileDown className="me-2 h-4 w-4" /> {t('publish')}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void archive(exam.id)}>
                            <Archive className="me-2 h-4 w-4" /> {t('archive')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
