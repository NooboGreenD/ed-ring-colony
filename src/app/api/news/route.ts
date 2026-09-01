import { createClient } from '@/lib/supabaseServer';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = searchParams.get('locale') || 'ru';

  const supabase = await createClient();

  const { data: news, error } = await supabase
    .from('news')
    .select('id, title, body, cover_url, published_at, title_ru, body_ru, title_en, body_en, title_de, body_de, title_it, body_it, title_ko, body_ko, title_zh, body_zh, title_ja, body_ja')
    .order('published_at', { ascending: false });

  if (error) {
    console.error('[API /news] Supabase error:', error.message);
    return NextResponse.json({ news: [], error: error.message });
  }

  const titleCol = `title_${locale}`;
  const bodyCol = `body_${locale}`;

  const normalized = (news || []).map((n: any) => ({
    id: n.id,
    title: n[titleCol] || n.title || '',
    body: n[bodyCol] || n.body || '',
    cover_url: n.cover_url,
    published_at: n.published_at,
  }));

  return NextResponse.json({ news: normalized });
}
