'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Table2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useFormsStore } from '@/lib/forms/store';
import { flagLabel, type CellValue, type SheetResult } from '@/lib/forms/types';
import { omrQuestionOffsets, DEFAULT_OPTION_PRESETS } from '@/lib/forms/types';
import { gradeResults, type GradeReport } from '@/lib/forms/grading';
import { GradingPanel } from './GradingPanel';
import { ExportBar } from './ExportBar';
import { SheetPreview } from './SheetPreview';

interface Props {
  lang: 'ar' | 'en';
}

const PAGE_SIZE = 40;

export function ReviewStep({ lang }: Props) {
  const { results, template, editCell, selectedSheetId, selectSheet, setStep } = useFormsStore();
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  const [page, setPage] = useState(0);
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [report, setReport] = useState<GradeReport | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const columns = useMemo(() => {
    // union of field orders (identical across sheets in practice)
    const base = results[0]?.fieldOrder ?? [];
    const extra = new Set<string>();
    for (const r of results) for (const f of r.fieldOrder) if (!base.includes(f)) extra.add(f);
    return [...base, ...extra];
  }, [results]);

  useEffect(() => {
    setReport(gradeResults(results, template));
  }, [results, template]);

  const offsets = useMemo(() => omrQuestionOffsets(template.areas), [template.areas]);

  const labelsForQuestion = (q: number): string[] => {
    for (let i = 0; i < template.areas.length; i++) {
      const a = template.areas[i];
      if (a.type !== 'omr') continue;
      const base = offsets[i] ?? 0;
      const count = Math.max(1, a.questions ?? 1);
      if (q > base && q <= base + count) return a.labels ?? ['A', 'B', 'C', 'D'];
    }
    return DEFAULT_OPTION_PRESETS[0].labels;
  };

  const pageRows = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));

  // ---------- keyboard navigation ----------
  const focusCell = (row: number, col: number) => {
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${row}-${col}"]`);
    if (el) {
      el.focus();
      setActiveCell({ row, col });
    }
  };

  const onCellKeyDown = (e: React.KeyboardEvent, row: number, col: number) => {
    const cols = columns.length;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        focusCell(row, Math.min(cols - 1, col + 1));
        break;
      case 'ArrowLeft':
        focusCell(row, Math.max(0, col - 1));
        break;
      case 'ArrowDown':
        focusCell(Math.min(pageRows.length - 1, row + 1), col);
        break;
      case 'ArrowUp':
        focusCell(Math.max(0, row - 1), col);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  // ---------- cell editing ----------
  const editOmrCell = (r: SheetResult, col: number, label: string | null) => {
    const field = columns[col];
    if (!field) return;
    const current = r.fields[field];
    if (!current || current.kind !== 'omr') return;
    if (label === null) {
      editCell(r.sheetId, field, { status: 'blank', labels: [] });
    } else {
      editCell(r.sheetId, field, { status: 'single', labels: [label] });
    }
  };

  const cellClass = (v: CellValue | undefined): string => {
    if (!v) return '';
    if (v.kind === 'omr') {
      if (v.edited) return 'bg-emerald-600/15 text-emerald-600';
      if (v.status === 'blank') return 'text-amber-600';
      if (v.status === 'multiple') return 'text-red-500 font-bold';
      if (template.key[String(v.question)]) {
        return (v.labels ?? [])[0] === template.key[String(v.question)] ? 'text-emerald-600 font-bold' : 'text-red-500 font-bold';
      }
      return '';
    }
    if (v.status === 'unreadable') return 'text-amber-600';
    return '';
  };

  const displayCell = (r: SheetResult, field: string): string => {
    if (field === 'file_name') return r.fileName;
    const v = r.fields[field];
    if (!v) return '';
    if (v.status === 'blank') return '–';
    if (v.status === 'multiple') return (v.labels ?? []).join(',') + '*';
    if (v.status === 'unreadable') return L('غير مقروء', 'unreadable');
    return (v.labels ?? []).join(',') || v.text || '';
  };

  if (!results.length) {
    return (
      <Card dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <CardContent className="space-y-3 py-14 text-center">
          <p className="text-sm text-muted-foreground">{L('لم تُقرأ أي ورقة بعد', 'No sheets have been read yet')}</p>
          <Button size="sm" variant="outline" onClick={() => setStep('read')}>
            {L('الذهاب إلى القراءة', 'Go to reading')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const selected = results.find((r) => r.sheetId === selectedSheetId) ?? results[0];

  return (
    <div className="space-y-4" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* summary */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge className="bg-emerald-600/15 text-emerald-600">
          {L(`${results.length} ورقة مقروءة`, `${results.length} sheets read`)}
        </Badge>
        {template.negative > 0 && (
          <Badge className="bg-amber-500/15 text-amber-600">{L(`تصحيح سلبي: −${template.negative}`, `negative marking: −${template.negative}`)}</Badge>
        )}
        {(() => {
          const flagged = results.filter((r) => r.flags.length);
          return flagged.length ? (
            <Badge className="bg-red-500/15 text-red-500">{L(`${flagged.length} ورقة تحتاج مراجعة`, `${flagged.length} sheets need review`)}</Badge>
          ) : null;
        })()}
        <span className="ms-auto flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setStep('read')}>{L('إعادة القراءة', 'Re-read')}</Button>
          <Button size="sm" variant="outline" onClick={() => setStep('template')}>{L('تعديل القالب', 'Edit template')}</Button>
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        {/* table */}
        <Card>
          <CardContent className="p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
              <Table2 className="h-4 w-4 text-emerald-500" />
              {L('النتائج — انقر خلية لتصحيحها، الأسهم للتنقل', 'Results — click a cell to correct it, arrow keys to navigate')}
            </h3>
            <div className="max-h-[52vh] overflow-auto rounded-xl border pw-scroll" ref={gridRef} tabIndex={-1}>
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
                  <tr>
                    <th className="whitespace-nowrap border-b px-2 py-1.5 text-start">#</th>
                    <th className="whitespace-nowrap border-b px-2 py-1.5 text-start">file_name</th>
                    {columns.slice(1).map((f, ci) => (
                      <th key={f} className="whitespace-nowrap border-b px-2 py-1.5 text-center" title={f}>
                        {f.startsWith('OMR-') ? `Q${f.split('-')[2]}` : f}
                      </th>
                    ))}
                    <th className="whitespace-nowrap border-b px-2 py-1.5 text-center">{L('الدرجة', 'Score')}</th>
                    <th className="whitespace-nowrap border-b px-2 py-1.5 text-center">%</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, row) => {
                    const score = report?.perSheet.find((s) => s.sheetId === r.sheetId);
                    return (
                      <tr
                        key={r.sheetId}
                        className={selected?.sheetId === r.sheetId ? 'bg-emerald-500/5' : 'hover:bg-accent/50'}
                        onClick={() => selectSheet(r.sheetId)}
                      >
                        <td className="border-b px-2 py-1 text-muted-foreground">{page * PAGE_SIZE + row + 1}</td>
                        <td className="max-w-40 truncate border-b px-2 py-1" title={r.fileName}>{r.fileName}</td>
                        {columns.slice(1).map((f, ci) => {
                          const v = r.fields[f];
                          const editable = v?.kind === 'omr';
                          return (
                            <td key={f} className="border-b p-0 text-center">
                              {editable ? (
                                <select
                                  data-cell={`${row}-${ci + 1}`}
                                  tabIndex={0}
                                  aria-label={f}
                                  value={(v.status === 'single' && (v.labels ?? [])[0]) || ''}
                                  onFocus={() => setActiveCell({ row, col: ci + 1 })}
                                  onKeyDown={(e) => onCellKeyDown(e, row, ci + 1)}
                                  onClick={() => selectSheet(r.sheetId)}
                                  onChange={(e) => editOmrCell(r, ci + 1, e.target.value === '' ? null : e.target.value)}
                                  className={`h-6 w-full cursor-pointer border-0 bg-transparent text-center text-xs outline-none focus:bg-emerald-500/15 focus:ring-1 focus:ring-emerald-500 ${cellClass(v)}`}
                                >
                                  <option value="">–</option>
                                  {labelsForQuestion(v.question ?? 0).map((lb) => (
                                    <option key={lb} value={lb}>{lb}</option>
                                  ))}
                                </select>
                              ) : (
                                <div className={`px-2 py-1 ${cellClass(v)}`}>{displayCell(r, f)}</div>
                              )}
                            </td>
                          );
                        })}
                        <td className="whitespace-nowrap border-b px-2 py-1 text-center font-bold">
                          {score ? `${score.score}/${score.maxScore}` : ''}
                        </td>
                        <td className="whitespace-nowrap border-b px-2 py-1 text-center">{score ? `${score.percentage}%` : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* flags legend + pagination */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                <span><span className="font-bold text-amber-600">–</span> {L('فارغ', 'blank')}</span>
                <span><span className="font-bold text-red-500">*</span> {L('متعدد', 'multiple')}</span>
                <span>{L('أخضر = صحيح، أحمر = خطأ (حسب المفتاح)', 'green = correct, red = wrong (per answer key)')}</span>
                <span>{flagLabel('low-confidence', lang)}</span>
              </div>
              {pages > 1 && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" className="h-6 px-2" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹</Button>
                  <span className="text-[10px]">{page + 1}/{pages}</span>
                  <Button size="sm" variant="outline" className="h-6 px-2" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>›</Button>
                </div>
              )}
            </div>
            {/* selected sheet flags */}
            {selected && selected.flags.length > 0 && (
              <div className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                <b>{selected.fileName}:</b>{' '}
                {selected.flags.map((f) => flagLabel(f, lang)).join(' • ')}
                {selected.alignMethod === 'failed' && ` • ${L('المحاذاة فشلت — الأرقام أدناه غير مصححة المنظور', 'alignment failed — readings are not perspective-corrected')}`}
              </div>
            )}
          </CardContent>
        </Card>

        {/* preview + grading */}
        <div className="space-y-4">
          <SheetPreview lang={lang} />
          {report && <GradingPanel lang={lang} report={report} labelsForQuestion={labelsForQuestion} />}
        </div>
      </div>

      {/* item analysis + exports */}
      {report && report.items.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
              <ClipboardList className="h-4 w-4 text-emerald-500" />
              {L('تحليل الأسئلة (نسبة الإجابات الصحيحة)', 'Item analysis (percent correct per question)')}
            </h3>
            <div className="max-h-64 overflow-y-auto pw-scroll rounded-lg border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-muted-foreground">
                    <th className="px-3 py-1.5 text-start">{L('السؤال', 'Question')}</th>
                    <th className="px-3 py-1.5 text-start">{L('المفتاح', 'Key')}</th>
                    <th className="px-3 py-1.5 text-start">{L('صحيح %', 'Correct %')}</th>
                    <th className="px-3 py-1.5 text-start">{L('التوزيع', 'Distribution')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((it) => (
                    <tr key={it.question} className="border-t">
                      <td className="px-3 py-1.5 font-bold">Q{it.question}</td>
                      <td className="px-3 py-1.5">{it.key}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full ${it.percentCorrect >= 60 ? 'bg-emerald-500' : it.percentCorrect >= 30 ? 'bg-amber-500' : 'bg-red-500'}`}
                              style={{ width: `${it.percentCorrect}%` }}
                            />
                          </div>
                          <span className="font-bold">{it.percentCorrect}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {Object.entries(it.distribution)
                          .sort((a, b) => b[1] - a[1])
                          .map(([lb, n]) => `${lb}:${n}`)
                          .join('  ') || (it.blank ? L('أغلبها فارغ', 'mostly blank') : '')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <ExportBar lang={lang} />
    </div>
  );
}
