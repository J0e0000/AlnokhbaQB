import OmrStudioPane from '@/components/qb/OmrStudioPane';

export const metadata = { title: 'أوراق OMR — النخبة QB' };

export default async function OmrPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OmrStudioPane examId={id} />;
}
