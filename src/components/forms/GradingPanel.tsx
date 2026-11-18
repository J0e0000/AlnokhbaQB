'use client';

import { KeyRound } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useFormsStore } from '@/lib/forms/store';
import { omrQuestionOffsets, totalOmrQuestions, type FormTemplate } from '@/lib/forms/types';
import { type GradeReport } from '@/lib/forms/grading';

interface Props {
  lang: 'ar' | 'en';
  report: GradeReport;
  labelsForQuestion: (q: number) => string[];
}

export function GradingPanel({ lang, report, labelsForQuestion }: Props) {
  const { template, setTemplate } = useFormsStore();
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  const total = totalOmrQuestions(template.areas);
  const offsets = omrQuestionOffsets(template.areas);
  const setKey = (q: number, label: string) => {
    setTemplate((t: FormTemplate) => ({
      ...t,
      key: { ...t.key, [String(q)]: t.key[String(q)] === label ? '' : label },
    }));
  };
  const setWeight = (q: number, w: number) => {
    setTemplate((t: FormTemplate) => ({ ...t, weights: { ...t.weights, [String(q)]: Math.max(0.5, w || 1) } }));
  };

  const allLabels = (q: number) => labelsForQuestion(q);

  const questionsList: { q: number; labels: string[] }[] = [];
  for (let i = 0; i < template.areas.length; i++) {
    const a = template.areas[i];
    if (a.type !== 'omr') continue;
    const base = offsets[i] ?? 0;
    const count = Math.max(1, a.questions ?? 1);
    for (let k = 0; k < count; k++) {
      const q = base + k + 1;
      questionsList.push({ q, labels: allLabels(q) });
    }
  }
  void total;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">
          <KeyRound className="h-4 w-4 text-emerald-500" />
          {L('التصحيح: مفتاح الإجابة والأوزان', 'Grading: answer key, weights, negative marking')}
        </h3>
        <div className="flex items-end gap-2">
          <div className="w-24">
            <Label className="text-[11px]">{L('خصم الخطأ', 'Wrong penalty')}</Label>
            <Input
              className="h-8"
              type="number"
              step={0.25}
              min={0}
              value={template.negative}
              onChange={(e) => setTemplate({ negative: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
          <div className="flex-1 text-[10px] leading-relaxed text-muted-foreground">
            {L(
              '0 = بدون تصحيح سلبي. الأسئلة بدون مفتاح لا تُحسب في الدرجة. التعديلات اليدوية تُحتسب فورًا.',
              '0 disables negative marking. Questions without a key are not graded. Manual cell edits apply instantly.'
            )}
          </div>
        </div>
        <div className="max-h-96 space-y-1 overflow-y-auto pw-scroll rounded-lg border p-2 pe-1">
          {questionsList.map(({ q, labels }) => (
            <div key={q} className="flex items-center gap-2 rounded-lg px-2 py-1">
              <span className="w-8 shrink-0 text-xs font-bold">Q{q}</span>
              <div className="flex shrink-0 gap-1">
                {labels.map((lb) => {
                  const active = template.key[String(q)] === lb;
                  return (
                    <button
                      key={lb}
                      type="button"
                      aria-pressed={active}
                      aria-label={`Q${q}: ${lb}`}
                      onClick={() => setKey(q, lb)}
                      className={`h-6 w-6 rounded-full border text-[10px] font-bold transition ${
                        active
                          ? 'border-emerald-600 bg-emerald-600 text-white'
                          : 'border-border text-muted-foreground hover:border-emerald-500 hover:text-emerald-600'
                      }`}
                    >
                      {lb}
                    </button>
                  );
                })}
              </div>
              <div className="ms-auto flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground">{L('وزن', 'weight')}</span>
                <Input
                  className="h-6 w-14 text-center text-[11px]"
                  type="number"
                  step={0.5}
                  min={0.5}
                  value={template.weights[String(q)] ?? 1}
                  onChange={(e) => setWeight(q, Number(e.target.value))}
                />
              </div>
            </div>
          ))}
          {!questionsList.length && (
            <p className="py-4 text-center text-xs text-muted-foreground">{L('لا أسئلة OMR في القالب', 'No OMR questions in the template')}</p>
          )}
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">
            {L(`مفتاح كامل: ${report.gradedQuestions.length} سؤال`, `key set: ${report.gradedQuestions.length} questions`)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] text-red-500"
            onClick={() => setTemplate((t: FormTemplate) => ({ ...t, key: {}, weights: {} }))}
          >
            {L('مسح المفتاح', 'Clear key')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
