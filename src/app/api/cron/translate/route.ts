import { hasTranslateCredentials } from '../../../../../scripts/lib/translate.mjs';
import { runCronTask } from '@/lib/cronAuth';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { NextResponse } from 'next/server';
import { DEFAULT_TRANSLATE_LIMIT, translatePending } from '../../../../../scripts/lib/galnet-sync.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Догоняет очередь переводов для `news` и `galnet_news`.
 * За раз обрабатывается ограниченная пачка, остаток дойдёт следующим запуском.
 */
async function handle(request: Request) {
  if (!hasTranslateCredentials()) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'Yandex Translate credentials not configured' });
  }

  const { searchParams } = new URL(request.url);
  const parsed = Number.parseInt(searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, 50)
    : DEFAULT_TRANSLATE_LIMIT;

  const supabase = createAdminClient();

  const result = await translatePending({
    supabase,
    tables: ['galnet_news', 'news'],
    limit,
    log: (message: string) => console.log('[cron/translate]', message),
  });

  return NextResponse.json(
    { success: result.ok, ...result },
    { status: result.ok ? 200 : 500 }
  );
}

export async function GET(request: Request) {
  return runCronTask(request, 'galnet-translation', () => handle(request));
}

export async function POST(request: Request) {
  return runCronTask(request, 'galnet-translation', () => handle(request));
}
