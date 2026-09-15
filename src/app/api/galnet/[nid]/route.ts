import { createClient } from '@/lib/supabaseServer';
import { NextResponse } from 'next/server';
import { SUPPORTED_TRANSLATION_LANGS } from '@/lib/translate';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Значение приходит из URL и подставляется в имя колонки — только белый список. */
const SAFE_LOCALES = new Set<string>(SUPPORTED_TRANSLATION_LANGS);

function safeLocale(value: string | null): string {
  const locale = (value || '').toLowerCase();
  return SAFE_LOCALES.has(locale) ? locale : 'en';
}

export async function GET(req: Request, { params }: { params: { nid: string } }) {
  const { searchParams } = new URL(req.url);
  const locale = safeLocale(searchParams.get('locale'));
  const nid = String(params?.nid || '').trim();

  if (!nid) return NextResponse.json({ item: null });

  const supabase = await createClient();

  let { data: item, error } = await supabase
    .from('galnet_news')
    .select('*')
    .eq('nid', nid)
    .maybeSingle();

  // Статью могут открыть по slug или по guid Galnet.
  if ((error || !item) && !/^[0-9a-f-]{36}$/i.test(nid)) {
    const byGuid = await supabase
      .from('galnet_news')
      .select('*')
      .eq('guid', nid)
      .maybeSingle();
    if (byGuid.data) {
      item = byGuid.data;
      error = null;
    } else {
      const bySlug = await supabase
        .from('galnet_news')
        .select('*')
        .eq('slug', nid)
        .maybeSingle();
      if (bySlug.data) {
        item = bySlug.data;
        error = null;
      }
    }
  }

  if (error || !item) {
    return NextResponse.json({ item: null });
  }

  const titleCol = `title_${locale}`;
  const bodyCol = `body_${locale}`;

  const normalized = {
    ...item,
    title: (item as any)[titleCol] || item.title || '',
    body: (item as any)[bodyCol] || item.body || '',
  };

  return NextResponse.json({ item: normalized });
}
