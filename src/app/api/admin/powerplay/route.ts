import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { createServiceClient } from '@/lib/supabaseServer';
import { markPowerplayInterrupted, type PowerplaySyncMode } from '@/lib/powerplayProgress';
import {
  POWERPLAY_MAX_SEGMENTS,
  POWERPLAY_RETRY_AFTER_MS,
  POWERPLAY_STALE_AFTER_MS,
  cancelPowerplaySync,
  clampPowerplaySegments,
  cleanupPowerplayArchive,
  describePowerplayWriter,
  getPowerplayLastRun,
  getPowerplayLiveRun,
  isPowerplaySyncRunning,
  nextPowerplayScheduledRun,
  powerplayArchiveInfo,
  powerplayArchiveKeep,
  powerplayBatchSize,
  powerplayDownloadSegments,
  powerplayDumpUrl,
  powerplayMinRows,
  powerplayNextLazyAttempt,
  powerplayPieceBytes,
  powerplayShardSystems,
  powerplayShardsStatus,
  powerplayShortRequests,
  powerplayStallMs,
  powerplaySyncInterrupted,
  readPowerplaySummary,
  readPowerplaySyncState,
  startPowerplaySync,
} from '@/lib/powerplaySync';
import { POWERPLAY_UPLOAD_CHUNK_BYTES, powerplayUploadInfo } from '@/lib/powerplayUpload';
import {
  eddnListenerForbidden,
  ensureEddnListener,
  getEddnListener,
  setEddnEnabled,
  startEddnListener,
  stopEddnListener,
  type EddnEnsureResult,
} from '@/lib/eddn/listener';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-store' };

/** Действие админки → вид запуска импорта. */
const RUN_ACTIONS: Record<string, PowerplaySyncMode> = {
  start: 'full',
  download: 'download',
  split: 'split',
  import: 'import',
};

const RUN_STARTED: Record<PowerplaySyncMode, string> = {
  full: 'Загрузка запущена',
  download: 'Скачивание архива запущено',
  split: 'Разбивка архива на куски запущена',
  import: 'Загрузка кусков в базу запущена',
};

/**
 * Админка → Игровые данные → PowerPlay: управление загрузкой систем держав
 * из ночного дампа EDSM.
 *
 * GET — состояние для панели:
 *   * `running` / `mode` / `interrupted` — идёт ли импорт сейчас и какой (или
 *     прошлый оборвал перезапуск процесса);
 *   * `progress` — этапы с процентами (живой прогон из памяти, иначе копия
 *     последнего из базы), `log` — журнал процесса;
 *   * `state` — строка `powerplay_sync_state` без служебного: когда проверяли,
 *     когда записали, дата дампа, последняя ошибка;
 *   * `summary` — что лежит в таблице: системы по державам и состояниям;
 *   * `archive`, `shards`, `upload`, `writer` — архив и куски на сервере,
 *     незаконченная загрузка с компьютера, путь записи в базу;
 *   * `config` — источник, соединения, пороги и когда следующая проверка.
 *
 * POST (как у фракций и «Каталога систем»: архив → куски → база, шаги по очереди):
 *   * `{ action: 'start' }`              — всё: скачать архив на сервер целиком,
 *                                          затем разбить на куски, затем записать
 *                                          их в базу (тот же дамп, что в прошлый
 *                                          раз, не качается; архив, загруженный с
 *                                          компьютера, берётся вместо EDSM);
 *   * `{ action: 'start', force: true }` — загрузить заново, даже если дамп тот
 *                                          же, и принять «усохший»;
 *   * `{ action: 'download' }`           — только скачать архив на сервер;
 *   * `{ action: 'split' }`              — только разбить скачанный архив на куски;
 *   * `{ action: 'import' }`             — записать в базу то, что уже на сервере
 *                                          (архив или куски), без обращения к EDSM;
 *   * `segments: 1…16`                   — соединений к EDSM для этого запуска;
 *   * `{ action: 'cancel' }`             — остановить (скачанное и разбитое
 *                                          остаётся для продолжения);
 *   * `{ action: 'cleanup' }`            — удалить архив и куски с сервера;
 *   * `{ action: 'eddn-start' }`         — включить живые данные EDDN
 *                                          (флаг в базе, слушатель — сразу);
 *   * `{ action: 'eddn-stop' }`          — выключить их.
 * Импорт идёт фоном в веб-процессе; ответ возвращается сразу, ход виден в GET.
 * Загрузка архива с компьютера — `/api/admin/powerplay/upload`.
 *
 * GET заодно приводит слушатель EDDN к флагу из базы (`eddn`): после
 * перезапуска сайта открытая админка поднимет его сразу, не ожидая задачи.
 */

