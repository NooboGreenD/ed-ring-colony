import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { hasTranslateCredentials } from '@/lib/translate';
import {
  countPendingTranslations,
  syncGalnet,
  translatePending,
} from '../../../../../scripts/lib/galnet-sync.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Лента + перевод пачки статей заведомо дольше стандартных 10 секунд.
export const maxDuration = 60;

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

function intParam(url: URL, key: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(url.searchParams.get(key) || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Админский пуск пайплайна контента: «синхронизировать Galnet сейчас» и
 * «догнать очередь переводов». Планировщик (`jobs`) крутит то же самое по
 * расписанию, но при разборе «почему на сайте нет переводов» ждать слот
 * неудобно. Запросы идут тем же кодом, что и крон: scripts/lib/galnet-sync.mjs.
 */
async function handle(request: Request) {
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;

  const url = new URL(request.url);
  const action = (url.searchParams.get('action') || 'sync').toLowerCase();
  const limit = intParam(url, 'limit', 12, 30);
  const translateLimit = intParam(url, 'translateLimit', 4, 20);

  let supabase;
  try {
    supabase = createAdminClient();
  } catch {
    return NextResponse.json(
      { success: false, error: 'SUPABASE_SERVICE_ROLE_KEY не задан — админский пайплайн недоступен' },
      { status: 500, ...NO_STORE },
    );
  }

  if (!hasTranslateCredentials()) {
    return NextResponse.json(
      {
        success: false,
        error: 'YANDEX_TRANSLATE_API_KEY не задан: статьи будут собраны, но переводы останутся в статусе pending',
        translateConfigured: false,
      },
      { status: 412, ...NO_STORE },
    );
  }

  if (action === 'queue') {
    const galnet = await countPendingTranslations(supabase, 'galnet_news');
    const news = await countPendingTranslations(supabase, 'news');
    return NextResponse.json({ success: true, pending: { galnet_news: galnet, news } }, NO_STORE);
  }

  if (action === 'translate') {
    const result = await translatePending({
      supabase,
      tables: ['galnet_news', 'news'],
      limit: translateLimit,
      log: (message: string) => console.log('[admin/content]', message),
    });
    return NextResponse.json(
      { success: result.ok, ...result, pendingGalnetTranslations: await countPendingTranslations(supabase, 'galnet_news') },
      { status: result.ok ? 200 : 500, ...NO_STORE },
    );
  }

  const result = await syncGalnet({
    supabase,
    limit,
    translateLimit,
    log: (message: string) => console.log('[admin/content]', message),
  });
  return NextResponse.json(
    {
      success: result.ok,
      ...result,
      pendingGalnetTranslations: await countPendingTranslations(supabase, 'galnet_news'),
    },
    { status: result.ok ? 200 : 502, ...NO_STORE },
  );
}

export async function POST(request: Request) {
  try {
    return await handle(request);
  } catch (error) {
    console.error('[admin/content] failed', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { success: false, error: 'Пайплайн контента завершился с ошибкой; подробности в журнале web' },
      { status: 500, ...NO_STORE },
    );
  }
}

export async function GET(request: Request) {
  // Тот же обработчик: GET удобнее для «проверить очередь».
  return handle(request);
}
