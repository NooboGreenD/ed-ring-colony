import { createClient } from '@/lib/supabaseServer';
import WikiHome from '@/components/Wiki/WikiHome';

export const dynamic = 'force-dynamic';

export default async function WikiPage() {
  const supabase = await createClient();

  const { data: categories } = await supabase
    .from('wiki_categories')
    .select('id, name, slug, description, sort_order')
    .order('sort_order', { ascending: true });

  const { data: featured } = await supabase
    .from('wiki_articles')
    .select('id, title, slug, view_count, updated_at, category_id')
    .eq('status', 'published')
    .eq('is_featured', true)
    .limit(3);

  const { data: recent } = await supabase
    .from('wiki_articles')
    .select('id, title, slug, updated_at, category_id')
    .eq('status', 'published')
    .order('updated_at', { ascending: false })
    .limit(8);

  // Load category names for recent
  const catIds = [...new Set((recent || []).map((a: any) => a.category_id).filter(Boolean))];
  const { data: catData } = catIds.length
    ? await supabase.from('wiki_categories').select('id, name, slug').in('id', catIds)
    : { data: [] };
  const catMap = new Map((catData || []).map((c: any) => [c.id, c]));

  // Count articles per category
  const { data: articleCounts } = await supabase
    .from('wiki_articles')
    .select('category_id')
    .eq('status', 'published');
  const countMap = new Map<number, number>();
  (articleCounts || []).forEach((a: any) => {
    countMap.set(a.category_id, (countMap.get(a.category_id) || 0) + 1);
  });

  const { count: totalArticles } = await supabase.from('wiki_articles').select('*', { count: 'exact', head: true }).eq('status', 'published');
  const { count: totalCategories } = await supabase.from('wiki_categories').select('*', { count: 'exact', head: true });

  const counts: Record<string, number> = {};
  countMap.forEach((value, key) => {
    counts[String(key)] = value;
  });

  const catNames: Record<string, { name: string; slug: string }> = {};
  catMap.forEach((cat: any, key: any) => {
    if (cat) catNames[String(key)] = { name: cat.name, slug: cat.slug };
  });

  return (
    <WikiHome
      categories={(categories || []) as any}
      featured={(featured || []) as any}
      recent={(recent || []) as any}
      catNames={catNames}
      counts={counts}
      totalArticles={totalArticles || 0}
      totalCategories={totalCategories || 0}
    />
  );
}
