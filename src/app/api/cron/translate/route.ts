import { createAdminClient } from '@/lib/supabaseAdmin';
import { translateAndSaveArticle } from '@/lib/translate';
import { NextResponse } from 'next/server';

// Vercel Cron sends a simple GET request with a custom User-Agent.
// We check the User-Agent to verify the request comes from Vercel.
const VERCEL_CRON_USER_AGENT = 'vercel-cron/1.0';

function isVercelCron(request: Request): boolean {
  const ua = request.headers.get('user-agent') || '';
  return ua.startsWith(VERCEL_CRON_USER_AGENT);
}

export async function GET(request: Request) {
  // Verify this is a legitimate Vercel Cron request
  if (!isVercelCron(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createAdminClient();
  const results = { processed: 0, errors: [] as string[] };

  // Обрабатываем news
  const { data: pendingNews } = await supabase
    .from('news')
    .select('id, title, body')
    .eq('translation_status', 'pending')
    .or('translated_at.is.null')
    .limit(5);

  for (const article of pendingNews || []) {
    try {
      await translateAndSaveArticle('news', article.id, article.title, article.body, supabase);
      results.processed++;
    } catch (err: any) {
      results.errors.push(`news:${article.id}: ${err.message}`);
      await supabase
        .from('news')
        .update({ translation_status: 'failed' })
        .eq('id', article.id);
    }
  }

  // Обрабатываем galnet_news
  const { data: pendingGalnet } = await supabase
    .from('galnet_news')
    .select('id, title, body')
    .eq('translation_status', 'pending')
    .or('translated_at.is.null')
    .limit(5);

  for (const article of pendingGalnet || []) {
    try {
      await translateAndSaveArticle('galnet_news', article.id, article.title, article.body, supabase);
      results.processed++;
    } catch (err: any) {
      results.errors.push(`galnet:${article.id}: ${err.message}`);
      await supabase
        .from('galnet_news')
        .update({ translation_status: 'failed' })
        .eq('id', article.id);
    }
  }

  return NextResponse.json(results);
}

// Keep POST for manual/external triggers with Bearer token
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createAdminClient();
  const results = { processed: 0, errors: [] as string[] };

  const { data: pendingNews } = await supabase
    .from('news')
    .select('id, title, body')
    .eq('translation_status', 'pending')
    .or('translated_at.is.null')
    .limit(5);

  for (const article of pendingNews || []) {
    try {
      await translateAndSaveArticle('news', article.id, article.title, article.body, supabase);
      results.processed++;
    } catch (err: any) {
      results.errors.push(`news:${article.id}: ${err.message}`);
      await supabase.from('news').update({ translation_status: 'failed' }).eq('id', article.id);
    }
  }

  const { data: pendingGalnet } = await supabase
    .from('galnet_news')
    .select('id, title, body')
    .eq('translation_status', 'pending')
    .or('translated_at.is.null')
    .limit(5);

  for (const article of pendingGalnet || []) {
    try {
      await translateAndSaveArticle('galnet_news', article.id, article.title, article.body, supabase);
      results.processed++;
    } catch (err: any) {
      results.errors.push(`galnet:${article.id}: ${err.message}`);
      await supabase.from('galnet_news').update({ translation_status: 'failed' }).eq('id', article.id);
    }
  }

  return NextResponse.json(results);
}