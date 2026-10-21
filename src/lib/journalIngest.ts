/**
 * Единый серверный приём пачки журнала — для сайта и для Colonial Helper.
 *
 * `/api/logs/import` (браузер на /account, сессия или API-токен) и
 * `/api/logs/upload` (Colonial Helper, API-токен) раньше повторяли один и тот
 * же код шаг за шагом. Теперь шаги живут здесь, а маршруты только
 * проверяют, кто прислал, и отвечают в своём (обратно совместимом) формате:
 *
 *   1. полная перезагрузка (`reset` / `full_reimport` на первой пачке);
 *   2. начальный ник командира из журнала (только если в профиле пусто);
 *   3. доставки (`persistImportedDeliveries`, идемпотентный `source_hash` —
 *      одинаковый у TS-парсера сайта и Python-парсера Helper'а);
 *   4. телеметрия: состояния площадок, снимки прогресса, сканы тел, сводка
 *      пилота (`persistJournalTelemetry`);
 *   5. реакции других разделов на новые данные: статусы систем в проектах
 *      эскадрилий и уведомления их участникам (`projects/projectSync.ts`).
 *
 * Сбой шагов 4–5 не делает загрузку неудачной (доставки уже записаны, а
 * Helper повторяет пачку на 5xx): ошибки уходят в предупреждения.
 */

import { persistImportedDeliveries } from './deliveryImport.ts';
import { persistJournalTelemetry, type JournalTelemetryOutcome, type PilotStatsSource } from './journalTelemetry.ts';
import { resetJournalData } from './journalReset.ts';
import { syncProjectsFromSites, type ProjectSyncResult } from './projects/projectSync.ts';
import { persistCommunityGoalReports } from './communityGoalReports.ts';

type Svc = any;

export class JournalResetError extends Error {}

export interface JournalBatchInput {
  userId: string;
  source: PilotStatsSource;
  /** Имя командира из журнала (может быть пустым). */
  cmdr: string;
  body: Record<string, unknown>;
  /** Префикс для журнала сервера: `[logs/import]`, `[logs/upload]`. */
  logTag: string;
}

export interface JournalBatchOutcome {
  deliveries: Awaited<ReturnType<typeof persistImportedDeliveries>>;
  telemetry: JournalTelemetryOutcome | null;
  reset: Awaited<ReturnType<typeof resetJournalData>> | null;
  projects: ProjectSyncResult | null;
  communityGoalReportsStored: number;
}

/** Нужна ли очистка перед этой пачкой: флаг читается только в первой. */
export function wantsJournalReset(body: Record<string, unknown>): boolean {
  const shouldReset = body.reset === true || body.full_reimport === true;
  return shouldReset && !body._reset_performed;
}

async function initialiseNickname(svc: Svc, userId: string, cmdr: string, logTag: string): Promise<void> {
  // Журнал может нести игровое имя командира. Оно заполняет только пустой
  // старый профиль и никогда не перетирает сохранённый ник.
  const { data: profile, error: profileError } = await svc
    .from('profiles')
    .select('cmdr_name')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) {
    console.warn(`${logTag} Could not inspect profile nickname:`, profileError.message);
    return;
  }
  if (profile?.cmdr_name) return;
  const { error: updateError } = await svc
    .from('profiles')
    .update({ cmdr_name: cmdr.slice(0, 250) })
    .eq('id', userId);
  if (updateError) console.warn(`${logTag} Could not initialise profile nickname:`, updateError.message);
}

export async function ingestJournalBatch(svc: Svc, input: JournalBatchInput): Promise<JournalBatchOutcome> {
  const { userId, source, cmdr, body, logTag } = input;

  let reset: JournalBatchOutcome['reset'] = null;
  if (wantsJournalReset(body)) {
    try {
      reset = await resetJournalData(svc, userId);
    } catch (resetError) {
      console.warn(`${logTag} journal reset failed before import:`, (resetError as Error).message);
      throw new JournalResetError((resetError as Error).message);
    }
  }

  if (cmdr) await initialiseNickname(svc, userId, cmdr, logTag);

  const deliveries = await persistImportedDeliveries(svc, userId, Array.isArray(body.deliveries) ? body.deliveries : []);

  let telemetry: JournalTelemetryOutcome | null = null;
  try {
    telemetry = await persistJournalTelemetry(svc, userId, {
      constructionEvents: body.constructionEvents ?? body.construction_events,
      systemScans: body.systemScans ?? body.system_scans ?? body.scans,
      pilotStats: body.pilotStats ?? body.pilot_stats,
    }, cmdr || null, { source });
    for (const warning of telemetry.warnings) console.warn(logTag, warning);
  } catch (telemetryError) {
    console.warn(`${logTag} telemetry could not be stored:`, (telemetryError as Error).message);
  }

  let projects: ProjectSyncResult | null = null;
  if (telemetry && telemetry.changedSystems.length > 0) {
    try {
      projects = await syncProjectsFromSites(svc, telemetry.changedSystems, { actorId: userId });
      if (projects.warning) console.warn(logTag, projects.warning);
    } catch (projectError) {
      console.warn(`${logTag} project statuses were not updated:`, (projectError as Error).message);
    }
  }

  const reportPayload = body.communityGoalReports ?? body.community_goal_reports;
  const communityGoalReportsStored = await persistCommunityGoalReports(
    svc,
    userId,
    reportPayload,
    source,
  );

  return { deliveries, telemetry, reset, projects, communityGoalReportsStored };
}

/** Короткая сводка реакций для ответа клиенту. */
export function projectSyncSummary(projects: ProjectSyncResult | null): { changed: number; notified: number } | null {
  if (!projects) return null;
  return { changed: projects.changed.length, notified: projects.notified };
}
