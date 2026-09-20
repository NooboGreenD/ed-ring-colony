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
import { SUPPORTED_TRANSLATION_LANGS } from '@/lib/translate';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
// Синхронизация + перевод могут занимать больше стандартных 10 секунд.
export const maxDuration = 60;

/** Белый список локалей: значение приходит из query и подставляется в имя колонки. */
const SAFE_LOCALES = new Set<string>(SUPPORTED_TRANSLATION_LANGS);

function safeLocale(value: string | null): string {
  const locale = (value || '').toLowerCase();
  return SAFE_LOCALES.has(locale) ? locale : 'en';
}

function intFrom(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/* ───────────── GET (для фронта) ───────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locale = safeLocale(searchParams.get('locale'));
  const limit = intFrom(searchParams.get('limit'), 100, 200);

  const supabase = await createClient();

  const columns = [
    'id',
    'nid',
    'slug',
    'image',
    'published_at',
    'title',
    'body',
    'translated_at',
    'translation_status',
  ];
  for (const lang of SUPPORTED_TRANSLATION_LANGS) {
    columns.push(`title_${lang}`, `body_${lang}`);
  }

  const { data: articles, error } = await supabase
    .from('galnet_news')
    .select(columns.join(', '))
    .order('published_at', { ascending: false })
    .limit(limit);

  if (error) {
    // Расширенные колонки могут отсутствовать — отдаём базовый набор.
    console.error('[galnet] select error:', error.message);
    const { data: fallbackArticles } = await supabase
      .from('galnet_news')
      .select('id, nid, title, body, image, published_at')
      .order('published_at', { ascending: false })
      .limit(limit);

    return NextResponse.json({ articles: fallbackArticles || [], degraded: true });
  }

  const titleCol = `title_${locale}`;
  const bodyCol = `body_${locale}`;

  const normalized = (articles || []).map((a: any) => ({
    id: a.id,
    nid: a.nid,
    slug: a.slug ?? null,
    title: a[titleCol] ?? a.title ?? '',
    body: a[bodyCol] ?? a.body ?? '',
    image: a.image,
    published_at: a.published_at,
    translated: !!a.translated_at,
    translationStatus: a.translation_status ?? null,
  }));

  return NextResponse.json({ articles: normalized });
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

  return NextResponse.json(
    {
      success: result.ok && result.errors.length === 0,
      ...result,
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
