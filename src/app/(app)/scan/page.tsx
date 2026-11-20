import ScanStudio from '@/components/qb/ScanStudio';

export const metadata = { title: 'مسح وتصحيح — النخبة QB' };

export default function ScanPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6" dir="rtl">
      <h1 className="mb-4 text-2xl font-bold">مسح وتصحيح</h1>
      <ScanStudio />
    </div>
  );
}
