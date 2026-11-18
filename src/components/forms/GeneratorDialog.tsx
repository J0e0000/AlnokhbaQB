'use client';

import { useState } from 'react';
import { FileDown, Loader2, Printer, Wand2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { useFormsStore } from '@/lib/forms/store';
import { DEFAULT_OPTION_PRESETS } from '@/lib/forms/types';
import { generateSheetsPdf } from '@/lib/forms/sheet-generator';
import { makeDemoSheets } from '@/lib/forms/demo-sheets';
import { downloadBlob } from '@/lib/pw/blob';

interface Props {
  lang: 'ar' | 'en';
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function GeneratorDialog({ lang, open, onOpenChange }: Props) {
  const { addFiles, loadTemplateObject } = useFormsStore();
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  const [title, setTitle] = useState(lang === 'ar' ? 'ورقة إجابة' : 'Answer sheet');
  const [questions, setQuestions] = useState(20);
  const [labelsId, setLabelsId] = useState('ABCDE');
  const [orientation, setOrientation] = useState<'down' | 'across'>('down');
  const [copies, setCopies] = useState(30);
  const [includeQr, setIncludeQr] = useState(true);
  const [busy, setBusy] = useState('');

  const labels = DEFAULT_OPTION_PRESETS.find((p) => p.id === labelsId)?.labels ?? ['A', 'B', 'C', 'D', 'E'];

  const generate = async (mode: 'download' | 'demo' | 'template') => {
    setBusy(mode);
    try {
      const { blob, template } = await generateSheetsPdf({
        title,
        questions,
        labels,
        orientation,
        copies,
        includeQr,
      });
      if (mode === 'download') {
        downloadBlob(blob, `${title || 'form'}.sheets.pdf`);
        downloadBlob(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }), `${title || 'form'}.template.json`);
        toast.success(L('تم تنزيل الأوراق + القالب المطابق', 'Sheets + matching template downloaded'));
      } else if (mode === 'template') {
        loadTemplateObject(template);
        toast.success(L('طُبّق قالب المولّد على الجلسة', 'Generator template applied'));
        onOpenChange(false);
      } else {
        const bytes = await blob.arrayBuffer();
        const demos = await makeDemoSheets(template, bytes, copies, (d, t) => {
          if (d % 5 === 0) toast.info(L(`جارٍ توليد الأوراق ${d}/${t}`, `Generating sheets ${d}/${t}`));
        });
        await addFiles(demos.map((d) => d.file));
        loadTemplateObject(template);
        toast.success(L(`أُضيفت ${demos.length} ورقة ممتلئة — انتقل للقراءة`, `${demos.length} filled demo sheets added — go read them`));
        onOpenChange(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="text-start">{L('مولّد أوراق الإجابة', 'Answer-sheet generator')}</DialogTitle>
          <DialogDescription className="text-start">
            {L(
              'يُنشئ PDF قابلًا للطباعة بعلامات زاوية + QR + شبكة فقاعات، مع ملف القالب المطابق — فتُقرأ الأوراق المطبوعة بدقة تامة.',
              'Creates a printable PDF with corner fiducials, a QR serial and bubble grids — plus the exact matching template, so printed sheets read perfectly.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{L('العنوان', 'Title')}</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>{L('عدد الأسئلة (حتى ~٥٠)', 'Questions (up to ~50)')}</Label>
              <Input type="number" min={1} max={50} value={questions} onChange={(e) => setQuestions(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
            </div>
            <div>
              <Label>{L('الخيارات', 'Options')}</Label>
              <Select value={labelsId} onValueChange={setLabelsId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEFAULT_OPTION_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{L('اتجاه الأسئلة', 'Questions run')}</Label>
              <Select value={orientation} onValueChange={(v) => setOrientation(v as 'down' | 'across')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="down">{L('أسفل (صفوف)', 'Down (rows)')}</SelectItem>
                  <SelectItem value="across">{L('عبر (أعمدة)', 'Across (columns)')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="flex justify-between">
                {L('عدد الأوراق', 'Copies')} <span className="font-bold">{copies}</span>
              </Label>
              <Slider value={[copies]} min={1} max={60} step={1} onValueChange={([v]) => setCopies(v)} className="mt-2" />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div>
              <div className="text-xs font-semibold">{L('رمز QR لرقم الورقة', 'QR sheet serial')}</div>
              <div className="text-[10px] text-muted-foreground">{L('يظهر في عمود BCR-1 عند القراءة', 'Appears in the BCR-1 column after reading')}</div>
            </div>
            <Switch checked={includeQr} onCheckedChange={setIncludeQr} />
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" className="btn-primary-grad gap-1 border-0 text-white" disabled={busy !== ''} onClick={() => void generate('download')}>
              {busy === 'download' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
              {L('تنزيل PDF + القالب', 'Download PDF + template')}
            </Button>
            <Button size="sm" variant="outline" className="gap-1" disabled={busy !== ''} onClick={() => void generate('template')}>
              <Wand2 className="h-3.5 w-3.5" /> {L('تطبيق القالب على الجلسة', 'Apply template to session')}
            </Button>
            <Button size="sm" variant="outline" className="gap-1" disabled={busy !== ''} onClick={() => void generate('demo')}>
              {busy === 'demo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
              {L('محاكاة أوراق ممتلئة (اختبار شامل)', 'Simulate filled sheets (full test)')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
