import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { translateAndSaveArticle } from '@/lib/translate';
import { localizedValue, safeContentLocale } from '@/lib/localizedContent';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* ───────────── GET (для фронта) ───────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = safeContentLocale(searchParams.get('locale'));

  const supabase = await createClient();

  // Колонки переводов перечислять руками нельзя: стоит миграции с новым
  // языком не примениться — и весь фид падает в пустоту. `*` плюс выбор
  // значения по факту наличия колонок (см. localizedContent).
  const { data: news, error } = await supabase
    .from('news')
    .select('*')
    .order('published_at', { ascending: false });

  if (error) {
    console.error('[API /news] Supabase error:', error.message);
    return NextResponse.json({ news: [], error: error.message });
  }

  const normalized = (news || []).map((n: any) => ({
    id: n.id,
    title: localizedValue(n, 'title', locale),
    body: localizedValue(n, 'body', locale),
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
      // 'partial' и 'failed' тоже надо догонять, иначе одна неудачная пачка
      // навсегда оставляет статьи без переводов.
      .in('translation_status', ['pending', 'partial', 'failed'])
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
