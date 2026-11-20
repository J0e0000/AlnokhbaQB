'use client';

// ============================================================
// النخبة QB — الطلاب (/students)
// Add students, list them in a scrollable table.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { t } from '@/lib/ui/strings';
import { Plus } from 'lucide-react';

interface StudentRow {
  id: string;
  code: string;
  name: string;
  classroom: string | null;
}

export default function StudentsPane() {
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [classroom, setClassroom] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/students');
      setStudents(await res.json());
    } catch {
      toast.error('تعذر تحميل قائمة الطلاب');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error('أدخل رقم الطالب واسمه');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name, classroom }),
      });
      if (res.ok) {
        setCode('');
        setName('');
        setClassroom('');
        toast.success('تمت إضافة الطالب');
        void load();
      } else {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(d?.error ?? 'تعذر الإضافة — أعد المحاولة');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('navStudents')}</h1>
      <Card className="border-border bg-paper">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="st-code">الرقم</Label>
            <Input id="st-code" className="h-10 w-32 tabular-nums" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-name">الاسم</Label>
            <Input id="st-name" className="h-10 w-48" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-class">الفصل</Label>
            <Input id="st-class" className="h-10 w-28" value={classroom} onChange={(e) => setClassroom(e.target.value)} />
          </div>
          <Button className="h-10 bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={() => void add()}>
            <Plus className="me-1 h-4 w-4" /> أضف طالبًا
          </Button>
        </CardContent>
      </Card>
      <Card className="border-border bg-paper p-0">
        <div className="max-h-96 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/60 hover:bg-muted/60">
                <TableHead className="text-start">الرقم</TableHead>
                <TableHead className="text-start">الاسم</TableHead>
                <TableHead className="text-start">الفصل</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.map((s) => (
                <TableRow key={s.id} className="text-[15px]">
                  <TableCell className="tabular-nums">{s.code}</TableCell>
                  <TableCell>{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.classroom ?? '—'}</TableCell>
                </TableRow>
              ))}
              {students.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-[15px] text-muted-foreground">
                    لا يوجد طلاب — أضف أول طالب من الحقل أعلاه
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
