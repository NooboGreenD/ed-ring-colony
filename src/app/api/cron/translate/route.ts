import { createAdminClient } from '@/lib/supabaseAdmin';
import { NextResponse } from 'next/server';
import { DEFAULT_TRANSLATE_LIMIT, translatePending } from '../../../../../scripts/lib/galnet-sync.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Vercel Cron присылает GET с User-Agent вида vercel-cron/1.0.
const VERCEL_CRON_USER_AGENT = 'vercel-cron/';

function isVercelCron(request: Request): boolean {
  const ua = request.headers.get('user-agent') || '';
  return ua.startsWith(VERCEL_CRON_USER_AGENT);
}

function isAuthorized(request: Request): boolean {
  if (isVercelCron(request)) return true;

  const authHeader = request.headers.get('authorization') || '';
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;
}

/**
 * Догоняет очередь переводов для `news` и `galnet_news`.
 * За раз обрабатывается ограниченная пачка, остаток дойдёт следующим запуском.
 */
async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
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
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
