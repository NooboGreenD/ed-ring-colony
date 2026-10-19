import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { createServiceClient } from '@/lib/supabaseServer';
import {
  POWERPLAY_BATCH_SIZE,
  POWERPLAY_MIN_ROWS,
  POWERPLAY_RETRY_AFTER_MS,
  POWERPLAY_STALE_AFTER_MS,
  cancelPowerplaySync,
  getPowerplayLastRun,
  getPowerplayLiveRun,
  isPowerplaySyncRunning,
  nextPowerplayScheduledRun,
  powerplayDumpUrl,
  powerplayNextLazyAttempt,
  readPowerplaySummary,
  readPowerplaySyncState,
  startPowerplaySync,
} from '@/lib/powerplaySync';
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

/**
 * Админка → Игровые данные → PowerPlay: управление загрузкой систем держав
 * из ночного дампа EDSM.
 *
 * GET — состояние для панели:
 *   * `running` / `interrupted` — идёт ли импорт сейчас (или прошлый оборвал
 *     перезапуск процесса);
 *   * `progress` — этапы с процентами (живой прогон из памяти, иначе копия
 *     последнего из базы), `log` — журнал процесса;
 *   * `state` — строка `powerplay_sync_state` без служебного: когда проверяли,
 *     когда записали, дата дампа, последняя ошибка;
 *   * `summary` — что лежит в таблице: системы по державам и состояниям;
 *   * `config` — источник, пороги и когда следующая автоматическая проверка.
 *
 * POST:
 *   * `{ action: 'start' }`              — загрузить сейчас (условный запрос:
 *                                          304, если дамп не менялся);
 *   * `{ action: 'start', force: true }` — перекачать заново и принять дамп,
 *                                          даже если он заметно меньше прошлого;
 *   * `{ action: 'cancel' }`             — остановить идущий импорт;
 *   * `{ action: 'eddn-start' }`         — включить живые данные EDDN
 *                                          (флаг в базе, слушатель — сразу);
 *   * `{ action: 'eddn-stop' }`          — выключить их.
 * Импорт идёт фоном в веб-процессе; ответ возвращается сразу, ход виден в GET.
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
    const progress = last?.progress && (!persisted || Date.parse(last.progress.startedAt) >= Date.parse(persisted.startedAt))
      ? last.progress
      : persisted;
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
        interrupted: !running && state.status === 'running',
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
        config: {
          dumpUrl: powerplayDumpUrl(),
          staleAfterHours: POWERPLAY_STALE_AFTER_MS / 3_600_000,
          retryAfterMinutes: POWERPLAY_RETRY_AFTER_MS / 60_000,
          minRows: POWERPLAY_MIN_ROWS,
          batchSize: POWERPLAY_BATCH_SIZE,
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
    const result = startPowerplaySync(svc, { force: body.force === true, trigger: 'admin' });
    if (!result.started) {
      return NextResponse.json({ success: false, started: false, reason: result.reason }, { status: 409, headers });
    }
    return NextResponse.json({ success: true, started: true, force: body.force === true }, { headers });
  }
  if (action === 'cancel') {
    const cancelled = cancelPowerplaySync();
    return NextResponse.json({ success: true, cancelled }, { headers });
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
  return NextResponse.json({ success: false, error: 'Неизвестное действие: нужен start, cancel, eddn-start или eddn-stop' }, { status: 400, headers });
}
