'use client';

// ============================================================
// ALNOKHBA QB — Question Bank pane (PHASE 1 + 2)
// Reusable question pool: create/edit/search/filter/tag, then
// compose exams from selections (with optional online config).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  DndContext, closestCenter, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle, BookOpen, GripVertical, Loader2, Pencil, Plus, Search, Sparkles, Trash2, Wand2,
} from 'lucide-react';
import type { BankOption, BankQuestion, Difficulty, QuestionType } from '@/lib/qb/bank';

const TYPE_LABEL: Record<QuestionType, string> = { mcq: 'اختيار متعدد', truefalse: 'صح/خطأ', short: 'إجابة قصيرة' };
const DIFF_LABEL: Record<Difficulty, string> = { easy: 'سهل', medium: 'متوسط', hard: 'صعب' };
const DIFF_CLS: Record<Difficulty, string> = {
  easy: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-800',
  hard: 'bg-red-100 text-red-700',
};

interface BankMeta {
  subjects: string[];
  types: string[];
  difficulties: string[];
  tags: string[];
}

interface DraftQuestion {
  id?: string;
  subject: string;
  chapter: string;
  topic: string;
  type: QuestionType;
  prompt: string;
  options: BankOption[];
  correctAnswer: string;
  explanation: string;
  difficulty: Difficulty;
  marks: number;
  tags: string;
}

const emptyDraft = (): DraftQuestion => ({
  subject: '', chapter: '', topic: '', type: 'mcq', prompt: '',
  options: [
    { id: 'A', text: '' }, { id: 'B', text: '' }, { id: 'C', text: '' }, { id: 'D', text: '' },
  ],
  correctAnswer: '', explanation: '', difficulty: 'medium', marks: 1, tags: '',
});

