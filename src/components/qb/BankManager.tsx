'use client';

// ============================================================
// ALNOKHBA QB — Question Bank Manager (standalone bank workspace)
// Filters + table + editor + bulk import/export + taxonomy manager
// + Arabic-aware duplicate detection.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import {
  BookOpen, Download, FileJson, FileUp, FolderTree, Loader2, Pencil, Plus,
  Search, Trash2, TriangleAlert, X,
} from 'lucide-react';

interface BankQ {
  id: string;
  subject: string | null;
  chapter: string | null;
  topic: string | null;
  type: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctAnswer: string | null;
  explanation: string | null;
  difficulty: string;
  marks: number;
  tags: string[];
  source: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface Term { id: string; kind: string; name: string; parentKey: string | null }

const EMPTY_FORM = {
  id: '',
  type: 'mcq',
  prompt: '',
  options: [
    { id: 'A', text: '' },
    { id: 'B', text: '' },
    { id: 'C', text: '' },
    { id: 'D', text: '' },
  ],
  correctAnswer: 'A' as string | null,
  explanation: '',
  difficulty: 'medium',
  marks: 1,
  subject: '',
  chapter: '',
  topic: '',
  tags: '',
};

export default function BankManager() {
  const [rows, setRows] = useState<BankQ[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [terms, setTerms] = useState<Term[]>([]);
  const [facets, setFacets] = useState<{ subjects: string[]; chapters: string[]; tags: string[] }>({ subjects: [], chapters: [], tags: [] });

  const [q, setQ] = useState('');
  const [subject, setSubject] = useState('all');
  const [chapter, setChapter] = useState('all');
  const [type, setType] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [tag, setTag] = useState('all');

  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [dupes, setDupes] = useState<Array<{ id: string; prompt: string; subject: string | null }>>([]);
  const [taxonomyOpen, setTaxonomyOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (q.trim()) p.set('q', q.trim());
    if (subject !== 'all') p.set('subject', subject);
    if (chapter !== 'all') p.set('chapter', chapter);
    if (type !== 'all') p.set('type', type);
    if (difficulty !== 'all') p.set('difficulty', difficulty);
    if (tag !== 'all') p.set('tag', tag);
    return p.toString();
  }, [page, q, subject, chapter, type, difficulty, tag]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/questions?${query}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRows(data.questions ?? []);
        setTotal(data.total ?? 0);
        if (data.meta) setFacets({ subjects: data.meta.subjects ?? [], chapters: data.meta.chapters ?? [], tags: data.meta.tags ?? [] });
      } else {
        toast.error(data.error ?? 'تعذر تحميل بنك الأسئلة');
      }
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/taxonomy');
        if (res.ok) setTerms((await res.json()).terms ?? []);
      } catch { /* optional */ }
    })();
  }, [editorOpen, taxonomyOpen]);

  const setSearch = (v: string) => {
    setQ(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setPage(1), 350);
  };

  // ---------- editor ----------

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setDupes([]);
    setEditorOpen(true);
  };

  const openEdit = (r: BankQ) => {
    setForm({
      id: r.id,
      type: r.type,
      prompt: r.prompt,
      options: r.type === 'truefalse'
        ? [ { id: 'A', text: 'صح' }, { id: 'B', text: 'خطأ' } ]
        : r.options.length >= 2 ? r.options : [ { id: 'A', text: '' }, { id: 'B', text: '' }, { id: 'C', text: '' }, { id: 'D', text: '' } ],
      correctAnswer: r.correctAnswer ?? 'A',
      explanation: r.explanation ?? '',
      difficulty: r.difficulty,
      marks: r.marks,
      subject: r.subject ?? '',
      chapter: r.chapter ?? '',
      topic: r.topic ?? '',
      tags: (r.tags ?? []).join(', '),
    });
    setDupes([]);
    setEditorOpen(true);
  };

  const checkDuplicates = async (prompt: string) => {
    if (prompt.trim().length < 6) { setDupes([]); return; }
    try {
      const res = await fetch('/api/questions/duplicate-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, excludeId: form.id || null }),
      });
      if (res.ok) setDupes((await res.json()).duplicates ?? []);
    } catch { /* optional */ }
  };

  const save = async () => {
    if (!form.prompt.trim()) { toast.error('اكتب نص السؤال'); return; }
    if (form.type === 'mcq' && form.options.filter((o) => o.text.trim()).length < 2) {
      toast.error('أدخل خيارين على الأقل للسؤال الاختياري');
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        type: form.type,
        prompt: form.prompt.trim(),
        correctAnswer: form.correctAnswer,
        explanation: form.explanation || null,
        difficulty: form.difficulty,
        marks: form.marks,
        subject: form.subject || null,
        chapter: form.chapter || null,
        topic: form.topic || null,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12),
      };
      if (form.type === 'mcq') {
        payload.options = form.options.filter((o) => o.text.trim());
      }
      const res = await fetch(form.id ? `/api/questions/${form.id}` : '/api/questions', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? 'تعذر الحفظ'); return; }
      toast.success(form.id ? 'تم تحديث السؤال' : 'تمت إضافة السؤال للبنك');
      setEditorOpen(false);
      void load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/questions/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? 'تعذر الحذف');
        return;
      }
      toast.success('تم حذف السؤال');
      void load();
    } catch {
      toast.error('تعذر الاتصال');
    }
  };

  // ---------- import / export ----------

  const exportUrl = (format: string) => `/api/questions/export?format=${format}`;

  const downloadExport = async (format: 'json' | 'csv') => {
    try {
      const res = await fetch(exportUrl(format));
      if (!res.ok) { toast.error('فشل التصدير'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `question-bank.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`تم تصدير ${total} سؤالًا (${format.toUpperCase()})`);
    } catch {
      toast.error('تعذر الاتصال');
    }
  };

  const importFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.json')) {
      toast.error('الاستيراد يقبل ملفات JSON بنفس صيغة التصدير');
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { questions?: unknown[] } | unknown[];
      const items = Array.isArray(parsed) ? parsed : parsed.questions;
      if (!Array.isArray(items) || items.length === 0) { toast.error('الملف لا يحتوي أسئلة'); return; }
      const res = await fetch('/api/questions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? 'فشل الاستيراد'); return; }
      toast.success(`تم استيراد ${data.imported} سؤالًا • تخطي ${data.duplicates} مكرر${data.errors?.length ? ` • أخطاء: ${data.errors.length}` : ''}`);
      void load();
    } catch {
      toast.error('تعذر قراءة الملف — تأكد أنه JSON صالح');
    }
  };

  const termsOf = (kind: string) => terms.filter((t) => t.kind === kind);

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-extrabold text-slate-800">
          <BookOpen className="h-5 w-5 text-emerald-600" /> بنك الأسئلة
          <Badge variant="secondary">{total} سؤال</Badge>
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="gap-1" onClick={() => setTaxonomyOpen(true)}><FolderTree className="h-4 w-4 text-emerald-600" /> التصنيفات</Button>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => void downloadExport('json')}><FileJson className="h-4 w-4" /> تصدير JSON</Button>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => void downloadExport('csv')}><Download className="h-4 w-4" /> تصدير CSV</Button>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => importInputRef.current?.click()}><FileUp className="h-4 w-4" /> استيراد JSON</Button>
          <input ref={importInputRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
          <Button size="sm" className="gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={openCreate}><Plus className="h-4 w-4" /> سؤال جديد</Button>
        </div>
      </div>

      {/* filters */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-2 p-3 md:grid-cols-3 lg:grid-cols-6">
          <div className="relative col-span-2 md:col-span-3 lg:col-span-2">
            <Search className="absolute right-2.5 top-2.5 h-4 w-4 text-slate-300" />
            <Input className="pr-8 text-xs" placeholder="بحث في نص الأسئلة…" value={q} onChange={(e) => setSearch(e.target.value)} aria-label="بحث" />
          </div>
          <Select value={subject} onValueChange={(v) => { setSubject(v); setPage(1); }}>
            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="المادة" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل المواد</SelectItem>
              {[...new Set([...termsOf('subject').map((t) => t.name), ...facets.subjects])].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={chapter} onValueChange={(v) => { setChapter(v); setPage(1); }}>
            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="الفصل" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الفصول</SelectItem>
              {[...new Set([...termsOf('unit').map((t) => t.name), ...facets.chapters])].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={(v) => { setType(v); setPage(1); }}>
            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="النوع" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الأنواع</SelectItem>
              <SelectItem value="mcq">اختيار متعدد</SelectItem>
              <SelectItem value="truefalse">صح / خطأ</SelectItem>
              <SelectItem value="short">مقالي</SelectItem>
            </SelectContent>
          </Select>
          <Select value={difficulty} onValueChange={(v) => { setDifficulty(v); setPage(1); }}>
            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="الصعوبة" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل المستويات</SelectItem>
              <SelectItem value="easy">سهل</SelectItem>
              <SelectItem value="medium">متوسط</SelectItem>
              <SelectItem value="hard">صعب</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-300"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <BookOpen className="h-10 w-10 text-slate-200" />
              <p className="text-sm font-bold text-slate-500">لا توجد أسئلة مطابقة</p>
              <p className="text-xs text-slate-400">أضف سؤالًا يدويًا، أو استورد ملفًا، أو استخدم الاستخراج الذكي من المستندات الممسوحة</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b bg-slate-50 text-slate-500">
                    <th className="px-3 py-2.5 font-bold">السؤال</th>
                    <th className="px-2 py-2.5 font-bold">النوع</th>
                    <th className="px-2 py-2.5 font-bold">الصعوبة</th>
                    <th className="px-2 py-2.5 font-bold">الدرجات</th>
                    <th className="px-2 py-2.5 font-bold">المادة / الفصل</th>
                    <th className="px-2 py-2.5 font-bold">المصدر</th>
                    <th className="px-2 py-2.5 font-bold">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b transition last:border-0 hover:bg-slate-50/70">
                      <td className="max-w-[340px] px-3 py-2.5">
                        <div className="truncate font-medium text-slate-700">{r.prompt}</div>
                        {r.tags.length > 0 && (
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {r.tags.slice(0, 3).map((t) => <Badge key={t} variant="outline" className="px-1.5 py-0 text-[9px] text-slate-400">{t}</Badge>)}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2.5"><TypeBadge type={r.type} /></td>
                      <td className="px-2 py-2.5"><DiffBadge d={r.difficulty} /></td>
                      <td className="px-2 py-2.5 font-bold text-slate-600">{r.marks}</td>
                      <td className="px-2 py-2.5 text-slate-500">{r.subject ?? '—'}{r.chapter ? ` / ${r.chapter}` : ''}</td>
                      <td className="px-2 py-2.5">
                        <Badge variant="outline" className="text-[10px] text-slate-400">
                          {r.source === 'ocr' ? 'استخراج ذكي' : r.source === 'import' ? 'استيراد' : r.source === 'ai' ? 'AI' : 'يدوي'}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(r)} aria-label="تعديل"><Pencil className="h-3.5 w-3.5 text-slate-500" /></Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="حذف"><Trash2 className="h-3.5 w-3.5 text-red-400" /></Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent dir="rtl">
                              <AlertDialogHeader>
                                <AlertDialogTitle>حذف السؤال نهائيًا؟</AlertDialogTitle>
                                <AlertDialogDescription className="line-clamp-2">{r.prompt}</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>إلغاء</AlertDialogCancel>
                                <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => void remove(r.id)}>حذف نهائي</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {total > 25 && (
            <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-slate-500">
              <span>صفحة {page} من {Math.ceil(total / 25)}</span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>السابق</Button>
                <Button size="sm" variant="outline" className="h-7" disabled={page >= Math.ceil(total / 25)} onClick={() => setPage((p) => p + 1)}>التالي</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* editor dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>{form.id ? 'تعديل سؤال' : 'سؤال جديد'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {dupes.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-[11px] text-amber-800">
                <div className="mb-1 flex items-center gap-1 font-bold"><TriangleAlert className="h-3.5 w-3.5" /> تنبيه تكرار محتمل:</div>
                {dupes.map((d) => <div key={d.id} className="truncate">• {d.prompt}</div>)}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="space-y-1">
                <Label className="text-[11px]">النوع</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mcq">اختيار متعدد</SelectItem>
                    <SelectItem value="truefalse">صح / خطأ</SelectItem>
                    <SelectItem value="short">مقالي</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">الصعوبة</Label>
                <Select value={form.difficulty} onValueChange={(v) => setForm((f) => ({ ...f, difficulty: v }))}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="easy">سهل</SelectItem>
                    <SelectItem value="medium">متوسط</SelectItem>
                    <SelectItem value="hard">صعب</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">الدرجات</Label>
                <Input type="number" min={1} max={100} className="h-8 text-xs" value={form.marks} onChange={(e) => setForm((f) => ({ ...f, marks: Math.max(1, parseInt(e.target.value, 10) || 1) }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">وسوم (فاصلة)</Label>
                <Input className="h-8 text-xs" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} placeholder="فصل أول, منزلي" />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px]">نص السؤال</Label>
              <Textarea className="min-h-[70px] text-sm" value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} onBlur={() => void checkDuplicates(form.prompt)} />
            </div>

            {form.type === 'mcq' && (
              <div className="space-y-1.5">
                <Label className="text-[11px]">الخيارات — انقر الدائرة لتحديد الإجابة الصحيحة</Label>
                {form.options.map((o, i) => (
                  <div key={o.id} className={`flex items-center gap-2 rounded-lg border px-2 py-1 ${form.correctAnswer === o.id ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200'}`}>
                    <button
                      className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black ${form.correctAnswer === o.id ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`}
                      onClick={() => setForm((f) => ({ ...f, correctAnswer: o.id }))}
                      aria-label={`تحديد ${o.id} صحيح`}
                      type="button"
                    >
                      {o.id}
                    </button>
                    <Input className="h-7 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0" value={o.text} onChange={(e) => setForm((f) => ({ ...f, options: f.options.map((x, xi) => (xi === i ? { ...x, text: e.target.value } : x)) }))} placeholder={`نص الخيار ${o.id}`} />
                    {form.options.length > 2 && (
                      <button
                        type="button"
                        className="text-slate-300 hover:text-red-400"
                        onClick={() => {
                          setForm((f) => ({
                            ...f,
                            options: f.options.filter((_, xi) => xi !== i).map((x, xi) => ({ ...x, id: ['A', 'B', 'C', 'D', 'E', 'F'][xi] })),
                          }));
                        }}
                        aria-label="حذف الخيار"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {form.options.length < 6 && (
                  <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px] text-emerald-600" onClick={() => setForm((f) => ({ ...f, options: [...f.options, { id: ['A', 'B', 'C', 'D', 'E', 'F'][f.options.length], text: '' }] }))}>
                    + إضافة خيار
                  </Button>
                )}
              </div>
            )}

            {form.type === 'truefalse' && (
              <div className="flex gap-2">
                {[{ id: 'A', label: 'صح ✓' }, { id: 'B', label: 'خطأ ✗' }].map((o) => (
                  <button key={o.id} type="button" className={`flex-1 rounded-lg border px-3 py-2 text-xs font-bold transition ${form.correctAnswer === o.id ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500'}`} onClick={() => setForm((f) => ({ ...f, correctAnswer: o.id }))}>
                    {o.label}
                  </button>
                ))}
              </div>
            )}

            {form.type === 'short' && (
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">السؤال المقالي يُصحح يدويًا أو بمرجع نموذج إجابة — حقل الإجابة الصحيحة اختياري.</div>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-[11px]">المادة</Label>
                <Input list="bm-subjects" className="h-8 text-xs" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
                <datalist id="bm-subjects">{[...new Set([...termsOf('subject').map((t) => t.name), ...facets.subjects])].map((s) => <option key={s} value={s} />)}</datalist>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">الفصل / الوحدة</Label>
                <Input list="bm-chapters" className="h-8 text-xs" value={form.chapter} onChange={(e) => setForm((f) => ({ ...f, chapter: e.target.value }))} />
                <datalist id="bm-chapters">{[...new Set([...termsOf('unit').map((t) => t.name), ...facets.chapters])].map((s) => <option key={s} value={s} />)}</datalist>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">الدرس</Label>
                <Input list="bm-topics" className="h-8 text-xs" value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))} />
                <datalist id="bm-topics">{termsOf('lesson').map((t) => <option key={t.name} value={t.name} />)}</datalist>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px]">شرح الإجابة (اختياري)</Label>
              <Textarea className="min-h-[44px] text-xs" value={form.explanation} onChange={(e) => setForm((f) => ({ ...f, explanation: e.target.value }))} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditorOpen(false)}>إلغاء</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={saving} onClick={() => void save()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} حفظ في البنك
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TaxonomyDialog open={taxonomyOpen} onOpenChange={setTaxonomyOpen} />
    </div>
  );
}

