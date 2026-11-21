'use client';

import { useRouter } from 'next/navigation';
import OmrPipeline from '@/components/qb/OmrPipeline';

export default function PipelinePage() {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6" dir="rtl">
      <OmrPipeline
        lang="ar"
        examId={null}
        onSelectExam={() => undefined}
        onChanged={() => undefined}
        onGoView={(v, examId) => {
          if (v === 'design' && examId) router.push(`/exams/${examId}/design`);
          else if (v === 'preview' && examId) router.push(`/exams/${examId}/preview`);
          else if (v === 'review') router.push('/review');
          else router.push('/scan');
        }}
      />
    </div>
  );
}
