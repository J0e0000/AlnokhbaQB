'use client';

import { useRouter } from 'next/navigation';
import OcrImport from '@/components/qb/OcrImport';

export default function ImportPage() {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6" dir="rtl">
      <h1 className="mb-4 text-2xl font-bold">استخراج النص واستيراده</h1>
      <OcrImport onCreated={(examId) => router.push(`/exams/${examId}/design`)} />
    </div>
  );
}