export default function BankPane({ onExamCreated }: { onExamCreated?: (examId: string) => void }) {
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [meta, setMeta] = useState<BankMeta>({ subjects: [], types: [], difficulties: [], tags: [] });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [subject, setSubject] = useState('all');
  const [type, setType] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<DraftQuestion | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (filters?: { q?: string; subject?: string; type?: string; difficulty?: string; reviewOnly?: boolean }) => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (filters?.q) p.set('q', filters.q);
      if (filters?.subject && filters.subject !== 'all') p.set('subject', filters.subject);
      if (filters?.type && filters.type !== 'all') p.set('type', filters.type);
      if (filters?.difficulty && filters.difficulty !== 'all') p.set('difficulty', filters.difficulty);
      if (filters?.reviewOnly) p.set('status', 'pending_review'); // PHASE 8/9 review queue
      const res = await fetch(`/api/questions?${p.toString()}`);
      const data = await res.json();
      setQuestions(Array.isArray(data.questions) ? data.questions : []);
      setMeta(data.meta ?? { subjects: [], types: [], difficulties: [], tags: [] });
      setTotal(data.total ?? 0);
    } catch {
      toast.error('تعذر تحميل بنك الأسئلة');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // debounced live search
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      void load({ q, subject, type, difficulty, reviewOnly });
    }, 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q, subject, type, difficulty, reviewOnly, load]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveDraft = async () => {
    if (!editing) return;
    if (!editing.prompt.trim()) {
      toast.error('اكتب نص السؤال');
      return;
    }
    setSaveBusy(true);
    try {
      const payload = {
        subject: editing.subject || null,
        chapter: editing.chapter || null,
        topic: editing.topic || null,
        type: editing.type,
        prompt: editing.prompt,
        options: editing.type === 'mcq' ? editing.options : [],
        correctAnswer: editing.correctAnswer || null,
        explanation: editing.explanation || null,
        difficulty: editing.difficulty,
        marks: editing.marks,
        tags: editing.tags.split(',').map((t) => t.trim()).filter(Boolean),
      };
      const res = await fetch(editing.id ? `/api/questions/${editing.id}` : '/api/questions', {
        method: editing.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? 'فشل حفظ السؤال');
        return;
      }
      toast.success(editing.id ? 'تم تحديث السؤال' : 'تمت إضافة السؤال إلى البنك');
      setEditing(null);
      void load({ q, subject, type, difficulty, reviewOnly });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setSaveBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/questions/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('حُذف السؤال من البنك');
        setSelected((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
        void load({ q, subject, type, difficulty, reviewOnly });
      } else toast.error('فشل الحذف');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    }
  };

  return (
    <div className="space-y-4" dir="rtl">
      {/* toolbar */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-4">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input className="h-9 pr-8 text-sm" placeholder="بحث في الأسئلة، المواضيع، الوسوم…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={subject} onValueChange={setSubject}>
            <SelectTrigger className="h-9 w-40 text-xs"><SelectValue placeholder="المادة" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل المواد</SelectItem>
              {meta.subjects.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="h-9 w-36 text-xs"><SelectValue placeholder="النوع" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الأنواع</SelectItem>
              {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={difficulty} onValueChange={setDifficulty}>
            <SelectTrigger className="h-9 w-32 text-xs"><SelectValue placeholder="الصعوبة" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل المستويات</SelectItem>
              {(Object.keys(DIFF_LABEL) as Difficulty[]).map((d) => <SelectItem key={d} value={d}>{DIFF_LABEL[d]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant={reviewOnly ? 'default' : 'outline'}
            className={`h-9 gap-1 text-xs ${reviewOnly ? 'bg-amber-500 hover:bg-amber-600' : 'text-amber-700 hover:bg-amber-50'}`}
            onClick={() => setReviewOnly((v) => !v)}
            title="عرض أسئلة بحاجة لمراجعة فقط (OCR/ذكاء اصطناعي)"
          >
            <AlertTriangle className="h-4 w-4" /> بحاجة لمراجعة
          </Button>
          <Button size="sm" className="h-9 gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => setEditing(emptyDraft())}>
            <Plus className="h-4 w-4" /> سؤال جديد
          </Button>
          <Button size="sm" variant="outline" className="h-9 gap-1 text-xs text-emerald-700 hover:bg-emerald-50" onClick={() => setAiOpen(true)}>
            <Sparkles className="h-4 w-4" /> توليد بالذكاء الاصطناعي
          </Button>
          {selected.size > 0 && (
            <Button size="sm" className="h-9 gap-1 bg-slate-800 hover:bg-slate-900" onClick={() => setComposeOpen(true)}>
              <Wand2 className="h-4 w-4" /> إنشاء امتحان من المحدد ({selected.size})
            </Button>
          )}
        </CardContent>
      </Card>

      {/* list */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
            <span className="flex items-center gap-1.5 font-semibold text-slate-700"><BookOpen className="h-4 w-4 text-emerald-600" /> بنك الأسئلة</span>
            <span>{total} سؤال{selected.size > 0 ? ` • ${selected.size} محدد` : ''}</span>
          </div>
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
          ) : questions.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-slate-200 py-12 text-center text-sm text-slate-400">
              لا توجد أسئلة بعد — أنشئ أول سؤال أو استورده عبر OCR
            </div>
          ) : (
            <div className="max-h-96 space-y-2 overflow-y-auto pl-1">
              {questions.map((qu) => (
                <div key={qu.id} className={`flex items-start gap-2.5 rounded-lg border p-3 transition ${selected.has(qu.id) ? 'border-emerald-400 bg-emerald-50/60' : 'hover:bg-slate-50'}`}>
                  <Checkbox className="mt-1" checked={selected.has(qu.id)} onCheckedChange={() => toggleSelect(qu.id)} aria-label={`تحديد ${qu.prompt.slice(0, 20)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm font-medium leading-relaxed text-slate-800">{qu.prompt}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {qu.subject && <Badge variant="outline" className="text-[10px]">{qu.subject}</Badge>}
                      <Badge variant="outline" className="text-[10px]">{TYPE_LABEL[qu.type] ?? qu.type}</Badge>
                      <Badge className={`text-[10px] ${DIFF_CLS[qu.difficulty]}`}>{DIFF_LABEL[qu.difficulty]}</Badge>
                      <Badge variant="outline" className="text-[10px]">{qu.marks} درجة</Badge>
                      {qu.correctAnswer ? (
                        <Badge className="bg-emerald-100 text-[10px] text-emerald-700">مفتاح ✓</Badge>
                      ) : (
                        <Badge className="bg-amber-100 text-[10px] text-amber-800">بحاجة لمراجعة</Badge>
                      )}
                      {qu.source === 'ocr' && <Badge variant="outline" className="text-[10px] text-slate-500">مستورد OCR</Badge>}
                      {qu.source === 'ai' && <Badge className="bg-violet-100 text-[10px] text-violet-700">توليد AI</Badge>}
                      {qu.tags.map((t) => <span key={t} className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-500">#{t}</span>)}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing({
                      id: qu.id, subject: qu.subject ?? '', chapter: qu.chapter ?? '', topic: qu.topic ?? '',
                      type: qu.type, prompt: qu.prompt, options: qu.options.length ? qu.options : emptyDraft().options,
                      correctAnswer: qu.correctAnswer ?? '', explanation: qu.explanation ?? '',
                      difficulty: qu.difficulty, marks: qu.marks, tags: qu.tags.join(', '),
                    })}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500 hover:text-red-600" onClick={() => void remove(qu.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* editor dialog */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" dir="rtl">
          <DialogHeader><DialogTitle className="text-right">{editing?.id ? 'تعديل سؤال' : 'سؤال جديد'}</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="col-span-2 space-y-1"><Label className="text-xs">المادة</Label><Input className="h-9 text-sm" value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></div>
                <div className="col-span-2 space-y-1"><Label className="text-xs">الفصل / الدرس</Label><Input className="h-9 text-sm" value={editing.chapter} onChange={(e) => setEditing({ ...editing, chapter: e.target.value })} /></div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">نص السؤال</Label>
                <Textarea className="min-h-20 text-sm" value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} placeholder="اكتب نص السؤال…" />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="space-y-1">
                  <Label className="text-xs">النوع</Label>
                  <Select value={editing.type} onValueChange={(v) => setEditing({ ...editing, type: v as QuestionType, correctAnswer: '' })}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">الصعوبة</Label>
                  <Select value={editing.difficulty} onValueChange={(v) => setEditing({ ...editing, difficulty: v as Difficulty })}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(DIFF_LABEL) as Difficulty[]).map((d) => <SelectItem key={d} value={d}>{DIFF_LABEL[d]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">الدرجة</Label>
                  <Input type="number" min={1} max={100} className="h-9 text-sm" value={editing.marks} onChange={(e) => setEditing({ ...editing, marks: Math.max(1, Number(e.target.value) || 1) })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">وسوم (فاصلة)</Label>
                  <Input className="h-9 text-sm" value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} placeholder="وحدة1, مهارة" />
                </div>
              </div>

              {editing.type === 'mcq' && <OptionsEditor editing={editing} setEditing={setEditing} />}
              {editing.type === 'truefalse' && (
                <div className="space-y-1">
                  <Label className="text-xs">الإجابة الصحيحة</Label>
                  <div className="flex gap-2">
                    {['A', 'B'].map((id) => (
                      <Button key={id} size="sm" variant={editing.correctAnswer === id ? 'default' : 'outline'}
                        className={editing.correctAnswer === id ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
                        onClick={() => setEditing({ ...editing, correctAnswer: id })}>
                        {id === 'A' ? 'صح' : 'خطأ'}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {editing.type === 'short' && (
                <div className="space-y-1">
                  <Label className="text-xs">الإجابة القصيرة المتوقعة (تصحيح يدوي)</Label>
                  <Input className="h-9 text-sm" value={editing.correctAnswer} onChange={(e) => setEditing({ ...editing, correctAnswer: e.target.value })} />
                </div>
              )}

              <div className="space-y-1">
                <Label className="text-xs">شرح الإجابة (اختياري)</Label>
                <Textarea className="min-h-14 text-sm" value={editing.explanation} onChange={(e) => setEditing({ ...editing, explanation: e.target.value })} />
              </div>
              <div className="flex justify-start gap-2 pt-1">
                <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={saveBusy} onClick={() => void saveDraft()}>
                  {saveBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : editing.id ? 'حفظ التعديلات' : 'إضافة إلى البنك'}
                </Button>
                <Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button>
              </div>
              {!editing.correctAnswer && (
                <p className="text-[11px] text-amber-700">⚠ بدون إجابة صحيحة يُسجَّل السؤال «يحتاج مراجعة» ولن يُصحَّح آليًا حتى تحدد المفتاح.</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ComposeDialog open={composeOpen} onOpenChange={setComposeOpen} selected={[...selected]} meta={meta}
        onDone={(examId) => {
          setSelected(new Set());
          setComposeOpen(false);
          onExamCreated?.(examId);
        }} />

      <AiGenerateDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        onGenerated={() => {
          setReviewOnly(true); // jump straight into the review queue
          void load({ q, subject, type, difficulty, reviewOnly: true });
        }}
      />
    </div>
  );
}

// ---------- AI question generation (PHASE 9) ----------
// The LLM runs SERVER-SIDE only (/api/ai/generate). Generated questions land
// in the bank as pending_review — the teacher's review (key + re-save) is what
// approves them; nothing AI-made can ever auto-publish.

function AiGenerateDialog({
  open, onOpenChange, onGenerated,
}: { open: boolean; onOpenChange: (v: boolean) => void; onGenerated: () => void }) {
  const [topic, setTopic] = useState('');
  const [subject, setSubject] = useState('');
  const [count, setCount] = useState(5);
  const [type, setType] = useState<'mcq' | 'truefalse' | 'short'>('mcq');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [lang, setLang] = useState<'ara' | 'eng'>('ara');
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    if (topic.trim().length < 3) {
      toast.error('اكتب موضوع الأسئلة');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          subject: subject.trim() || undefined,
          count,
          type,
          difficulty,
          lang,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? 'فشل التوليد');
        return;
      }
      toast.success(
        `وَلَّد النموذج ${d.generated} سؤال — أُضيفت كلها "بحاجة لمراجعة"، راجعها ثم اعتمندها`
      );
      onOpenChange(false);
      setTopic('');
      onGenerated();
    } catch {
      toast.error('تعذر الاتصال بخدمة التوليد');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base"><Sparkles className="h-5 w-5 text-violet-600" /> توليد أسئلة بالذكاء الاصطناعي</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">موضوع الأسئلة *</Label>
            <Input className="h-9 text-sm" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="مثال: الكسور العشرية للصف السادس" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">المادة (اختياري)</Label>
              <Input className="h-9 text-sm" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="رياضيات" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">عدد الأسئلة</Label>
              <Select value={String(count)} onValueChange={(v) => setCount(Number(v))}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{[3, 5, 8, 10, 15].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">نوع السؤال</Label>
              <Select value={type} onValueChange={(v) => setType(v as 'mcq' | 'truefalse' | 'short')}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">الصعوبة</Label>
              <Select value={difficulty} onValueChange={(v) => setDifficulty(v as Difficulty)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(DIFF_LABEL) as Difficulty[]).map((d) => <SelectItem key={d} value={d}>{DIFF_LABEL[d]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">لغة الأسئلة</Label>
            <Select value={lang} onValueChange={(v) => setLang(v === 'eng' ? 'eng' : 'ara')}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ara">العربية</SelectItem>
                <SelectItem value="eng">English</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button className="w-full bg-violet-600 hover:bg-violet-700" disabled={busy} onClick={() => void generate()}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> جارٍ التوليد (حتى ~دقيقة)…</> : <><Sparkles className="h-4 w-4" /> توليد</>}
          </Button>
          <p className="text-[11px] leading-relaxed text-slate-500">
            الأسئلة المولّدة تصل بحالة «بحاجة لمراجعة» مع مفتاح إجابة مقترح وشرح — لا تدخل أي امتحان قبل اعتمادك لها.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- options editor with dnd-kit reordering ----------

function OptionsEditor({ editing, setEditing }: { editing: DraftQuestion; setEditing: (d: DraftQuestion) => void }) {
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = editing.options.findIndex((o) => o.id === active.id);
    const newIndex = editing.options.findIndex((o) => o.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setEditing({ ...editing, options: arrayMove(editing.options, oldIndex, newIndex) });
  };
  return (
    <div className="space-y-1">
      <Label className="text-xs">الخيارات (اسحب لإعادة الترتيب) — حدد الإجابة الصحيحة</Label>
      <DndContext modifiers={[restrictToVerticalAxis]} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={editing.options.map((o) => o.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {editing.options.map((o) => (
              <SortableOptionRow key={o.id} option={o}
                isCorrect={editing.correctAnswer === o.id}
                onChangeText={(t) => setEditing({ ...editing, options: editing.options.map((x) => (x.id === o.id ? { ...x, text: t } : x)) })}
                onCorrect={() => setEditing({ ...editing, correctAnswer: o.id })}
                onRemove={editing.options.length > 2 ? () => {
                  setEditing({
                    ...editing,
                    options: editing.options.filter((x) => x.id !== o.id),
                    correctAnswer: editing.correctAnswer === o.id ? '' : editing.correctAnswer,
                  });
                } : undefined} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {editing.options.length < 6 && (
        <Button size="sm" variant="outline" className="h-7 text-xs"
          onClick={() => {
            const used = new Set(editing.options.map((o) => o.id));
            const next = ['A', 'B', 'C', 'D', 'E', 'F'].find((l) => !used.has(l)) ?? String(editing.options.length + 1);
            setEditing({ ...editing, options: [...editing.options, { id: next, text: '' }] });
          }}>
          <Plus className="h-3 w-3" /> خيار
        </Button>
      )}
    </div>
  );
}

function SortableOptionRow({ option, isCorrect, onChangeText, onCorrect, onRemove }: {
  option: BankOption; isCorrect: boolean; onChangeText: (t: string) => void; onCorrect: () => void; onRemove?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: option.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${isCorrect ? 'border-emerald-400 bg-emerald-50' : ''}`}>
      <button {...attributes} {...listeners} className="cursor-grab touch-none text-slate-300 hover:text-slate-500" aria-label="اسحب لإعادة الترتيب">
        <GripVertical className="h-4 w-4" />
      </button>
      <button onClick={onCorrect} title="تعيين كإجابة صحيحة"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition ${isCorrect ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
        {option.id}
      </button>
      <Input className="h-8 flex-1 text-sm" value={option.text} onChange={(e) => onChangeText(e.target.value)} placeholder={`نص الخيار ${option.id}`} />
      {onRemove && (
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-red-400 hover:text-red-600" onClick={onRemove} aria-label="حذف الخيار">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

// ---------- compose exam from selection ----------

function ComposeDialog({ open, onOpenChange, selected, meta, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; selected: string[]; meta: BankMeta; onDone: (examId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [online, setOnline] = useState(false);
  const [durationMin, setDurationMin] = useState(30);
  const [attemptsAllowed, setAttemptsAllowed] = useState(1);
  const [randomizeOrder, setRandomizeOrder] = useState(false);
  const [securityPolicy, setSecurityPolicy] = useState<'warning' | 'strict'>('warning');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) {
      toast.error('اكتب عنوان الامتحان');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/exams/from-bank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, subject, questionIds: selected,
          online: { enabled: online, durationMin, attemptsAllowed, randomizeOrder, securityPolicy },
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? 'فشل إنشاء الامتحان');
        return;
      }
      toast.success(
        `تم إنشاء الامتحان (${d.questionCount} سؤال${d.missingKey > 0 ? ` — ${d.missingKey} يحتاج مفتاح` : ''})`
      );
      onDone(d.examId);
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader><DialogTitle className="text-right">إنشاء امتحان من {selected.length} سؤال</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label className="text-xs">عنوان الامتحان</Label>
            <Input className="h-9 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="امتحان منتصف الفصل" /></div>
          <div className="space-y-1"><Label className="text-xs">المادة</Label>
            <Input className="h-9 text-sm" list="bank-subjects" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <datalist id="bank-subjects">{meta.subjects.map((s) => <option key={s} value={s} />)}</datalist></div>

          <div className="rounded-lg border p-3">
            <label className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">امتحان أونلاين (وضع الطالب)</span>
              <Switch checked={online} onCheckedChange={setOnline} />
            </label>
            {online && (
              <div className="mt-3 space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1"><Label className="text-xs">المدة (دقيقة)</Label>
                    <Input type="number" min={1} max={600} className="h-8 text-sm" value={durationMin} onChange={(e) => setDurationMin(Math.max(1, Number(e.target.value) || 1))} /></div>
                  <div className="space-y-1"><Label className="text-xs">عدد المحاولات</Label>
                    <Input type="number" min={1} max={10} className="h-8 text-sm" value={attemptsAllowed} onChange={(e) => setAttemptsAllowed(Math.max(1, Number(e.target.value) || 1))} /></div>
                </div>
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span>ترتيب عشوائي للأسئلة (لكل طالب)</span>
                  <Switch checked={randomizeOrder} onCheckedChange={setRandomizeOrder} />
                </label>
                <div className="space-y-1">
                  <Label className="text-xs">سياسة الأمان</Label>
                  <Select value={securityPolicy} onValueChange={(v) => setSecurityPolicy(v === 'strict' ? 'strict' : 'warning')}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="warning">تحذير — تسجيل المخالفات والتنبيه (موصى به)</SelectItem>
                      <SelectItem value="strict">صارم — إنهاء المحاولة عند أول مخالفة</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          <Button className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => void create()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'إنشاء وفتح في المصمم'}
          </Button>
          <p className="text-[11px] text-slate-500">يُنشأ الامتحان كمسودة — راجع الأسئلة والمفتاح في المصمم ثم انشر.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
