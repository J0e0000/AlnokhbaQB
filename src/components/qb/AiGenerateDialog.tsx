'use client';

// ============================================================
// ALNOKHBA QB — AI question generation dialog (Amethyst Royale)
// Talks to POST /api/ai/generate (strict JSON → teacher review).
// Generated questions ALWAYS land as pending_review; the bank
// list refreshes so the teacher can review them immediately.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { BrainCircuit, Loader2, Sparkles } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after a successful generation so the parent can refresh. */
  onGenerated: (count: number) => void;
}

const TYPE_LABEL: Record<string, string> = {
  mcq: 'اختيار متعدد',
  truefalse: 'صح وخطأ',
  short: 'مقالي قصير',
};

const DIFF_LABEL: Record<string, string> = {
  easy: 'سهل',
  medium: 'متوسط',
  hard: 'صعب',
};

export function AiGenerateDialog({ open, onOpenChange, onGenerated }: Props) {
  const [topic, setTopic] = useState('');
  const [subject, setSubject] = useState('');
  const [count, setCount] = useState('5');
  const [type, setType] = useState('mcq');
  const [difficulty, setDifficulty] = useState('medium');
  const [lang, setLang] = useState('ara');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ generated: number; rejected: number } | null>(null);

  const reset = () => {
    setTopic('');
    setSubject('');
    setCount('5');
    setType('mcq');
    setDifficulty('medium');
    setLang('ara');
    setResult(null);
  };

  const generate = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          subject: subject.trim() || undefined,
          count: Math.max(1, Math.min(15, Number(count) || 5)),
          type,
          difficulty,
          lang,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        details?: string;
        generated?: number;
        rejected?: number;
      };
      if (!res.ok) {
        toast.error(data.error ?? 'تعذر توليد الأسئلة', {
          description: data.details,
          duration: 8000,
        });
        return;
      }
      setResult({ generated: data.generated ?? 0, rejected: data.rejected ?? 0 });
      toast.success(`تم توليد ${data.generated ?? 0} سؤالًا — بانتظار مراجعتك`);
      onGenerated(data.generated ?? 0);
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-right">
            <span className="logo-glow flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-700 text-white">
              <BrainCircuit className="h-4 w-4" />
            </span>
            توليد أسئلة بالذكاء الاصطناعي
          </DialogTitle>
          <DialogDescription className="text-right">
            حدّد الموضوع والإعدادات — الأسئلة المولّدة تصل بحالة «بانتظار المراجعة» ولا تنشر إلا بعد موافقتك.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-2 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-500">
              <Sparkles className="h-7 w-7" />
            </div>
            <div className="text-sm font-bold">
              جاهز للمراجعة: <span className="text-primary">{result.generated}</span> سؤالًا
              {result.rejected > 0 && <span className="text-muted-foreground"> • تم استبعاد {result.rejected}</span>}
            </div>
            <p className="text-xs text-muted-foreground">
              تظهر الأسئلة الآن في القائمة بحالة «بانتظار المراجعة» — راجعها وعدّل ما يلزم قبل اعتمادها.
            </p>
            <DialogFooter className="gap-2 sm:justify-center">
              <Button variant="outline" onClick={() => close(false)}>إغلاق</Button>
              <Button className="btn-primary-grad border-0 text-white" onClick={() => { setResult(null); }}>
                توليد المزيد
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-3 py-1">
              <div className="space-y-1.5">
                <Label htmlFor="ai-topic">الموضوع</Label>
                <Textarea
                  id="ai-topic"
                  rows={2}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="مثال: قوانين نيوتن للحركة — الوزن والكتلة والتسارع"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ai-subject">المادة (اختياري)</Label>
                  <Input id="ai-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="فيزياء" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-count">العدد (١-١٥)</Label>
                  <Input id="ai-count" type="number" min={1} max={15} value={count} onChange={(e) => setCount(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>نوع السؤال</Label>
                  <Select value={type} onValueChange={setType}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(TYPE_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>الصعوبة</Label>
                  <Select value={difficulty} onValueChange={setDifficulty}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(DIFF_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>اللغة</Label>
                  <Select value={lang} onValueChange={setLang}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ara">العربية</SelectItem>
                      <SelectItem value="eng">English</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => close(false)} disabled={busy}>إلغاء</Button>
              <Button
                className="btn-primary-grad gap-1.5 border-0 text-white"
                disabled={busy || topic.trim().length < 3}
                onClick={() => void generate()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {busy ? 'جارٍ التوليد…' : `ولّد ${count || 5} سؤالًا`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
