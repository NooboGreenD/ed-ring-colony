import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { createServiceClient } from '@/lib/supabaseServer';
import { galaxyDownloadSegments } from '@/lib/galaxyImport';
import {
  BGS_KEEP_DAYS,
  bgsArchiveInfo,
  bgsArchiveKeep,
  bgsBatchSize,
  bgsDumpUrl,
  bgsMinSystems,
  bgsRefreshDays,
  bgsSyncInterrupted,
  cancelBgsSync,
  cleanupBgsArchive,
  decideBgsScheduledSync,
  getBgsLastRun,
  getBgsLiveRun,
  isBgsSyncRunning,
  nextBgsScheduledRun,
  readBgsSummary,
  readBgsSyncState,
  startBgsSync,
} from '@/lib/bgsSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-store' };

interface UpdateRow {
  received_at: string;
  user_id: string | null;
  source: string;
  received: number;
  applied: number;
  stale: number;
  created: number;
  invalid: number;
  systems: string[] | null;
}

/** Последние пачки от пилотов с именами командиров (если таблица профилей доступна). */
async function readRecentUpdates(svc: any): Promise<Array<Omit<UpdateRow, 'user_id'> & { cmdr: string | null }>> {
  const { data, error } = await svc
    .from('bgs_updates')
    .select('received_at, user_id, source, received, applied, stale, created, invalid, systems')
    .order('received_at', { ascending: false })
    .limit(15);
  if (error || !Array.isArray(data)) return [];
  const rows = data as UpdateRow[];
  const ids = Array.from(new Set(rows.map((row) => row.user_id).filter((id): id is string => typeof id === 'string')));
  const names = new Map<string, string>();
  if (ids.length > 0) {
    try {
      const { data: profiles } = await svc.from('profiles').select('id, cmdr_name').in('id', ids);
      for (const profile of Array.isArray(profiles) ? profiles : []) {
        if (profile?.id && typeof profile.cmdr_name === 'string' && profile.cmdr_name) names.set(profile.id, profile.cmdr_name);
      }
    } catch {
      // без имён — только счётчики
    }
  }
  return rows.map(({ user_id: userId, ...row }) => ({
    ...row,
    systems: Array.isArray(row.systems) ? row.systems : [],
    cmdr: userId ? names.get(userId) ?? null : null,
  }));
}

/**
 * Админка → Игровые данные → Фракции: управление данными о минорных фракциях.
 *
 * GET — состояние для панели: идёт ли импорт дампа EDSM (этапы, проценты,
 * журнал), что лежит в базе (системы, фракции, источники, свежесть),
 * обновления от пилотов (Colonial Helper и загрузчик журналов на сайте),
 * архив на диске и настройки.
 *
 * POST:
 *   * `{ action: 'start' }`              — загрузить дамп сейчас (тот же дамп,
 *                                          что в прошлый раз, не качается);
 *   * `{ action: 'start', force: true }` — импортировать заново, даже если дамп
 *                                          тот же, и принять «усохший»;
 *   * `{ action: 'cancel' }`             — остановить импорт (скачанное
 *                                          остаётся на диске для докачки);
 *   * `{ action: 'cleanup' }`            — удалить скачанный архив с диска.
 */
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  const nowMs = Date.now();
  try {
    const svc = createServiceClient();
    const state = await readBgsSyncState(svc);
    let summary = null;
    let summaryError: string | null = null;
    try {
      summary = await readBgsSummary(svc);
    } catch (error) {
      summaryError = `Сводка недоступна: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
    }
    const updates = await readRecentUpdates(svc).catch(() => []);
    const live = getBgsLiveRun();
    const last = live ?? getBgsLastRun();
    const running = isBgsSyncRunning() || Boolean(live);
    const persisted = state.progress;
    const progress = last?.progress && (!persisted || Date.parse(last.progress.startedAt) >= Date.parse(persisted.startedAt))
      ? last.progress
      : persisted;
    const log = last?.log?.length ? last.log : state.log;
    const decision = decideBgsScheduledSync(state, { nowMs });
    return NextResponse.json(
      {
        success: true,
        running,
        interrupted: !running && bgsSyncInterrupted(state, nowMs),
        progress,
        log,
        state: {
          status: state.status,
          source_url: state.source_url,
          etag: state.etag,
          last_modified: state.last_modified,
          dump_generated_at: state.dump_generated_at,
          dump_bytes: state.dump_bytes,
          run_id: state.run_id,
          systems_total: state.systems_total,
          factions_total: state.factions_total,
          presence_total: state.presence_total,
          stats: state.stats,
          error: state.error,
          attempt_at: state.attempt_at,
          checked_at: state.checked_at,
          synced_at: state.synced_at,
        },
        summary,
        summaryError,
        updates,
        archive: bgsArchiveInfo(),
        config: {
          dumpUrl: bgsDumpUrl(),
          archiveKeep: bgsArchiveKeep(),
          segments: galaxyDownloadSegments(),
          batchSize: bgsBatchSize(),
          minSystems: bgsMinSystems(),
          keepDays: BGS_KEEP_DAYS,
          refreshDays: bgsRefreshDays(),
          nextScheduledRun: nextBgsScheduledRun(nowMs),
          scheduleDecision: decision,
        },
        serverTime: new Date(nowMs).toISOString(),
      },
      { headers },
    );
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    console.error('[admin/factions]', message);
    const missing = /bgs_sync_state|schema cache|does not exist/i.test(message);
    return NextResponse.json(
      {
        success: false,
        error: missing
          ? 'Таблиц фракций нет в базе: примените миграцию 20261019120000_minor_factions.sql (deploy/update-project.sh делает это сам)'
          : `Не удалось прочитать состояние фракций: ${message.slice(0, 300)}`,
      },
      { status: 503, headers },
    );
  }
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  let body: { action?: unknown; force?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'start') {
    let svc;
    try {
      svc = createServiceClient();
    } catch (error) {
      return NextResponse.json({ success: false, error: `Нет подключения к базе: ${String((error as Error)?.message ?? error).slice(0, 200)}` }, { status: 503, headers });
    }
    const result = startBgsSync(svc, { force: body.force === true, trigger: 'admin' });
    if (!result.started) {
      return NextResponse.json({ success: false, started: false, reason: result.reason }, { status: 409, headers });
    }
    return NextResponse.json({ success: true, started: true, force: body.force === true }, { headers });
  }
  if (action === 'cancel') {
    const cancelled = cancelBgsSync();
    return NextResponse.json({ success: true, cancelled }, { headers });
  }
  if (action === 'cleanup') {
    const result = cleanupBgsArchive();
    if (!result.removed && result.reason) {
      return NextResponse.json({ success: false, ...result }, { status: 409, headers });
    }
    return NextResponse.json({ success: true, ...result }, { headers });
  }
  return NextResponse.json({ success: false, error: 'Неизвестное действие: нужен start, cancel или cleanup' }, { status: 400, headers });
}
