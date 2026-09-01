import { createClient } from '@/lib/supabaseServer';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = searchParams.get('locale') || 'ru';

  const supabase = await createClient();
  const { data: c } = await supabase
    .from('site_content')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  const { data: news } = await supabase
    .from('news')
    .select('id, title, body, cover_url, published_at, title_ru, body_ru, title_en, body_en, title_de, body_de, title_it, body_it, title_ko, body_ko, title_zh, body_zh, title_ja, body_ja')
    .order('published_at', { ascending: false })
    .limit(3);

  const { data: galnet } = await supabase
    .from('galnet_news')
    .select('id, nid, title, body, image, published_at, title_ru, body_ru, title_en, body_en, title_de, body_de, title_it, body_it, title_ko, body_ko, title_zh, body_zh, title_ja, body_ja')
    .order('published_at', { ascending: false })
    .limit(3);

  const { count: cmdrs } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true });
  const { count: systems } = await supabase
    .from('hubs')
    .select('id', { count: 'exact', head: true });
  const { count: built } = await supabase
    .from('hubs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'done');

  const titleCol = `title_${locale}`;
  const bodyCol = `body_${locale}`;
  const kickerCol = `kicker_${locale}`;
  const title1Col = `title1_${locale}`;
  const title2Col = `title2_${locale}`;
  const manifestCol = `manifest_${locale}`;

  const content = {
    kicker: (c as any)?.[kickerCol] || c?.kicker || '',
    title1: (c as any)?.[title1Col] || c?.title1 || '',
    title2: (c as any)?.[title2Col] || c?.title2 || '',
    manifest: (c as any)?.[manifestCol] || c?.manifest || '',
  };

  const normalizedNews = (news || []).map((n: any) => ({
    id: n.id,
    title: n[titleCol] || n.title || '',
    body: n[bodyCol] || n.body || '',
    cover_url: n.cover_url,
    published_at: n.published_at,
  }));

  const normalizedGalnet = (galnet || []).map((g: any) => ({
    id: g.id,
    nid: g.nid,
    title: g[titleCol] || g.title || '',
    body: g[bodyCol] || g.body || '',
    image: g.image,
    published_at: g.published_at,
  }));

  return NextResponse.json({
    content,
    news: normalizedNews,
    galnet: normalizedGalnet,
    cmdrs: cmdrs ?? 0,
    systems: systems ?? 0,
    built: built ?? 0,
  });
}
