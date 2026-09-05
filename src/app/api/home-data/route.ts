import { createClient } from '@/lib/supabaseServer';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SITE_CONTENT_TRANS_COLS = [
  'kicker', 'title1', 'title2', 'manifest',
  'footer_copyright', 'footer_discord', 'footer_edsm', 'footer_inara',
  'kicker_ru', 'kicker_en', 'kicker_de', 'kicker_it', 'kicker_ko', 'kicker_zh', 'kicker_ja',
  'title1_ru', 'title1_en', 'title1_de', 'title1_it', 'title1_ko', 'title1_zh', 'title1_ja',
  'title2_ru', 'title2_en', 'title2_de', 'title2_it', 'title2_ko', 'title2_zh', 'title2_ja',
  'manifest_ru', 'manifest_en', 'manifest_de', 'manifest_it', 'manifest_ko', 'manifest_zh', 'manifest_ja',
  'footer_copyright_ru', 'footer_copyright_en', 'footer_copyright_de', 'footer_copyright_it', 'footer_copyright_ko', 'footer_copyright_zh', 'footer_copyright_ja',
  'footer_discord_ru', 'footer_discord_en', 'footer_discord_de', 'footer_discord_it', 'footer_discord_ko', 'footer_discord_zh', 'footer_discord_ja',
  'footer_edsm_ru', 'footer_edsm_en', 'footer_edsm_de', 'footer_edsm_it', 'footer_edsm_ko', 'footer_edsm_zh', 'footer_edsm_ja',
  'footer_inara_ru', 'footer_inara_en', 'footer_inara_de', 'footer_inara_it', 'footer_inara_ko', 'footer_inara_zh', 'footer_inara_ja',
].join(',');

const SITE_CONTENT_BASIC_COLS = 'kicker,title1,title2,manifest,footer_copyright,footer_discord,footer_edsm,footer_inara';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = searchParams.get('locale') || 'ru';

  const supabase = await createClient();

  // Try with translation columns; fallback to basic columns if schema is missing them
  let c: any = null;
  const { data: cTrans, error: cTransErr } = await supabase
    .from('site_content')
    .select(SITE_CONTENT_TRANS_COLS)
    .eq('id', 1)
    .maybeSingle();

  if (cTransErr) {
    const { data: cBasic } = await supabase
      .from('site_content')
      .select(SITE_CONTENT_BASIC_COLS)
      .eq('id', 1)
      .maybeSingle();
    c = cBasic;
  } else {
    c = cTrans;
  }

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
