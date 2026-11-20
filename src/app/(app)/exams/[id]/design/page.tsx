import Designer from '@/components/qb/designer/Designer';

export const metadata = { title: 'التصميم — النخبة QB' };

export default async function DesignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Designer key={id} examId={id} />;
}
