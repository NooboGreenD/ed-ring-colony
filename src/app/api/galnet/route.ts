import { hasTranslateCredentials } from '../../../../scripts/lib/translate.mjs';
import { runCronTask } from '@/lib/cronAuth';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { NextResponse } from 'next/server';
import {
  DEFAULT_FEED_LIMIT,
  DEFAULT_TRANSLATE_LIMIT,
  countPendingTranslations,
  syncGalnet,
  translatePending,
} from '../../../../scripts/lib/galnet-sync.mjs';
import { localizedValue, missingTranslationLangs, safeContentLocale } from '@/lib/localizedContent';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
// Синхронизация + перевод могут занимать больше стандартных 10 секунд.
export const maxDuration = 60;

function intFrom(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/* ───────────── GET (для фронта) ───────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = safeContentLocale(searchParams.get('locale'));
  const limit = intFrom(searchParams.get('limit'), 100, 200);

  const supabase = await createClient();

  // `select('*')`, а не список title_<lang>/body_<lang>: на базе без миграции
  // переводов список колонок ронял весь запрос, и лента на сайте пустела.
  const { data: articles, error } = await supabase
    .from('galnet_news')
    .select('*')
    .order('published_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[galnet] select error:', error.message);
    return NextResponse.json({ articles: [], degraded: true, error: error.message });
  }

  const normalized = (articles || []).map((row: Record<string, unknown>) => ({
    id: row.id,
    nid: typeof row.nid === 'string' ? row.nid : null,
    slug: typeof row.slug === 'string' ? row.slug : null,
    title: localizedValue(row, 'title', locale),
    body: localizedValue(row, 'body', locale),
    image: typeof row.image === 'string' ? row.image : null,
    published_at: typeof row.published_at === 'string' ? row.published_at : null,
    translated: typeof row.translated_at === 'string',
    translationStatus: typeof row.translation_status === 'string' ? row.translation_status : null,
    missingLangs: missingTranslationLangs(row, ['title', 'body']),
  }));

  return NextResponse.json({ articles: normalized, locale }, { headers: { 'Cache-Control': 'no-store' } });
}

/* ───────────── POST (синхронизация + перевод) ───────────── */
async function sync(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = intFrom(searchParams.get('limit'), DEFAULT_FEED_LIMIT, 100);
  const translateLimit = intFrom(searchParams.get('translateLimit'), DEFAULT_TRANSLATE_LIMIT, 50);
  // Missing optional credentials must not turn a successful feed sync into
  // a permanent scheduler failure. The translate job reports an explicit skip.
  const withTranslate = searchParams.get('translate') !== '0' && hasTranslateCredentials();

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: `Supabase admin client unavailable: ${err?.message || err}` },
      { status: 500 }
    );
  }

  const result = await syncGalnet({
    supabase,
    limit,
    translate: withTranslate,
    translateLimit,
    log: (message: string) => console.log('[galnet]', message),
  });

  const pending = await countPendingTranslations(supabase, 'galnet_news');
  const translateConfigured = hasTranslateCredentials();
  if (!translateConfigured) {
    console.warn('[galnet] Yandex Translate credentials are not configured — articles stay pending');
  }

  return NextResponse.json(
    {
      success: result.ok && result.errors.length === 0,
      ...result,
      translateConfigured,
      pendingGalnetTranslations: pending,
    },
    { status: result.ok ? 200 : 502 }
  );
}

/* ───────────── PATCH (догон очереди переводов) ───────────── */
async function translate(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = intFrom(searchParams.get('limit'), DEFAULT_TRANSLATE_LIMIT, 50);

  const supabase = createAdminClient();
  const result = await translatePending({
    supabase,
    tables: ['galnet_news', 'news'],
    limit,
    log: (message: string) => console.log('[galnet]', message),
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function POST(request: Request) {
  return runCronTask(request, 'galnet-translation', () => sync(request));
}

export async function PATCH(request: Request) {
  return runCronTask(request, 'galnet-translation', () => translate(request));
}
