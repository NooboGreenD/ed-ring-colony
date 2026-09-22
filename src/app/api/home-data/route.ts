import { createClient } from '@/lib/supabaseServer';
import { localizedValue, safeContentLocale } from '@/lib/localizedContent';
import { footerFromContent } from '@/lib/siteFooter';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Row = Record<string, unknown>;
type QueryResult = { data: Row[] | null; error: { message: string } | null };

const text = (row: Row | null | undefined, key: string): string | null => {
  const value = row?.[key];
  return typeof value === 'string' ? value : null;
};

/**
 * Данные главной страницы: hero-текст (админка → «Контент»), новости, лента
 * Galnet и счётчики.
 *
 * Все запросы идут через `select('*')`. Раньше здесь перечислялись колонки
 * переводов (`title_ru`, `footer_edsm_ja`, …), и на базе, где миграция
 * переводов не применена, падал весь запрос: главный экран молча откатывался к
 * базовым колонкам (которые админка не пишет), а блок Galnet пустовал. Это и
 * выглядело как «правки в админке не появляются» и «на главной нет Galnet».
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = safeContentLocale(searchParams.get('locale'));

  const supabase = await createClient();

  const [siteResult, newsResult, galnetResult, profilesResult, hubsResult, doneResult] = await Promise.all([
    supabase.from('site_content').select('*').eq('id', 1).maybeSingle(),
    supabase.from('news').select('*').order('published_at', { ascending: false }).limit(3),
    supabase.from('galnet_news').select('*').order('published_at', { ascending: false }).limit(3),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('hubs').select('id', { count: 'exact', head: true }),
    supabase.from('hubs').select('id', { count: 'exact', head: true }).eq('status', 'done'),
  ] as const);

  const degraded: string[] = [];
  for (const [label, result] of [['news', newsResult], ['galnet', galnetResult]] as const) {
    if (result.error) {
      console.error(`[home-data] ${label}:`, result.error.message);
      degraded.push(label);
    }
  }
  if (siteResult.error) {
    console.error('[home-data] site_content:', siteResult.error.message);
    degraded.push('site_content');
  }

  const site = (siteResult.data as Row | null) ?? null;
  const content = {
    kicker: localizedValue(site, 'kicker', locale),
    title1: localizedValue(site, 'title1', locale) || 'ED Ring Colony',
    title2: localizedValue(site, 'title2', locale) || 'The Galaxy Ring Project',
    manifest: localizedValue(site, 'manifest', locale),
  };

  const normalize = (rows: Row[], withImage: boolean) => (rows || []).map((row) => ({
    id: row.id,
    ...(withImage ? { nid: text(row, 'nid') ?? null } : {}),
    title: localizedValue(row, 'title', locale),
    body: localizedValue(row, 'body', locale),
    cover_url: text(row, 'cover_url'),
    image: withImage ? text(row, 'image') : null,
    published_at: text(row, 'published_at'),
  }));

  return NextResponse.json(
    {
      content,
      footer: footerFromContent(site, locale),
      news: normalize((newsResult.data ?? []) as Row[], false),
      galnet: normalize((galnetResult.data ?? []) as Row[], true),
      cmdrs: profilesResult.count ?? 0,
      systems: hubsResult.count ?? 0,
      built: doneResult.count ?? 0,
      updatedAt: text(site, 'updated_at'),
      ...(degraded.length ? { degraded } : {}),
    },
    // Без этого заголовка ответ могла удержать кровка/прокси, и главная
    // отдавала бы старый контент даже после удачного сохранения в админке.
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
