import { createClient } from '@/lib/supabaseServer';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = searchParams.get('locale') || 'en';

  const supabase = await createClient();

  const titleCol = `title_${locale}`;
  const bodyCol = `body_${locale}`;

  const { data: articles, error } = await supabase
    .from('galnet_news')
    .select(`id, nid, ${titleCol}, ${bodyCol}, image, published_at, title, body, translated_at, translation_status`)
    .order('published_at', { ascending: false });

  if (error) {
    console.error('Galnet select error:', error.message);
    const { data: fallbackArticles } = await supabase
      .from('galnet_news')
      .select('id, nid, title, body, image, published_at')
      .order('published_at', { ascending: false });
    
    return NextResponse.json({ articles: fallbackArticles || [] });
  }

  const normalized = (articles || []).map((a: any) => ({
    id: a.id,
    nid: a.nid,
    title: a[titleCol] ?? a.title ?? '',
    body: a[bodyCol] ?? a.body ?? '',
    image: a.image,
    published_at: a.published_at,
    translated: !!a.translated_at,
    translationStatus: a.translation_status,
  }));

  return NextResponse.json({ articles: normalized });
}