function eddnStatus(result: EddnEnsureResult | null, error: string | null) {
  if (!result) {
    const snapshot = getEddnListener();
    return { ...snapshot, enabled: false, forbidden: eddnListenerForbidden(), supported: false, error: error ?? snapshot.error };
  }
  const { snapshot, settings } = result;
  return {
    enabled: result.enabled,
    forbidden: result.forbidden,
    supported: result.supported,
    enabledAt: settings.enabledAt,
    heartbeatAt: settings.heartbeatAt,
    ...snapshot,
    // Процесс только что поднялся — история прошлого запуска есть только в базе.
    log: snapshot.log.length ? snapshot.log : settings.log,
    stats: snapshot.running || !settings.stats ? snapshot.stats : { ...snapshot.stats, ...settings.stats },
    error: snapshot.error ?? (snapshot.running ? null : settings.error) ?? error,
  };
}
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  const nowMs = Date.now();
  try {
    const svc = createServiceClient();
    const state = await readPowerplaySyncState(svc);
    let summary = null;
    let summaryError: string | null = null;
    try {
      summary = await readPowerplaySummary(svc);
    } catch (error) {
      summaryError = /powerplay_admin_summary|schema cache|does not exist/i.test(String((error as Error)?.message))
        ? 'Сводка по державам появится после миграции 20261018180000_powerplay_sync_progress.sql'
        : `Сводка недоступна: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
    }
    const live = getPowerplayLiveRun();
    const last = live ?? getPowerplayLastRun();
    const running = isPowerplaySyncRunning() || Boolean(live);
    // Прогон из базы новее всего, что помнит процесс (процесс перезапускали).
    const persisted = state.progress;
    const chosen = last?.progress && (!persisted || Date.parse(last.progress.startedAt) >= Date.parse(persisted.startedAt))
      ? last.progress
      : persisted;
    // «Идёт» в базе, а живого запуска нет — сайт перезапустился посреди работы.
    const stuck = !running && chosen?.phase === 'running';
    const progress = stuck && chosen ? markPowerplayInterrupted(chosen) : chosen;
    const log = last?.log?.length ? last.log : state.log;
    let eddn: EddnEnsureResult | null = null;
    let eddnError: string | null = null;
    try {
      eddn = await ensureEddnListener(svc);
    } catch (error) {
      eddnError = `Состояние EDDN недоступно: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
    }
    return NextResponse.json(
      {
        success: true,
        running,
        mode: running ? live?.progress.mode ?? null : null,
        interrupted: !running && (powerplaySyncInterrupted(state) || stuck),
        progress,
        log,
        state: {
          status: state.status,
          source_url: state.source_url,
          etag: state.etag,
          last_modified: state.last_modified,
          dump_generated_at: state.dump_generated_at,
          run_id: state.run_id,
          rows_total: state.rows_total,
          stats: state.stats,
          error: state.error,
          attempt_at: state.attempt_at,
          checked_at: state.checked_at,
          synced_at: state.synced_at,
        },
        summary,
        summaryError,
        eddn: eddnStatus(eddn, eddnError),
        progressPersisted: state.progress_supported,
        archive: powerplayArchiveInfo(),
        shards: powerplayShardsStatus(),
        upload: { ...powerplayUploadInfo(), chunkBytes: POWERPLAY_UPLOAD_CHUNK_BYTES },
        writer: describePowerplayWriter(),
        config: {
          dumpUrl: powerplayDumpUrl(),
          archiveKeep: powerplayArchiveKeep(),
          segments: powerplayDownloadSegments(),
          maxSegments: POWERPLAY_MAX_SEGMENTS,
          pieceBytes: powerplayPieceBytes(),
          stallSeconds: Math.round(powerplayStallMs() / 1000),
          shortRequests: powerplayShortRequests(),
          shardSystems: powerplayShardSystems(),
          staleAfterHours: POWERPLAY_STALE_AFTER_MS / 3_600_000,
          retryAfterMinutes: POWERPLAY_RETRY_AFTER_MS / 60_000,
          minRows: powerplayMinRows(),
          batchSize: powerplayBatchSize(),
          nextScheduledRun: nextPowerplayScheduledRun(nowMs),
          nextLazyAttempt: powerplayNextLazyAttempt(state, nowMs),
        },
        serverTime: new Date(nowMs).toISOString(),
      },
      { headers },
    );
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    console.error('[admin/powerplay]', message);
    const missing = /powerplay_sync_state|schema cache|does not exist/i.test(message);
    return NextResponse.json(
      {
        success: false,
        error: missing
          ? 'Таблиц PowerPlay нет в базе: примените миграции 20261018120000_powerplay_systems.sql и 20261018180000_powerplay_sync_progress.sql (deploy/update-project.sh делает это сам)'
          : `Не удалось прочитать состояние PowerPlay: ${message.slice(0, 300)}`,
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
    if (body.segments !== undefined && body.segments !== null && !(Number(body.segments) >= 1 && Number(body.segments) <= POWERPLAY_MAX_SEGMENTS)) {
      return NextResponse.json({ success: false, error: `Соединений к EDSM: от 1 до ${POWERPLAY_MAX_SEGMENTS}` }, { status: 400, headers });
    }
    let svc;
    try {
      svc = createServiceClient();
    } catch (error) {
      return NextResponse.json({ success: false, error: `Нет подключения к базе: ${String((error as Error)?.message ?? error).slice(0, 200)}` }, { status: 503, headers });
    }
    const force = body.force === true;
    const segments = body.segments == null ? undefined : clampPowerplaySegments(body.segments);
    const result = startPowerplaySync(svc, { force, mode, segments, trigger: 'admin' });
    if (!result.started) {
      return NextResponse.json({ success: false, started: false, reason: result.reason }, { status: 409, headers });
    }
    return NextResponse.json(
      { success: true, started: true, force, mode, ...(segments ? { segments } : {}), message: RUN_STARTED[mode] },
      { headers },
    );
  }
  if (action === 'cancel') {
    const cancelled = cancelPowerplaySync();
    return NextResponse.json({ success: true, cancelled }, { headers });
  }
  if (action === 'cleanup') {
    const result = cleanupPowerplayArchive();
    if (!result.removed && result.reason) {
      return NextResponse.json({ success: false, ...result }, { status: 409, headers });
    }
    return NextResponse.json({ success: true, ...result }, { headers });
  }
  if (action === 'eddn-start' || action === 'eddn-stop') {
    const enable = action === 'eddn-start';
    if (enable && eddnListenerForbidden()) {
      return NextResponse.json({ success: false, error: 'На сервере задано EDDN_LISTENER=off — слушатель запрещён' }, { status: 409, headers });
    }
    try {
      const svc = createServiceClient();
      await setEddnEnabled(svc, enable, auth.actor.userId);
      const snapshot = enable ? startEddnListener(svc) : await stopEddnListener('остановлен: выключен в админке');
      return NextResponse.json({ success: true, enabled: enable, eddn: snapshot }, { headers });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const missing = /eddn_listener_state|schema cache|does not exist/i.test(message);
      return NextResponse.json(
        { success: false, error: missing ? 'Нет таблицы eddn_listener_state: примените миграцию 20261021130000_eddn_listener.sql' : `Не удалось переключить EDDN: ${message.slice(0, 200)}` },
        { status: 503, headers },
      );
    }
  }
  return NextResponse.json(
    { success: false, error: 'Неизвестное действие: нужен start, download, split, import, cancel, cleanup, eddn-start или eddn-stop' },
    { status: 400, headers },
  );
}
