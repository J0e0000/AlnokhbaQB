'use client';

// ============================================================
// ALNOKHBA QB — Review Queue (spec Phase 7)
// Lists every scan the pipeline flagged reviewStatus=PENDING
// (ambiguous answers / unknown student identity / low confidence).
// The teacher opens a scan, sees the graded sheet + debug images,
// fixes identity and/or answers, then APPROVES or REJECTS.
// All actions go through PATCH /api/scans/:id (audited server-side).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  Loader2,
  RefreshCw,
  ShieldX,
  UserCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { QBAnswerStatus, QBScanGrade, QBScannedAnswer } from '@/lib/qb/types';

// ---- types ----

interface QueueItem {
  id: string;
  createdAt: string;
  examId: string | null;
  examVersionId: string | null;
  studentCode: string | null;
  studentId: string | null;
  status: string;
  reviewStatus: string;
  examTitle: string | null;
  pageIndex: number | null;
  ambiguousCount: number;
  overallConfidence: number;
  score: number | null;
  maxScore: number | null;
  percent: number | null;
  needsReview: boolean;
}

interface ScanDetail {
  id: string;
  studentCode: string | null;
  studentId: string | null;
  status: string;
  overallConfidence: number;
  answers: QBScannedAnswer[];
  grade: QBScanGrade | null;
  overrides: Record<string, string>;
  diagnostics: Record<string, unknown> & {
    debugImage?: string | null;
    correctedImage?: string | null;
    batchId?: string;
    pageIndex?: number;
  };
}

const statusMeta: Record<QBAnswerStatus, { label: string; cls: string }> = {
  selected: { label: 'محدد', cls: 'bg-emerald-100 text-emerald-800' },
  unanswered: { label: 'فارغ', cls: 'bg-slate-100 text-slate-600' },
  multiple: { label: 'متعدد ⚠', cls: 'bg-red-100 text-red-700' },
  unclear: { label: 'غير واضح ⚠', cls: 'bg-amber-100 text-amber-800' },
  invalid: { label: 'غير صالح ⚠', cls: 'bg-red-100 text-red-700' },
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ar-EG', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso.slice(0, 16);
  }
}

