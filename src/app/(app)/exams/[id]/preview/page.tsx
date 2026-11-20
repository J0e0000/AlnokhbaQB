import PreviewPane from '@/components/qb/PreviewPane';

export const metadata = { title: 'المعاينة — النخبة QB' };

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PreviewPane examId={id} />;
}
