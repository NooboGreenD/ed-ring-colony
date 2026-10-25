import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';
import { createHash } from 'crypto';
import { ingestJournalBatch, JournalResetError, projectSyncSummary } from '@/lib/journalIngest';

// Current browser/desktop clients send 100 rows. Keep a 500-row allowance for
// older helpers, while preventing an unbounded legacy payload from turning one
// serverless request into many sequential database batches.
const MAX_DELIVERIES_PER_REQUEST = 500;
// Было 100, и клиент резал пачки именно по этому числу — но проверка на
// сервере отсутствовала вовсе: константа была объявлена и не использовалась.
// Пятьсот snapshots в запросе означают впятеро меньше HTTP-обращений при том
// же объёме, а внутри записи всё равно режутся по CONSTRUCTION_BATCH.
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

    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const deliveries = Array.isArray(body.deliveries) ? body.deliveries : [];
    const cmdr = typeof body.cmdr === 'string' ? body.cmdr.trim() : '';

    if (!token) {
      return NextResponse.json({ error: 'API token required' }, { status: 401 });
    }
    if (deliveries.length > MAX_DELIVERIES_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many deliveries in one request (max ${MAX_DELIVERIES_PER_REQUEST})` },
        { status: 413 },
      );
    }

    const constructionEvents = Array.isArray(body.construction_events)
      ? body.construction_events
      : (Array.isArray(body.constructionEvents) ? body.constructionEvents : []);
    const communityGoalReports = Array.isArray(body.community_goal_reports)
      ? body.community_goal_reports
      : (Array.isArray(body.communityGoalReports) ? body.communityGoalReports : []);
    if (constructionEvents.length > MAX_CONSTRUCTION_EVENTS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many construction events in one request (max ${MAX_CONSTRUCTION_EVENTS_PER_REQUEST})` },
        { status: 413 },
      );
    }
    if (communityGoalReports.length > MAX_CONSTRUCTION_EVENTS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many Community Goal reports in one request (max ${MAX_CONSTRUCTION_EVENTS_PER_REQUEST})` },
        { status: 413 },
      );
    }

    // Валидируем токен
    const tokenHash = hashToken(token);
    const { data: apiToken, error: tokenError } = await svc
      .from('api_tokens')
      .select('user_id, is_revoked')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (tokenError || !apiToken || apiToken.is_revoked) {
      return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 });
    }

    const userId = apiToken.user_id;

    // This timestamp is informative only; an unavailable update must never
    // make an otherwise valid Journal batch fail.
    void svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash);

    // Дальше — общий для сайта и Helper'а приём пачки (`src/lib/journalIngest.ts`):
    // полная перезагрузка по `reset: true` на первой пачке (маркер
    // `_reset_performed` в следующих не даёт стереть уже записанное), начальный
    // ник, доставки, телеметрия (снимки строек, сканы, сводка пилота — сводка
    // программы не перетирает загруженную через сайт) и реакции других
    // разделов (статусы систем в проектах эскадрилий). Сбой телеметрии не
    // превращает успешную загрузку в 500: Helper ретраит пачку на 5xx.
    let ingest;
    try {
      ingest = await ingestJournalBatch(svc, { userId, source: 'helper', cmdr, body, logTag: '[logs/upload]' });
    } catch (error) {
      if (error instanceof JournalResetError) {
        return NextResponse.json({ error: `Не удалось очистить старые логи: ${error.message}` }, { status: 500 });
      }
      throw error;
    }
    const outcome = ingest.deliveries;
    const telemetry = ingest.telemetry;
    const resetOutcome = ingest.reset;

    return NextResponse.json({
      ...outcome,
      constructionInserted: telemetry?.constructionInserted ?? 0,
      constructionDuplicates: telemetry?.constructionDuplicates ?? 0,
      communityGoalReportsStored: ingest.communityGoalReportsStored,
      communityGoalCatalogUpdated: ingest.communityGoalCatalogUpdated,
      snapshotInserted: telemetry?.snapshotInserted ?? 0,
      pilotStatsUpdated: telemetry?.pilotStatsUpdated ?? false,
      // 'web_source' — сводка пилота защищена загрузкой журналов на сайте
      pilotStatsSkipped: telemetry?.pilotStatsSkipped ?? null,
      systemScansInserted: telemetry?.systemScansInserted ?? 0,
      projects: projectSyncSummary(ingest.projects),
      reset: resetOutcome,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not import deliveries';
    console.error('[logs/upload] Failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
