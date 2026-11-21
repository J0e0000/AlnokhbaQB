import ReviewQueue from '@/components/qb/ReviewQueue';

export const metadata = { title: 'قائمة المراجعة — النخبة QB' };

export default function ReviewPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6" dir="rtl">
      <ReviewQueue />
    </div>
  );
}
