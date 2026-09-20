import { createServiceClient } from '@/lib/supabaseServer';
import { notFound } from 'next/navigation';
import WikiHistoryClient from './WikiHistoryClient';

export const dynamic = 'force-dynamic';

export default async function WikiHistoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const resolvedParams = await params;
  const supabase = createServiceClient();
  const { data: article } = await supabase
    .from('wiki_articles')
    .select('id')
    .eq('slug', resolvedParams.slug)
    .eq('status', 'published')
    .maybeSingle();

  if (!article) return notFound();

  return <WikiHistoryClient params={resolvedParams} />;
}
