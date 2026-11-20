'use client';

// ============================================================
// Exam workspace shell — header (Amiri title) + stage stepper.
// The ONLY numbered sequence in the product: it mirrors the real
// print order (design → preview → OMR sheets). Loads the exam
// detail client-side; stage pages render as children.
// ============================================================

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { t } from '@/lib/ui/strings';

interface ExamMeta {
  id: string;
  title: string;
  status: string;
  questionCount: number;
}

const STAGES = [
  { seg: 'design', label: t('stageDesign'), num: '١' },
  { seg: 'preview', label: t('stagePreview'), num: '٢' },
  { seg: 'omr', label: t('stageOmr'), num: '٣' },
];

export default function ExamWorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pathname = usePathname();
  const router = useRouter();
  const [exam, setExam] = useState<ExamMeta | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/exams/${id}`);
        if (!res.ok) {
          if (!cancelled) setMissing(true);
          return;
        }
        const data = await res.json();
        if (!cancelled && data?.exam) setExam(data.exam);
        else if (!cancelled) setMissing(true);
      } catch {
        if (!cancelled) setMissing(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const currentSeg = pathname.split('/')[3] ?? 'design';

  if (missing) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center" dir="rtl">
        <h1 className="text-xl font-bold">الامتحان غير موجود</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          ربما تمت أرشفته أو أن الرابط غير صحيح — افتح صفحة الامتحانات واختر الامتحان من الجدول.
        </p>
        <button className="mt-4 inline-flex items-center gap-1 text-[15px] font-medium text-primary hover:underline" onClick={() => router.push('/exams')}>
          <ArrowRight className="h-4 w-4" /> رجوع إلى الامتحانات
        </button>
      </div>
    );
  }

  return (
    <div dir="rtl">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto w-full max-w-6xl px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/exams"
              aria-label="رجوع إلى الامتحانات"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <ArrowRight className="h-4 w-4" />
            </Link>
            <div className="min-w-0">
              <h1 className="truncate font-print text-xl font-bold leading-tight">
                {exam?.title ?? '…'}
              </h1>
              {exam && (
                <p className="tabular-nums text-[13px] text-muted-foreground">
                  {exam.questionCount} سؤال · {exam.status === 'PUBLISHED' ? t('statusPublished') : t('statusDraft')}
                </p>
              )}
            </div>
          </div>
          <nav className="mt-2 flex gap-1" aria-label="مراحل الامتحان">
            {STAGES.map((stage) => {
              const active = currentSeg === stage.seg;
              return (
                <Link
                  key={stage.seg}
                  href={`/exams/${id}/${stage.seg}`}
                  aria-current={active ? 'step' : undefined}
                  className={`flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5 text-[15px] transition-colors ${
                    active
                      ? 'bg-primary/10 font-medium text-foreground shadow-[inset_0_-2px_0_0_var(--brass)]'
                      : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  <span className="tabular-nums text-[13px] text-primary" aria-hidden>{stage.num}</span>
                  {stage.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
