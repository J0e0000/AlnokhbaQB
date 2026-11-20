'use client';

import { useRouter } from 'next/navigation';
import BankPane from '@/components/qb/BankPane';

export default function BankPage() {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6" dir="rtl">
      <BankPane onExamCreated={(examId) => router.push(`/exams/${examId}/design`)} />
    </div>
  );
}
