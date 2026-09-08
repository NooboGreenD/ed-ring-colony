import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { translateAndSaveArticle } from '@/lib/translate';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const GALNET_API_URL = 'https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article?sort=-published_at&page[offset]=0&page[limit]=30';

/* ───────────── GET (для фронта) ───────────── */
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

/* ───────────── POST (sync + translate) ───────────── */
export async function POST(request: Request) {
  // ── auth ──
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createAdminClient();
  const out = {
    inserted: 0,
    translated: 0,
    skipped: 0,
    errors: [] as string[],
  };

  // ═══════════════════════════════════════
  // 1. Fetch fresh articles from Zaonce
  // ═══════════════════════════════════════
  let articles: any[] = [];
  try {
    const res = await fetch(GALNET_API_URL, {
      headers: { Accept: 'application/vnd.api+json' },
      next: { revalidate: 0 },
    });
    if (!res.ok) throw new Error(`Zaonce HTTP ${res.status}`);
    const json = await res.json();
    articles = json.data || [];
  } catch (err: any) {
    console.error('Galnet fetch error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 502 });
  }

  // ═══════════════════════════════════════
  // 2. Insert new + translate immediately
  // ═══════════════════════════════════════
  for (const item of articles) {
    try {
      const a = item.attributes || {};
      const nid = String(a.drupal_internal__nid || item.id);
      const title = (a.title || '').trim();
      const body = (a.body?.value || '').trim();
      const image = a.field_galnet_image
        ? `https://hosting.zaonce.net/elite-dangerous/galnet/${a.field_galnet_image}.png`
        : null;
      const publishedAt = a.published_at || a.field_galnet_date || new Date().toISOString();

      if (!nid || !title) continue;

      const { data: existing } = await supabase
        .from('galnet_news')
        .select('id')
        .eq('nid', nid)
        .maybeSingle();

      if (existing) {
        out.skipped++;
        continue;
      }

      // Insert
      const { data: inserted, error: insErr } = await supabase
        .from('galnet_news')
        .insert({
          nid,
          title,
          body,
          image,
          published_at: publishedAt,
          translation_status: 'pending',
          translated_at: null,
        })
        .select('id')
        .single();

      if (insErr) throw insErr;
      out.inserted++;

      // Translate immediately
      if (inserted?.id) {
        try {
          await translateAndSaveArticle('galnet_news', inserted.id, title, body, supabase);
          out.translated++;
        } catch (trErr: any) {
          out.errors.push(`translate:${nid}: ${trErr.message}`);
          await supabase
            .from('galnet_news')
            .update({ translation_status: 'failed' })
            .eq('id', inserted.id);
        }
      }
    } catch (e: any) {
      out.errors.push(`${item.id}: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════
  // 3. Backfill old pending/failed articles
  // ═══════════════════════════════════════
  try {
    const { data: pending } = await supabase
      .from('galnet_news')
      .select('id, title, body')
      .eq('translation_status', 'pending')
      .limit(5);

    for (const article of pending || []) {
      try {
        await translateAndSaveArticle(
          'galnet_news',
          article.id,
          article.title,
          article.body,
          supabase
        );
        out.translated++;
      } catch (trErr: any) {
        out.errors.push(`backfill:${article.id}: ${trErr.message}`);
        await supabase
          .from('galnet_news')
          .update({ translation_status: 'failed' })
          .eq('id', article.id);
      }
    }
  } catch (e: any) {
    out.errors.push(`backfill-query: ${e.message}`);
  }

  return NextResponse.json({
    success: true,
    processed: articles.length,
    ...out,
  });
}
