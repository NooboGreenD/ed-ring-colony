import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';
import { createHash } from 'crypto';
import { ingestJournalBatch, JournalResetError, projectSyncSummary } from '@/lib/journalIngest';

// Current browser/desktop clients send 100 rows. Keep a 500-row allowance for
// older helpers, while preventing an unbounded legacy payload from turning one
// serverless request into many sequential database batches.
const MAX_DELIVERIES_PER_REQUEST = 500;
// Тот же лимит, что и в /api/logs/upload: браузер режет пачки snapshots по 500,
// а без проверки ничто не мешает прислать неограниченное количество строк и
// превратить один serverless-запрос в длинную цепочку записей в базу.
const MAX_CONSTRUCTION_EVENTS_PER_REQUEST = 500;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getAdminClient() {
  const url = getServerSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Server delivery-import credentials are not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const dynamic = 'force-dynamic';
// A large Journal is intentionally uploaded as many small requests. Allow one
// request enough wall-clock time for auth plus bounded database operations.
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const svc = getAdminClient();

    let body: Record<string, unknown> = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const deliveries = Array.isArray(body.deliveries) ? body.deliveries : [];
    if (deliveries.length > MAX_DELIVERIES_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many deliveries in one request (max ${MAX_DELIVERIES_PER_REQUEST})` },
        { status: 413 },
      );
    }
    const constructionEvents = Array.isArray(body.constructionEvents)
      ? body.constructionEvents
      : (Array.isArray(body.construction_events) ? body.construction_events : []);
    if (constructionEvents.length > MAX_CONSTRUCTION_EVENTS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many construction events in one request (max ${MAX_CONSTRUCTION_EVENTS_PER_REQUEST})` },
        { status: 413 },
      );
    }

    const cmdr = typeof body.cmdr === 'string' ? body.cmdr.trim() : '';

    // Поддержка двух способов авторизации:
    // 1. API token (для Colonial Helper)
    // 2. Bearer token из Supabase session (для браузерной загрузки)
    let userId: string | null = null;
    // Источник загрузки: сессия — сайт, API-токен — программа. От него
    // зависит приоритет сводки пилота (данные программы не перетирают
    // данные, загруженные через сайт).
    let source: 'web' | 'helper' = 'web';

    const authHeader = req.headers.get('authorization') || '';
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const apiTokenStr = typeof body.token === 'string' ? body.token.trim() : '';

    if (bearerToken) {
      // Валидация Supabase session token
      const { data: { user }, error } = await svc.auth.getUser(bearerToken);
      if (error || !user) {
        return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
      }
      userId = user.id;
    } else if (apiTokenStr) {
      // Валидация API token (для Colonial Helper)
      const tokenHash = hashToken(apiTokenStr);
      const { data: apiToken, error: tokenError } = await svc
        .from('api_tokens')
        .select('user_id, is_revoked')
        .eq('token_hash', tokenHash)
        .maybeSingle();

      if (tokenError || !apiToken || apiToken.is_revoked) {
        return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 });
      }
      userId = apiToken.user_id;
      source = 'helper';
      // Обновляем last_used_at для API token. Do not make a successful upload
      // fail only because this non-critical bookkeeping update is delayed.
      void svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash);
    } else {
      return NextResponse.json({ error: 'API token or session required' }, { status: 401 });
    }

    if (!userId) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
    }

    // Дальше — тот же приём пачки, что у Colonial Helper (`src/lib/journalIngest.ts`):
    // полная перезагрузка по `reset: true` на первой пачке (поставки, импорты,
    // сводка пилота, сканы тел; маркер `_reset_performed` защищает следующие
    // пачки), начальный ник, доставки, телеметрия и реакции других разделов
    // (статусы систем в проектах эскадрилий). Браузерный загрузчик кладёт в
    // базу ровно то же, что и десктопный помощник.
    let ingest;
    try {
      ingest = await ingestJournalBatch(svc, { userId, source, cmdr, body, logTag: '[logs/import]' });
    } catch (error) {
      if (error instanceof JournalResetError) {
        return NextResponse.json({ error: `Не удалось очистить старые данные: ${error.message}` }, { status: 500 });
      }
      throw error;
    }
    const outcome = ingest.deliveries;
    const telemetry = ingest.telemetry;
    const resetOutcome = ingest.reset;

    return NextResponse.json({
      ...outcome,
      telemetry,
      reset: resetOutcome,
      projects: projectSyncSummary(ingest.projects),
      communityGoalReportsStored: ingest.communityGoalReportsStored,
      communityGoalCatalogUpdated: ingest.communityGoalCatalogUpdated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not import deliveries';
    console.error('[logs/import] Failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
