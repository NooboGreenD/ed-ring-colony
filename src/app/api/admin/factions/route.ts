import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { createServiceClient } from '@/lib/supabaseServer';
import { markBgsInterrupted, type BgsSyncMode } from '@/lib/bgsProgress';
import {
  BGS_KEEP_DAYS,
  BGS_MAX_SEGMENTS,
  bgsArchiveInfo,
  bgsArchiveKeep,
  bgsBatchSize,
  bgsDownloadSegments,
  bgsDumpUrl,
  bgsMinSystems,
  bgsPieceBytes,
  bgsRefreshDays,
  bgsShardSystems,
  bgsShardsStatus,
  bgsShortRequests,
  bgsStallMs,
  bgsSyncInterrupted,
  cancelBgsSync,
  clampBgsSegments,
  cleanupBgsArchive,
  decideBgsScheduledSync,
  describeBgsWriter,
  getBgsLastRun,
  getBgsLiveRun,
  isBgsSyncRunning,
  nextBgsScheduledRun,
  readBgsSummary,
  readBgsSyncState,
  startBgsSync,
} from '@/lib/bgsSync';
import { BGS_UPLOAD_CHUNK_BYTES, bgsUploadInfo } from '@/lib/bgsUpload';

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

/** Действие админки → вид запуска импорта. */
const RUN_ACTIONS: Record<string, BgsSyncMode> = {
  start: 'full',
  download: 'download',
  split: 'split',
  import: 'import',
};

const RUN_STARTED: Record<BgsSyncMode, string> = {
  full: 'Загрузка запущена',
  download: 'Скачивание архива запущено',
  split: 'Разбивка архива на куски запущена',
  import: 'Загрузка кусков в базу запущена',
};

/**
 * Админка → Игровые данные → Фракции: управление данными о минорных фракциях.
 *
 * GET — состояние для панели: идёт ли импорт дампа EDSM (этапы, проценты,
 * журнал), что лежит в базе (системы, фракции, источники, свежесть),
 * обновления от пилотов (Colonial Helper и загрузчик журналов на сайте),
 * архив и куски на сервере, путь записи в базу и настройки.
 *
 * POST (как у «Каталога систем»: архив → куски → база, шаги по очереди):
 *   * `{ action: 'start' }`               — всё: скачать архив на сервер целиком,
 *                                           затем разбить на куски, затем записать
 *                                           их в базу (тот же дамп, что в прошлый
 *                                           раз, не качается; архив, загруженный с
 *                                           компьютера, берётся вместо EDSM);
 *   * `{ action: 'start', force: true }`  — загрузить заново, даже если дамп тот
 *                                           же, и принять «усохший»;
 *   * `{ action: 'download' }`            — только скачать архив на сервер;
 *   * `{ action: 'split' }`               — только разбить скачанный архив на куски;
 *   * `{ action: 'import' }`              — записать в базу то, что уже на сервере
 *                                           (архив или куски), без обращения к EDSM;
 *   * `segments: 1…16`                    — соединений к EDSM для этого запуска;
 *   * `{ action: 'cancel' }`              — остановить (скачанное и разбитое
 *                                           остаётся для продолжения);
 *   * `{ action: 'cleanup' }`             — удалить архив и куски с сервера.
 *
 * Загрузка архива с компьютера — `/api/admin/factions/upload`.
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
    const chosen = last?.progress && (!persisted || Date.parse(last.progress.startedAt) >= Date.parse(persisted.startedAt))
      ? last.progress
      : persisted;
    // «Идёт» в базе, а живого запуска нет — сайт перезапустился посреди работы.
    const stuck = !running && chosen?.phase === 'running';
    const progress = stuck && chosen ? markBgsInterrupted(chosen) : chosen;
    const log = last?.log?.length ? last.log : state.log;
    const decision = decideBgsScheduledSync(state, { nowMs });
    const writer = describeBgsWriter();
    return NextResponse.json(
      {
        success: true,
        running,
        mode: running ? live?.progress.mode ?? null : null,
        interrupted: !running && (bgsSyncInterrupted(state, nowMs) || stuck),
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
        shards: bgsShardsStatus(),
        upload: { ...bgsUploadInfo(), chunkBytes: BGS_UPLOAD_CHUNK_BYTES },
        writer,
        config: {
          dumpUrl: bgsDumpUrl(),
          archiveKeep: bgsArchiveKeep(),
          segments: bgsDownloadSegments(),
          maxSegments: BGS_MAX_SEGMENTS,
          pieceBytes: bgsPieceBytes(),
          stallSeconds: Math.round(bgsStallMs() / 1000),
          shortRequests: bgsShortRequests(),
          shardSystems: bgsShardSystems(),
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
  let body: { action?: unknown; force?: unknown; segments?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const mode = Object.prototype.hasOwnProperty.call(RUN_ACTIONS, action) ? RUN_ACTIONS[action] : null;
  if (mode) {
    if (body.segments !== undefined && body.segments !== null && !(Number(body.segments) >= 1 && Number(body.segments) <= BGS_MAX_SEGMENTS)) {
      return NextResponse.json({ success: false, error: `Соединений к EDSM: от 1 до ${BGS_MAX_SEGMENTS}` }, { status: 400, headers });
    }
    let svc;
    try {
      svc = createServiceClient();
    } catch (error) {
      return NextResponse.json({ success: false, error: `Нет подключения к базе: ${String((error as Error)?.message ?? error).slice(0, 200)}` }, { status: 503, headers });
    }
    const force = body.force === true;
    const segments = body.segments == null ? undefined : clampBgsSegments(body.segments);
    const result = startBgsSync(svc, { force, mode, segments, trigger: 'admin' });
    if (!result.started) {
      return NextResponse.json({ success: false, started: false, reason: result.reason }, { status: 409, headers });
    }
    return NextResponse.json(
      { success: true, started: true, force, mode, ...(segments ? { segments } : {}), message: RUN_STARTED[mode] },
      { headers },
    );
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
  return NextResponse.json(
    { success: false, error: 'Неизвестное действие: нужен start, download, split, import, cancel или cleanup' },
    { status: 400, headers },
  );
}
