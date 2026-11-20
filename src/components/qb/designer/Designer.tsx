'use client';

// ============================================================
// ALNOKHBA QB — Exam Designer (Fabric.js)
// Create Exam → Design → Preview → Generate → Publish
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
import ExamCanvas from './ExamCanvas';
import PropertiesPanel from './PropertiesPanel';
import { BankImportButton } from './BankImportDialog';
import { useDesignerStore } from '@/lib/qb/designer-store';
import { starterDocument } from '@/lib/qb/schema';
import type { QBQuestion } from '@/lib/qb/types';
import {
  ChevronLeft, ChevronRight, FilePlus2, Heading1, Image as ImageIcon, Layout, LetterText,
  ImagePlus as LogoIcon, Magnet, Minus, Plus, Redo2, Save, Shapes, Sigma, Trash2, Type, Undo2, Minimize2,
} from 'lucide-react';

interface DesignerProps {
  examId: string;
}

export default function Designer({ examId }: DesignerProps) {
  const store = useDesignerStore();
  const doc = useDesignerStore((s) => s.document);
  const activePage = useDesignerStore((s) => s.activePage);
  const zoom = useDesignerStore((s) => s.zoom);
  const gridSnap = useDesignerStore((s) => s.gridSnap);
  const dirty = useDesignerStore((s) => s.dirty);
  const saving = useDesignerStore((s) => s.saving);
  const lastSavedAt = useDesignerStore((s) => s.lastSavedAt);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bankOpen, setBankOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/exams/${examId}`);
        if (!r.ok) throw new Error('fetch failed');
        const data = await r.json();
        if (cancelled) return;
        const doc = data.document ?? starterDocument(data.exam?.title ?? 'امتحان', 'مدرسة النخبة');
        store.loadExam(examId, data.exam?.title ?? '', doc, data.answerKey ?? {});
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError('تعذر تحميل الامتحان');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
     
  }, [examId]);

  const addText = () => {
    store.addElement({
      id: `el-${Date.now().toString(36)}`,
      type: 'text',
      page: activePage,
      x: doc.margins.leftMm,
      y: 60,
      widthMm: 120,
      heightMm: 12,
      rotation: 0,
      style: { fontFamily: 'Tajawal', fontSize: 12, bold: false, italic: false, underline: false, align: 'right', color: '#111827', lineHeight: 1.5 },
      content: { text: 'نص جديد — اكتب هنا' },
    } as never);
  };

  const addHeader = () => {
    store.addElement({
      id: `el-${Date.now().toString(36)}`,
      type: 'header',
      page: activePage,
      x: 15,
      y: 12,
      widthMm: 180,
      heightMm: 20,
      rotation: 0,
      style: { fontFamily: 'Tajawal', fontSize: 16, bold: true, italic: false, underline: false, align: 'center', color: '#1e293b', lineHeight: 1.3 },
      content: { text: doc.branding.examTitle, level: 1, showMeta: true },
    } as never);
  };

  const addNameFields = () => {
    store.addElement({
      id: `el-${Date.now().toString(36)}`,
      type: 'name-fields',
      page: activePage,
      x: 15,
      y: 36,
      widthMm: 180,
      heightMm: 14,
      rotation: 0,
      style: { fontFamily: 'Tajawal', fontSize: 11, bold: false, italic: false, underline: false, align: 'right', color: '#0f172a', lineHeight: 1.6 },
      content: { fields: ['اسم الطالب', 'الفصل'], showStudentId: true },
    } as never);
  };

  const addShape = (shape: 'rect' | 'ellipse') => {
    store.addElement({
      id: `el-${Date.now().toString(36)}`,
      type: 'shape',
      page: activePage,
      x: 60,
      y: 80,
      widthMm: 60,
      heightMm: 30,
      rotation: 0,
      style: { fontFamily: 'Tajawal', fontSize: 11, bold: false, italic: false, underline: false, align: 'right', color: '#000000', lineHeight: 1.4 },
      content: { shape, fill: 'transparent', stroke: '#334155', strokeWidth: 0.3 },
    } as never);
  };

  const addLine = () => {
    store.addElement({
      id: `el-${Date.now().toString(36)}`,
      type: 'line',
      page: activePage,
      x: 20,
      y: 100,
      widthMm: 170,
      heightMm: 1,
      rotation: 0,
      style: { fontFamily: 'Tajawal', fontSize: 11, bold: false, italic: false, underline: false, align: 'right', color: '#000000', lineHeight: 1.4 },
      content: { stroke: '#334155', strokeWidth: 0.3, dash: 'solid' },
    } as never);
  };

  const addPageNumber = () => {
    store.addElement({
      id: `el-${Date.now().toString(36)}`,
      type: 'page-number',
      page: activePage,
      x: 90,
      y: 280,
      widthMm: 30,
      heightMm: 8,
      rotation: 0,
      style: { fontFamily: 'Tajawal', fontSize: 9, bold: false, italic: false, underline: false, align: 'center', color: '#475569', lineHeight: 1.4 },
      content: {},
    } as never);
  };

  const addImage = () => {
    const input = window.document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) {
        toast.error('الصورة أكبر من 3 ميجابايت');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        store.addElement({
          id: `el-${Date.now().toString(36)}`,
          type: 'image',
          page: activePage,
          x: 60,
          y: 70,
          widthMm: 80,
          heightMm: 50,
          rotation: 0,
          style: { fontFamily: 'Tajawal', fontSize: 11, bold: false, italic: false, underline: false, align: 'right', color: '#000000', lineHeight: 1.4 },
          content: { dataUrl: reader.result as string, fit: 'contain' },
        } as never);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const addLogo = () => {
    const input = window.document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        store.addElement({
          id: `el-${Date.now().toString(36)}`,
          type: 'logo',
          page: activePage,
          x: 15,
          y: 12,
          widthMm: 22,
          heightMm: 22,
          rotation: 0,
          style: { fontFamily: 'Tajawal', fontSize: 11, bold: false, italic: false, underline: false, align: 'right', color: '#000000', lineHeight: 1.4 },
          content: { dataUrl: reader.result as string },
        } as never);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">جارٍ تحميل المحرر…</div>;
  }
  if (error) {
    return <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-destructive">{error}<Button variant="outline" size="sm" onClick={() => window.location.reload()}>إعادة المحاولة</Button></div>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-[calc(100vh-8.5rem)] flex-col gap-2">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border bg-card p-2 shadow-sm">
          <Button variant="ghost" size="icon" onClick={() => store.undo()} className="h-8 w-8"><Undo2 className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" onClick={() => store.redo()} className="h-8 w-8"><Redo2 className="h-4 w-4" /></Button>
          <div className="mx-1 h-6 w-px bg-secondary" />
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => store.setZoom(zoom - 0.1)}><Minus className="h-4 w-4" /></Button>
          <span className="w-12 text-center text-[13px] text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => store.setZoom(zoom + 0.1)}><Plus className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => store.setZoom(0.75)}><Minimize2 className="h-4 w-4" /></Button>
          <Button variant={gridSnap ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8" onClick={() => store.setGridSnap(!gridSnap)}><Magnet className="h-4 w-4" /></Button>
          <div className="mx-1 h-6 w-px bg-secondary" />
          {/* pages */}
          {Array.from({ length: doc.pageCount }).map((_, i) => (
            <button
              key={i}
              onClick={() => store.setActivePage(i)}
              className={`h-8 rounded-lg px-3 text-[13px] font-medium ${i === activePage ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-secondary'}`}
            >
              صفحة {i + 1}
            </button>
          ))}
          {doc.pageCount < 10 && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => store.setPageCount(doc.pageCount + 1)}><Plus className="h-4 w-4" /></Button>
          )}
          <div className="mx-1 h-6 w-px bg-secondary" />
          <QuestionBankDialog open={bankOpen} onOpenChange={setBankOpen} />
          <div className="ms-auto flex items-center gap-2">
            {dirty && <span className="h-2 w-2 animate-pulse rounded-full bg-warning/100" title="تغييرات غير محفوظة" />}
            {lastSavedAt && !dirty && <span className="text-[13px] text-muted-foreground">محفوظ</span>}
            <Button
              size="sm"
              className="h-8 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={saving}
              onClick={async () => {
                const ok = await store.save();
                if (ok) toast.success('تم حفظ الامتحان');
                else toast.error('فشل الحفظ');
              }}
            >
              <Save className="h-4 w-4" /> حفظ
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 gap-2">
          {/* Add-elements panel */}
          <div className="w-40 shrink-0 space-y-1 overflow-y-auto rounded-xl border bg-card p-2 shadow-sm">
            <div className="px-1 pb-1 text-[13px] font-semibold text-muted-foreground">إضافة عنصر</div>
            <AddBtn icon={<Type className="h-4 w-4" />} label="نص" onClick={addText} />
            <AddBtn icon={<Heading1 className="h-4 w-4" />} label="عنوان" onClick={addHeader} />
            <AddBtn icon={<Sigma className="h-4 w-4" />} label="سؤال" onClick={() => { store.addQuestion(); }} />
            <AddBtn icon={<LetterText className="h-4 w-4" />} label="حقول الطالب" onClick={addNameFields} />
            <AddBtn icon={<ImageIcon className="h-4 w-4" />} label="صورة" onClick={addImage} />
            <AddBtn icon={<LogoIcon className="h-4 w-4" />} label="شعار" onClick={addLogo} />
            <AddBtn icon={<Shapes className="h-4 w-4" />} label="مستطيل" onClick={() => addShape('rect')} />
            <AddBtn icon={<Layout className="h-4 w-4" />} label="بيضاوي" onClick={() => addShape('ellipse')} />
            <AddBtn icon={<FilePlus2 className="h-4 w-4" />} label="خط فاصل" onClick={addLine} />
            <AddBtn icon={<FilePlus2 className="h-4 w-4" />} label="رقم الصفحة" onClick={addPageNumber} />
          </div>

          {/* Canvas */}
          <div className="min-w-0 flex-1">
            <ExamCanvas page={activePage} />
          </div>

          {/* Properties */}
          <div className="w-64 shrink-0 overflow-hidden rounded-xl border bg-card shadow-sm">
            <PropertiesPanel />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function AddBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-foreground transition hover:bg-success/10 hover:text-success"
    >
      {icon} {label}
    </button>
  );
}

function QuestionBankDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const doc = useDesignerStore((s) => s.document);
  const answerKey = useDesignerStore((s) => s.answerKey);
  const store = useDesignerStore();
  const [draft, setDraft] = useState<QBQuestion | null>(null);

  const startNew = () => {
    setDraft({
      id: `q-${Date.now().toString(36)}`,
      number: doc.questions.length + 1,
      type: 'mcq',
      prompt: '',
      options: [
        { id: 'A', text: '' },
        { id: 'B', text: '' },
        { id: 'C', text: '' },
        { id: 'D', text: '' },
      ],
      marks: 1,
    });
  };

  const commit = () => {
    if (!draft) return;
    if (!draft.prompt.trim()) {
      toast.error('اكتب نص السؤال');
      return;
    }
    store.updateQuestion(draft.id, draft);
    if (!doc.questions.find((q) => q.id === draft.id)) {
      // new: create then update
      const q = store.addQuestion();
      store.updateQuestion(q.id, { ...draft, id: q.id, number: q.number });
    }
    setDraft(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-[13px]"><Sigma className="h-4 w-4" /> بنك الأسئلة</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-start">بنك الأسئلة ({doc.questions.length})</DialogTitle>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-2 overflow-y-auto ps-1">
          {doc.questions.map((q) => (
            <div key={q.id} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium">س{q.number}. {q.prompt}</div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => store.updateQuestion(q.id, { number: Math.max(1, q.number - 1) })}><ChevronRight className="h-3 w-3" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => store.updateQuestion(q.id, { number: q.number + 1 })}><ChevronLeft className="h-3 w-3" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => store.deleteQuestion(q.id)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1 text-[13px] text-muted-foreground">
                {q.options.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-muted/60">
                    <RadioGroup value={answerKey[q.id] ?? ''} onValueChange={(v) => store.setAnswerKey(q.id, v)} className="flex gap-1">
                      <RadioGroupItem value={o.id} id={`${q.id}-${o.id}`} className="h-3.5 w-3.5" />
                    </RadioGroup>
                    <span className="font-semibold text-success">{o.id})</span> {o.text}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {doc.questions.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">لا توجد أسئلة بعد</div>}
        </div>
        <div className="rounded-lg border bg-muted/60 p-3">
          {draft ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="text-[13px]">نص السؤال</Label>
                  <Textarea className="h-16 text-sm" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
                </div>
                <div className="w-20">
                  <Label className="text-[13px]">الدرجة</Label>
                  <Input type="number" min={0} value={draft.marks} onChange={(e) => setDraft({ ...draft, marks: parseFloat(e.target.value) || 1 })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {draft.options.map((o, i) => (
                  <div key={o.id} className="flex items-center gap-1">
                    <span className="w-5 text-[13px] font-bold text-success">{o.id})</span>
                    <Input
                      className="h-8 text-[13px]"
                      value={o.text}
                      placeholder={`الخيار ${o.id}`}
                      onChange={(e) => {
                        const options = [...draft.options];
                        options[i] = { ...o, text: e.target.value };
                        setDraft({ ...draft, options });
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-[13px] text-muted-foreground">اختر الإجابة الصحيحة بعد الحفظ من القائمة</Label>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>إلغاء</Button>
                  <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={commit}>إضافة السؤال</Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Button size="sm" variant="outline" className="w-full" onClick={startNew}><FilePlus2 className="me-1 h-4 w-4" /> سؤال جديد</Button>
              <BankImportButton />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
