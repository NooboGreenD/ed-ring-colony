import { createClient } from '@/lib/supabaseServer';
import { notFound } from 'next/navigation';
import CategoryPageClient from './CategoryPageClient';

export const revalidate = 30;

interface Props {
  params: { slug: string };
  searchParams: { page?: string };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const supabase = await createClient();
  const page = Math.max(1, parseInt(searchParams.page || '1'));
  const limit = 20;
  const offset = (page - 1) * limit;

  const { data: category } = await supabase
    .from('forum_categories')
    .select('*')
    .eq('slug', params.slug)
    .single();

  if (!category) notFound();

  const { data: threads, count } = await supabase
    .from('forum_threads')
    .select('*, forum_posts(count)', { count: 'exact' })
    .eq('category_id', category.id)
    .order('is_pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Загружаем профили отдельно
  const authorIds = [...new Set((threads || []).map((t: any) => t.author_id).filter(Boolean))];
  const { data: profilesData } = authorIds.length
    ? await supabase.from('profiles').select('id, cmdr_name, avatar_url').in('id', authorIds)
    : { data: [] };
  const profileMap = new Map((profilesData || []).map((p: any) => [p.id, p]));
  const threadsWithAuthors = (threads || []).map((t: any) => ({
    ...t,
    author: profileMap.get(t.author_id) ?? { cmdr_name: 'Unknown', avatar_url: null },
  }));

  return (
    <CategoryPageClient
      category={category}
      threads={threadsWithAuthors}
      totalCount={count || 0}
      page={page}
      limit={limit}
    />
  );
}