export default function ReviewQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [linkCode, setLinkCode] = useState('');
  const [saving, setSaving] = useState<'approve' | 'reject' | 'save' | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/scans?review=PENDING', { cache: 'no-store' });
      const data = (await res.json()) as QueueItem[];
      setItems(Array.isArray(data) ? data : []);
    } catch {
      toast.error('تعذر تحميل قائمة المراجعة');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const openScan = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setOverrides({});
    setLinkCode('');
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/scans/${id}`, { cache: 'no-store' });
      if (!res.ok) {
        toast.error('تعذر تحميل تفاصيل الورقة');
        setOpenId(null);
        return;
      }
      const data = (await res.json()) as ScanDetail;
      setDetail(data);
      setOverrides(data.overrides ?? {});
      if (data.studentCode) setLinkCode(data.studentCode);
    } catch {
      toast.error('تعذر تحميل تفاصيل الورقة');
      setOpenId(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const patch = useCallback(
    async (
      id: string,
      body: Record<string, unknown>,
      kind: 'approve' | 'reject' | 'save'
    ): Promise<boolean> => {
      setSaving(kind);
      try {
        const res = await fetch(`/api/scans/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          toast.error(data.error ?? 'تعذر حفظ التعديلات');
          return false;
        }
        return true;
      } catch {
        toast.error('تعذر الاتصال بالخادم');
        return false;
      } finally {
        setSaving(null);
      }
    },
    []
  );

  const approve = useCallback(
    async (withFixes: boolean) => {
      if (!detail) return;
      const body: Record<string, unknown> = { reviewStatus: 'APPROVED' };
      if (Object.keys(overrides).length > 0) body.overrides = overrides;
      if (withFixes) {
        if (linkCode.trim()) {
          if (!/^\d{1,12}$/.test(linkCode.trim())) {
            toast.error('رقم الطالب يجب أن يكون أرقامًا فقط');
            return;
          }
          body.studentCode = linkCode.trim();
        }
      }
      if (await patch(detail.id, body, 'approve')) {
        toast.success('تم اعتماد الورقة وتثبيت النتيجة');
        setOpenId(null);
        void loadQueue();
      }
    },
    [detail, overrides, linkCode, patch, loadQueue]
  );

  const reject = useCallback(async () => {
    if (!detail) return;
    if (await patch(detail.id, { reviewStatus: 'REJECTED' }, 'reject')) {
      toast.info('تم رفض الورقة — لن تُحتسب في النتائج');
      setOpenId(null);
      void loadQueue();
    }
  }, [detail, patch, loadQueue]);

  const ambiguousInDetail = useMemo(
    () => (detail?.grade?.ambiguous ?? []).length,
    [detail]
  );

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <ClipboardCheck className="h-5 w-5 text-emerald-600" />
            قائمة المراجعة
          </h2>
          <p className="text-xs text-slate-500">
            الأوراق التي يحتاج قراءتها تدخل بشري: إجابات ملتبسة، هوية غير مؤكدة، أو ثقة منخفضة —
            صحّح ثم اعتمد لتثبيت الدرجة.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1 border-amber-300 bg-amber-50 text-amber-800">
            <FileSearch className="h-3.5 w-3.5" /> {items.length} ورقة معلّقة
          </Badge>
          <Button variant="outline" size="sm" onClick={() => void loadQueue()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            تحديث
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" /> جارٍ التحميل…
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-slate-500">
              <BadgeCheck className="h-8 w-8 text-emerald-500" />
              لا توجد أوراق تنتظر المراجعة — كل القراءات معتمدة.
            </div>
          ) : (
            <div className="max-h-[28rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/95 text-[11px] text-slate-500 backdrop-blur">
                  <tr>
                    <th className="p-2.5 text-right font-semibold">التاريخ</th>
                    <th className="p-2.5 text-right font-semibold">الامتحان</th>
                    <th className="p-2.5 text-right font-semibold">الطالب</th>
                    <th className="p-2.5 text-right font-semibold">الدرجة</th>
                    <th className="p-2.5 text-right font-semibold">الملتبسة</th>
                    <th className="p-2.5 text-right font-semibold">الثقة</th>
                    <th className="p-2.5 text-right font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr
                      key={it.id}
                      className="border-t transition hover:bg-accent/50"
                      onClick={() => void openScan(it.id)}
                    >
                      <td className="p-2.5 text-xs text-slate-500">{fmtDate(it.createdAt)}</td>
                      <td className="max-w-45 truncate p-2.5 text-xs" title={it.examTitle ?? ''}>
                        {it.examTitle ?? '—'}
                        {it.pageIndex != null && (
                          <span className="text-slate-400"> • ص{it.pageIndex + 1}</span>
                        )}
                      </td>
                      <td className="p-2.5">
                        {it.studentCode ? (
                          <span className="font-bold">{it.studentCode}</span>
                        ) : (
                          <span className="text-amber-600">غير مقروء</span>
                        )}
                        {!it.studentId && it.studentCode && (
                          <span className="text-[10px] text-amber-600"> (غير مرتبط)</span>
                        )}
                      </td>
                      <td className="p-2.5">
                        {it.score != null ? (
                          <span className="font-bold text-emerald-700">
                            {it.score}/{it.maxScore ?? '—'}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="p-2.5">
                        {it.ambiguousCount > 0 ? (
                          <Badge className="bg-red-100 text-red-700">{it.ambiguousCount}</Badge>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="p-2.5">
                        <span
                          className={`text-xs font-bold ${
                            it.overallConfidence >= 0.6 ? 'text-slate-600' : 'text-amber-600'
                          }`}
                        >
                          {Math.round(it.overallConfidence * 100)}%
                        </span>
                      </td>
                      <td className="p-2.5 text-left">
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]">
                          <FileSearch className="h-3.5 w-3.5" /> فتح
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- detail dialog ---- */}
      <Dialog open={openId !== null} onOpenChange={(v) => !v && setOpenId(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-right">
              <ClipboardCheck className="h-5 w-5 text-emerald-600" /> مراجعة الورقة الممسوحة
            </DialogTitle>
            <DialogDescription className="text-right text-xs">
              صحّح الهوية و/أو الإجابات ثم اعتمد — كل تعديل يُسجَّل في سجل التدقيق.
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" /> جارٍ التحميل…
            </div>
          ) : (
            <div className="space-y-4">
              {/* grade summary */}
              {detail.grade && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border bg-emerald-50/60 p-3 text-center">
                    <div className="text-2xl font-black text-emerald-700">{detail.grade.score}</div>
                    <div className="text-[10px] text-slate-500">من {detail.grade.maxScore}</div>
                  </div>
                  <div className="rounded-xl border p-3 text-center">
                    <div className="text-lg font-black text-emerald-600">
                      {detail.grade.correct.length}
                    </div>
                    <div className="text-[10px] text-slate-500">صحيحة</div>
                  </div>
                  <div className="rounded-xl border p-3 text-center">
                    <div className="text-lg font-black text-red-600">
                      {detail.grade.incorrect.length}
                    </div>
                    <div className="text-[10px] text-slate-500">خاطئة</div>
                  </div>
                  <div className="rounded-xl border p-3 text-center">
                    <div
                      className={`text-lg font-black ${
                        ambiguousInDetail > 0 ? 'text-amber-600' : 'text-slate-500'
                      }`}
                    >
                      {ambiguousInDetail}
                    </div>
                    <div className="text-[10px] text-slate-500">ملتبسة</div>
                  </div>
                </div>
              )}

              {/* student identity */}
              <div className="rounded-xl border p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-bold">
                  <UserCheck className="h-4 w-4 text-emerald-600" /> هوية الطالب
                </div>
                {detail.studentCode ? (
                  <div className="mb-2 text-xs text-slate-600">
                    المقروء من الفقاعات: <b>{detail.studentCode}</b>
                    {detail.studentId ? (
                      <span className="text-emerald-600"> — مرتبط بسجل طالب</span>
                    ) : (
                      <span className="text-amber-600"> — غير موجود في قاعدة البيانات</span>
                    )}
                  </div>
                ) : (
                  <div className="mb-2 text-xs text-amber-600">
                    لم يُقرأ رقم الطالب — أدخله يدويًا لربط الورقة.
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    value={linkCode}
                    onChange={(e) => setLinkCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="رقم الطالب (أرقام فقط)"
                    inputMode="numeric"
                    className="h-8 flex-1 text-sm"
                  />
                </div>
              </div>

              {/* answers with ratios + overrides */}
              <div>
                <div className="mb-2 text-sm font-bold">الإجابات المقروءة</div>
                {detail.answers.length === 0 ? (
                  <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
                    لا توجد إجابات مقروءة لهذه الورقة.
                  </div>
                ) : (
                  <div className="max-h-72 space-y-1.5 overflow-y-auto pl-1">
                    {detail.answers.map((a) => {
                      const override = overrides[String(a.number)];
                      const isCorrect = detail.grade?.correct.includes(a.number);
                      const isWrong = detail.grade?.incorrect.includes(a.number);
                      return (
                        <div
                          key={a.number}
                          className="flex items-center gap-3 rounded-lg border px-3 py-1.5"
                        >
                          <span className="w-8 text-sm font-bold text-slate-700">{a.number}</span>
                          <div className="flex flex-1 gap-1">
                            {Object.entries(a.ratios).map(([letter, ratio]) => (
                              <div key={letter} className="flex-1">
                                <div className="flex justify-between text-[9px] text-slate-400">
                                  <span>{letter}</span>
                                  <span>{Math.round(ratio * 100)}%</span>
                                </div>
                                <div className="h-1.5 rounded bg-slate-100">
                                  <div
                                    className={`h-1.5 rounded ${
                                      a.detected === letter && a.status === 'selected'
                                        ? 'bg-emerald-500'
                                        : ratio > 0.35
                                          ? 'bg-red-400'
                                          : 'bg-slate-300'
                                    }`}
                                    style={{ width: `${Math.min(100, ratio * 100)}%` }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                          <Badge className={statusMeta[a.status].cls}>
                            {statusMeta[a.status].label}
                          </Badge>
                          {isCorrect && (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                          )}
                          {isWrong && <ShieldX className="h-4 w-4 shrink-0 text-red-400" />}
                          <Select
                            value={override ?? ''}
                            onValueChange={(v) =>
                              setOverrides((o) => ({ ...o, [String(a.number)]: v }))
                            }
                          >
                            <SelectTrigger className="h-7 w-16 text-[10px]">
                              <SelectValue placeholder="تعديل" />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.keys(a.ratios).map((l) => (
                                <SelectItem key={l} value={l}>
                                  {l}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                )}
                {Object.keys(overrides).length > 0 && (
                  <div className="mt-1.5 text-[11px] text-amber-700">
                    {Object.keys(overrides).length} تعديل سيُطبَّق عند الاعتماد.
                  </div>
                )}
              </div>

              {/* debug images (best-effort; /tmp images may expire on serverless) */}
              {(detail.diagnostics.debugImage || detail.diagnostics.correctedImage) && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {detail.diagnostics.debugImage && (
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-slate-600">
                        الورقة مع مناطق الفقاعات:
                      </div>
                      <img
                        src={detail.diagnostics.debugImage}
                        alt="debug overlay"
                        className="w-full rounded-lg border"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    </div>
                  )}
                  {detail.diagnostics.correctedImage && (
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-slate-600">
                        بعد تصحيح المنظور:
                      </div>
                      <img
                        src={detail.diagnostics.correctedImage}
                        alt="corrected sheet"
                        className="w-full rounded-lg border"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* confidence + actions */}
              <div className="space-y-3">
                <div>
                  <div className="mb-1 flex justify-between text-[11px] text-slate-500">
                    <span>الثقة العامة</span>
                    <span>{Math.round((detail.overallConfidence ?? 0) * 100)}%</span>
                  </div>
                  <Progress value={(detail.overallConfidence ?? 0) * 100} className="h-1.5" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                    disabled={saving !== null}
                    onClick={() => void approve(true)}
                  >
                    {saving === 'approve' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <BadgeCheck className="h-4 w-4" />
                    )}
                    اعتماد الورقة{Object.keys(overrides).length > 0 ? ' مع التصحيحات' : ''}
                  </Button>
                  <Button
                    variant="destructive"
                    className="flex-1"
                    disabled={saving !== null}
                    onClick={() => void reject()}
                  >
                    {saving === 'reject' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldX className="h-4 w-4" />
                    )}
                    رفض الورقة
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