// ---------------- helpers ----------------

function TypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="secondary" className="text-[10px]">
      {type === 'mcq' ? 'اختيار متعدد' : type === 'truefalse' ? 'صح/خطأ' : 'مقالي'}
    </Badge>
  );
}

function DiffBadge({ d }: { d: string }) {
  const map: Record<string, string> = { easy: 'border-emerald-300 bg-emerald-50 text-emerald-700', medium: 'border-amber-300 bg-amber-50 text-amber-700', hard: 'border-red-300 bg-red-50 text-red-700' };
  const label: Record<string, string> = { easy: 'سهل', medium: 'متوسط', hard: 'صعب' };
  return <Badge variant="outline" className={`text-[10px] ${map[d] ?? ''}`}>{label[d] ?? d}</Badge>;
}

// ---------------- taxonomy manager ----------------

const KINDS: Array<{ kind: string; label: string }> = [
  { kind: 'subject', label: 'المواد' },
  { kind: 'grade', label: 'الصفوف' },
  { kind: 'unit', label: 'الوحدات / الفصول' },
  { kind: 'lesson', label: 'الدروس' },
  { kind: 'topic', label: 'الموضوعات' },
];

function TaxonomyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [terms, setTerms] = useState<Term[]>([]);
  const [kind, setKind] = useState('subject');
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/taxonomy');
      if (res.ok) setTerms((await res.json()).terms ?? []);
    } catch { /* optional */ }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const add = async () => {
    if (!name.trim()) { toast.error('اكتب الاسم'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/taxonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, name: name.trim(), parentKey: parent || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? 'تعذر الإضافة');
        return;
      }
      setName('');
      setParent('');
      toast.success('تمت الإضافة');
      void load();
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    const res = await fetch(`/api/taxonomy?id=${id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('تم الحذف'); void load(); } else { toast.error('تعذر الحذف'); }
  };

  const parentOptions = kind === 'unit' || kind === 'lesson' || kind === 'topic'
    ? terms.filter((t) => (kind === 'unit' ? t.kind === 'subject' : t.kind === 'unit' || t.kind === 'subject')).map((t) => t.name)
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FolderTree className="h-4 w-4 text-emerald-600" /> إدارة التصنيفات</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40 space-y-1">
              <Label className="text-[11px]">النوع</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{KINDS.map((k) => <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {parentOptions.length > 0 && (
              <div className="w-44 space-y-1">
                <Label className="text-[11px]">تابع لـ</Label>
                <Select value={parent} onValueChange={setParent}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="بدون" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">بدون</SelectItem>
                    {parentOptions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="min-w-44 flex-1 space-y-1">
              <Label className="text-[11px]">الاسم</Label>
              <Input className="h-8 text-xs" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} placeholder="مثال: الرياضيات" />
            </div>
            <Button size="sm" className="h-8 gap-1 bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => void add()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} إضافة
            </Button>
          </div>

          <div className="max-h-72 space-y-3 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
            {KINDS.map((k) => {
              const list = terms.filter((t) => t.kind === k.kind);
              if (list.length === 0) return null;
              return (
                <div key={k.kind}>
                  <div className="mb-1 text-[11px] font-bold text-slate-400">{k.label}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((t) => (
                      <Badge key={t.id} variant="secondary" className="gap-1 py-1 pl-1 text-[11px]">
                        {t.parentKey ? `${t.parentKey} ← ` : ''}{t.name}
                        <button onClick={() => void del(t.id)} className="rounded-full p-0.5 text-slate-400 transition hover:bg-red-100 hover:text-red-500" aria-label={`حذف ${t.name}`}>
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })}
            {terms.length === 0 && <div className="py-8 text-center text-xs text-slate-400">لا توجد تصنيفات بعد — أضف أول مادة</div>}
          </div>
          <p className="text-[10px] text-slate-400">التصنيفات تظهر كاقتراحات في محرر الأسئلة وفلاتر البنك، وتُستخدم لتنظيم بنك كل مؤسسة على حدة.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
