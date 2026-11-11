'use client';

// Properties panel: geometry, typography, element-specific and exam settings.

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useDesignerStore } from '@/lib/qb/designer-store';
import type { QBElement } from '@/lib/qb/types';

export default function PropertiesPanel() {
  const document = useDesignerStore((s) => s.document);
  const selectedId = useDesignerStore((s) => s.selectedElementId);
  const updateElement = useDesignerStore((s) => s.updateElement);
  const updateBranding = useDesignerStore((s) => s.updateBranding);
  const updateOmr = useDesignerStore((s) => s.updateOmr);
  const setGrading = useDesignerStore((s) => s.setGrading);
  const commitGeometry = useDesignerStore((s) => s.commitGeometry);
  const deleteElement = useDesignerStore((s) => s.deleteElement);
  const duplicateElement = useDesignerStore((s) => s.duplicateElement);
  const reorder = useDesignerStore((s) => s.reorder);
  const answerKey = useDesignerStore((s) => s.answerKey);
  const setAnswerKey = useDesignerStore((s) => s.setAnswerKey);

  const el = document.elements.find((e) => e.id === selectedId) as QBElement | undefined;
  // Linked question for `question` elements → enables the guide-answer selector
  const linkedQuestion =
    el?.type === 'question'
      ? document.questions.find((q) => q.id === (el.content as { questionId?: string }).questionId)
      : undefined;

  const num = (v: number, onChange: (n: number) => void, step = 0.5) => (
    <Input
      type="number"
      step={step}
      value={Number.isFinite(v) ? Math.round(v * 10) / 10 : 0}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className="h-8"
    />
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3" dir="rtl">
      {el ? (
        <>
          <div>
            <Label className="text-xs text-slate-500">العنصر: {el.type}</Label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div><Label className="text-[10px]">X (مم)</Label>{num(el.x, (v) => commitGeometry(el.id, { ...el, x: v }))}</div>
              <div><Label className="text-[10px]">Y (مم)</Label>{num(el.y, (v) => commitGeometry(el.id, { ...el, y: v }))}</div>
              <div><Label className="text-[10px]">العرض</Label>{num(el.widthMm, (v) => commitGeometry(el.id, { ...el, widthMm: v }))}</div>
              <div><Label className="text-[10px]">الارتفاع</Label>{num(el.heightMm, (v) => commitGeometry(el.id, { ...el, heightMm: v }))}</div>
            </div>
            <div className="mt-2">
              <Label className="text-[10px]">التدوير: {el.rotation}°</Label>
              <Slider
                value={[el.rotation]}
                min={-180}
                max={180}
                step={1}
                onValueChange={([v]) => updateElement(el.id, { rotation: v })}
              />
            </div>
            <div className="mt-2 flex gap-1">
              <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={() => duplicateElement(el.id)}>تكرار</Button>
              <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={() => reorder(el.id, 'front')}>للأمام</Button>
              <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={() => reorder(el.id, 'back')}>للخلف</Button>
              <Button size="sm" variant="destructive" className="h-7 flex-1 text-xs" onClick={() => deleteElement(el.id)}>حذف</Button>
            </div>
          </div>

          <Separator />

          {'style' in el && (el.type === 'text' || el.type === 'header' || el.type === 'question' || el.type === 'name-fields' || el.type === 'page-number') && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[10px]">الخط</Label>
                  <Select value={el.style.fontFamily} onValueChange={(v) => updateElement(el.id, { style: { fontFamily: v } as never })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Tajawal">Tajawal</SelectItem>
                      <SelectItem value="Amiri">Amiri</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[10px]">الحجم (pt)</Label>
                  {num(el.style.fontSize, (v) => updateElement(el.id, { style: { fontSize: v } }), 1)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1 text-xs"><Switch checked={el.style.bold} onCheckedChange={(v) => updateElement(el.id, { style: { bold: v } })} /> عريض</label>
                <label className="flex items-center gap-1 text-xs"><Switch checked={el.style.italic} onCheckedChange={(v) => updateElement(el.id, { style: { italic: v } })} /> مائل</label>
              </div>
              <div>
                <Label className="text-[10px]">المحاذاة</Label>
                <Select value={el.style.align} onValueChange={(v) => updateElement(el.id, { style: { align: v } as never })}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="right">يمين</SelectItem>
                    <SelectItem value="center">وسط</SelectItem>
                    <SelectItem value="left">يسار</SelectItem>
                    <SelectItem value="justify">ضبط</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-[10px]">اللون</Label>
                <input type="color" value={el.style.color} onChange={(e) => updateElement(el.id, { style: { color: e.target.value } })} className="h-8 w-14 rounded border" />
              </div>
            </>
          )}

          {el.type === 'question' && (
            <>
              <Separator />
              <div>
                <Label className="text-[10px]">السؤال المرتبط</Label>
                <Select
                  value={(el.content as { questionId: string }).questionId}
                  onValueChange={(v) => updateElement(el.id, { content: { questionId: v } })}
                >
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {document.questions.map((q) => (
                      <SelectItem key={q.id} value={q.id}>س{q.number}: {q.prompt.slice(0, 24)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="mt-2">
                  <Label className="text-[10px]">توزيع الخيارات</Label>
                  <Select value={(el.content as { optionLayout: string }).optionLayout} onValueChange={(v) => updateElement(el.id, { content: { optionLayout: v } })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inline">سطر واحد</SelectItem>
                      <SelectItem value="grid2">عمودان</SelectItem>
                      <SelectItem value="vertical">قائمة رأسية</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* ---- guide answer (correct answer) selector ---- */}
                {linkedQuestion && linkedQuestion.type === 'mcq' && linkedQuestion.options.length >= 2 && (
                  <div className="mt-3 rounded-lg border bg-emerald-50/50 p-2">
                    <Label className="text-[10px] font-semibold text-emerald-800">الإجابة الصحيحة (دليل التصحيح)</Label>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {linkedQuestion.options.map((o) => {
                        const active = answerKey[linkedQuestion.id] === o.id;
                        return (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() => setAnswerKey(linkedQuestion.id, active ? '' : o.id)}
                            aria-pressed={active}
                            title={o.text || `الخيار ${o.id}`}
                            className={`h-7 w-7 rounded-full border text-xs font-bold transition ${
                              active
                                ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm'
                                : 'border-slate-300 bg-white text-slate-600 hover:border-emerald-400 hover:text-emerald-700'
                            }`}
                          >
                            {o.id}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[9px] leading-relaxed text-emerald-700">
                      يُستخدم في التصحيح الآلي (OMR) — يُجمَّد مع النسخة عند النشر.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {el.type === 'text' && (
            <>
              <Separator />
              <div>
                <Label className="text-[10px]">النص</Label>
                <textarea
                  className="mt-1 h-24 w-full rounded border p-2 text-xs"
                  value={(el.content as { text: string }).text}
                  onChange={(e) => updateElement(el.id, { content: { text: e.target.value } })}
                />
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="text-xs font-semibold text-slate-500">إعدادات الامتحان</div>
          <div className="space-y-2">
            <div><Label className="text-[10px]">اسم المدرسة</Label><Input className="h-8" value={document.branding.institution} onChange={(e) => updateBranding({ institution: e.target.value })} /></div>
            <div><Label className="text-[10px]">العام الدراسي</Label><Input className="h-8" value={document.branding.academicYear ?? ''} onChange={(e) => updateBranding({ academicYear: e.target.value })} /></div>
            <div><Label className="text-[10px]">المدة</Label><Input className="h-8" value={document.branding.duration ?? ''} onChange={(e) => updateBranding({ duration: e.target.value })} /></div>
            <div className="flex items-center gap-2">
              <Label className="text-[10px]">الإطار</Label>
              <Select value={document.branding.borderStyle} onValueChange={(v) => updateBranding({ borderStyle: v as 'single' })}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">بدون</SelectItem>
                  <SelectItem value="single">مفرد</SelectItem>
                  <SelectItem value="double">مزدوج</SelectItem>
                </SelectContent>
              </Select>
              <input type="color" value={document.branding.borderColor} onChange={(e) => updateBranding({ borderColor: e.target.value })} className="h-8 w-10 rounded border" />
            </div>
          </div>
          <Separator />
          <div className="text-xs font-semibold text-slate-500">تصميم الورقة</div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label className="text-[10px]">لون التمييز</Label>
              <input
                type="color"
                value={document.branding.accentColor ?? '#16a34a'}
                onChange={(e) => updateBranding({ accentColor: e.target.value })}
                className="h-8 w-10 rounded border"
                title="شريط ملون أعلى كل صفحة"
              />
              <Button variant="outline" size="sm" className="h-8 text-[10px]" onClick={() => updateBranding({ accentColor: undefined })}>
                إزالة
              </Button>
            </div>
            <div>
              <Label className="text-[10px]">حجم خط الأسئلة</Label>
              <Select value={document.branding.fontScale ?? 'm'} onValueChange={(v) => updateBranding({ fontScale: v as 's' | 'm' | 'l' })}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="s">صغير</SelectItem>
                  <SelectItem value="m">متوسط</SelectItem>
                  <SelectItem value="l">كبير</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[10px]">نص تذييل الصفحة (اختياري)</Label>
              <Input
                className="h-8"
                placeholder="مثال: مدرسة النخبة — الفصل الدراسي الأول"
                value={document.branding.footer ?? ''}
                onChange={(e) => updateBranding({ footer: e.target.value || undefined })}
              />
            </div>
          </div>
          <Separator />
          <div className="text-xs font-semibold text-slate-500">التصحيح</div>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={(document.grading?.negativeMarking ?? 0) > 0}
              onCheckedChange={(v) => setGrading({ negativeMarking: v ? 0.25 : 0 })}
            />{' '}
            خصم 0.25 لكل إجابة خاطئة
          </label>
          <Separator />
          <div className="text-xs font-semibold text-slate-500">OMR</div>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={document.omr.enabled} onCheckedChange={(v) => updateOmr({ enabled: v })} /> تفعيل التصحيح الآلي
          </label>
          {document.omr.enabled && (
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-[10px]">خيارات/سؤال</Label><Input type="number" min={2} max={6} className="h-8" value={document.omr.optionsPerQuestion} onChange={(e) => updateOmr({ optionsPerQuestion: parseInt(e.target.value) || 4 })} /></div>
              <div><Label className="text-[10px]">أرقام الطالب</Label><Input type="number" min={4} max={10} className="h-8" value={document.omr.studentIdDigits} onChange={(e) => updateOmr({ studentIdDigits: parseInt(e.target.value) || 6 })} /></div>
            </div>
          )}
          <div className="mt-auto rounded-lg bg-emerald-50 p-3 text-[11px] leading-relaxed text-emerald-800">
            حدّد عنصرًا من الصفحة لتعديل خصائصه، أو أضف عناصر من اللوحة اليمنى.
          </div>
        </>
      )}
    </div>
  );
}
