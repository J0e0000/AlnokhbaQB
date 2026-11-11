'use client';

// ============================================================
// ALNOKHBA QB — Designer: import from Question Bank (PHASE 2)
// Nested dialog inside the designer's question-bank panel. Copies
// selected bank questions into the open draft via the designer
// store (adds question + element + prefills the answer key).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Loader2, Search, FolderDown } from 'lucide-react';
import { useDesignerStore } from '@/lib/qb/designer-store';
import type { BankQuestion } from '@/lib/qb/bank';

export function BankImportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <FolderDown className="mr-1 h-4 w-4" /> استيراد من بنك الأسئلة
      </Button>
      <BankImportDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function BankImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const store = useDesignerStore();
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (search: string) => {
    setLoading(true);
    try {
      const p = search ? `?q=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/questions${p}`);
      const d = await res.json();
      setQuestions(Array.isArray(d.questions) ? d.questions : []);
    } catch {
      toast.error('تعذر تحميل بنك الأسئلة');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(q), 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q, open, load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const importSelected = () => {
    if (selected.size === 0) {
      toast.error('اختر سؤالًا واحدًا على الأقل');
      return;
    }
    setBusy(true);
    try {
      let added = 0;
      let keyed = 0;
      for (const bank of questions) {
        if (!selected.has(bank.id)) continue;
        const options =
          bank.type === 'truefalse'
            ? [
                { id: 'A', text: 'صح' },
                { id: 'B', text: 'خطأ' },
              ]
            : bank.options.length >= 2
              ? bank.options
              : [
                  { id: 'A', text: '' },
                  { id: 'B', text: '' },
                  { id: 'C', text: '' },
                  { id: 'D', text: '' },
                ];
        const created = store.addQuestion();
        store.updateQuestion(created.id, {
          prompt: bank.prompt,
          options,
          marks: bank.marks,
        });
        if (bank.correctAnswer && options.some((o) => o.id === bank.correctAnswer)) {
          store.setAnswerKey(created.id, bank.correctAnswer);
          keyed += 1;
        }
        added += 1;
      }
      toast.success(`أُضيف ${added} سؤال إلى الامتحان${keyed < added ? ` — ${added - keyed} يحتاج مفتاح إجابة` : ' مع المفاتيح'}`);
      setSelected(new Set());
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-right">استيراد من بنك الأسئلة</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input className="h-9 pr-8 text-sm" placeholder="بحث…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" /></div>
        ) : questions.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">البنك فارغ — أضف أسئلة من صفحة «بنك الأسئلة»</div>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto pl-1">
            {questions.map((b) => (
              <label key={b.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 hover:bg-slate-50">
                <Checkbox className="mt-1" checked={selected.has(b.id)} onCheckedChange={() => toggle(b.id)} />
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-sm">{b.prompt}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {b.subject && <Badge variant="outline" className="text-[10px]">{b.subject}</Badge>}
                    <Badge variant="outline" className="text-[10px]">{b.marks} درجة</Badge>
                    {b.correctAnswer ? <Badge className="bg-emerald-100 text-[10px] text-emerald-700">مفتاح ✓</Badge> : <Badge className="bg-amber-100 text-[10px] text-amber-800">بلا مفتاح</Badge>}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
        <Button className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={busy || selected.size === 0} onClick={importSelected}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : `إضافة ${selected.size || ''} إلى الامتحان`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
