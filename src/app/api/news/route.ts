import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { translateAndSaveArticle } from '@/lib/translate';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* ───────────── GET (для фронта) ───────────── */
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

/* ───────────── POST (create + translate) ───────────── */
export async function POST(request: Request) {
  // ── auth ──
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createAdminClient();
  const out = { inserted: 0, translated: 0, errors: [] as string[] };

  // ═══════════════════════════════════════
  // 1. Parse incoming article
  // ═══════════════════════════════════════
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    title,
    body: articleBody,
    cover_url,
    published_at,
  } = payload || {};

  if (!title || !articleBody) {
    return NextResponse.json(
      { error: 'Fields "title" and "body" are required' },
      { status: 400 }
    );
  }

  // ═══════════════════════════════════════
  // 2. Insert new article
  // ═══════════════════════════════════════
  let insertedId: number | null = null;
  try {
    const { data: inserted, error: insErr } = await supabase
      .from('news')
      .insert({
        title: title.trim(),
        body: articleBody.trim(),
        cover_url: cover_url || null,
        published_at: published_at || new Date().toISOString(),
        translation_status: 'pending',
        translated_at: null,
      })
      .select('id')
      .single();

    if (insErr) throw insErr;
    insertedId = inserted?.id ?? null;
    out.inserted++;
  } catch (e: any) {
    console.error('[API /news] Insert error:', e);
    return NextResponse.json(
      { success: false, error: `Insert failed: ${e.message}` },
      { status: 500 }
    );
  }

  // ═══════════════════════════════════════
  // 3. Translate immediately
  // ═══════════════════════════════════════
  if (insertedId) {
    try {
      await translateAndSaveArticle('news', insertedId, title, articleBody, supabase);
      out.translated++;
    } catch (trErr: any) {
      out.errors.push(`translate:${insertedId}: ${trErr.message}`);
      await supabase
        .from('news')
        .update({ translation_status: 'failed' })
        .eq('id', insertedId);
    }
  }

  // ═══════════════════════════════════════
  // 4. Backfill old pending/failed articles
  // ═══════════════════════════════════════
  try {
    const { data: pending } = await supabase
      .from('news')
      .select('id, title, body')
      .eq('translation_status', 'pending')
      .limit(5);

    for (const article of pending || []) {
      try {
        await translateAndSaveArticle('news', article.id, article.title, article.body, supabase);
        out.translated++;
      } catch (trErr: any) {
        out.errors.push(`backfill:${article.id}: ${trErr.message}`);
        await supabase
          .from('news')
          .update({ translation_status: 'failed' })
          .eq('id', article.id);
      }
    }
  } catch (e: any) {
    out.errors.push(`backfill-query: ${e.message}`);
  }

  return NextResponse.json({
    success: true,
    articleId: insertedId,
    ...out,
  });
}
