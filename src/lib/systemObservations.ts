/**
 * Наблюдение системы → все слои сайта.
 *
 * Прыжок пилота (FSDJump), вход в игру (Location) или прыжок авианосца
 * (CarrierJump) несут состояние населённой системы целиком. Раньше из этого
 * наблюдения сайт брал только фракции, а PowerPlay ждал ночного дампа EDSM.
 * Теперь одно наблюдение раскладывается по всем слоям сразу:
 *
 *   * фракции — `bgs_apply_snapshots` (`bgsStore.applyPilotSnapshots`);
 *   * PowerPlay — `powerplay_apply_observations` (`powerplayStore.applyPilotPowerplay`).
 *
 * Источники одинаковые для всех слоёв: Colonial Helper (`/api/factions/sync`
 * с API-токеном), загрузчик журналов на сайте (тот же маршрут с сессией) и
 * синхронизация Frontier CAPI (журнал за день, `capi/syncPilot.ts`). Везде
 * побеждает более свежее наблюдение, поэтому повтор одного журнала из разных
 * путей ничего не портит.
 *
 * Сбой PowerPlay (например, миграция 20261020120000 ещё не применена) не
 * роняет фракции: старые клиенты шлют сюда то же, что и раньше.
 */

import type { BgsSnapshot } from './bgs.ts';
import { BgsSnapshotCollector, journalEventToSnapshot, type BgsJournalReject } from './bgsJournal.ts';
import { applyPilotSnapshots, type PilotApplyResult } from './bgsStore.ts';
import {
  hasPowerplayFields,
  journalEventToPowerplay,
  type PowerplayJournalReject,
  type PowerplayObservation,
} from './powerplayJournal.ts';
import { applyPilotPowerplay, EMPTY_PILOT_POWERPLAY, type PilotPowerplayResult } from './powerplayStore.ts';

type Svc = any;

export type ObservationSource = 'helper' | 'web' | 'eddn';

export interface SplitObservations {
  snapshots: BgsSnapshot[];
  powerplay: PowerplayObservation[];
  bgsRejected: Partial<Record<BgsJournalReject, number>>;
  powerplayRejected: Partial<Record<PowerplayJournalReject, number>>;
  /** Событий с полями PowerPlay (остальные — системы вне PowerPlay или старый клиент). */
  powerplayCandidates: number;
}

export interface SystemObservationsResult {
  received: number;
  factions: PilotApplyResult & {
    accepted: number;
    invalid: number;
    rejected: Partial<Record<BgsJournalReject, number>>;
  };
  powerplay: PilotPowerplayResult & {
    accepted: number;
    rejected: Partial<Record<PowerplayJournalReject, number>>;
    /** Слой PowerPlay не обновлён (фракции при этом записаны). */
    error: string | null;
  };
}

/** Проекции событий → наблюдения для каждого слоя (чистая функция). */
export function splitSystemObservations(events: readonly unknown[], nowMs = Date.now()): SplitObservations {
  const out: SplitObservations = { snapshots: [], powerplay: [], bgsRejected: {}, powerplayRejected: {}, powerplayCandidates: 0 };
  for (const event of events) {
    const bgs = journalEventToSnapshot(event, nowMs);
    if ('snapshot' in bgs) out.snapshots.push(bgs.snapshot);
    else out.bgsRejected[bgs.reject] = (out.bgsRejected[bgs.reject] ?? 0) + 1;

    if (!event || typeof event !== 'object' || !hasPowerplayFields(event as Record<string, unknown>)) continue;
    out.powerplayCandidates += 1;
    const pp = journalEventToPowerplay(event, nowMs);
    if ('observation' in pp) out.powerplay.push(pp.observation);
    else out.powerplayRejected[pp.reject] = (out.powerplayRejected[pp.reject] ?? 0) + 1;
  }
  return out;
}

/**
 * Записать наблюдения во все слои. Ошибка базы фракций пробрасывается (маршрут
 * отвечает 503 — клиент повторит), ошибка PowerPlay — только в результат.
 */
export async function applySystemObservations(
  svc: Svc,
  events: readonly unknown[],
  meta: { source: ObservationSource; userId: string | null },
  nowMs = Date.now(),
): Promise<SystemObservationsResult> {
  const split = splitSystemObservations(events, nowMs);
  const invalid = events.length - split.snapshots.length;
  const factions = await applyPilotSnapshots(svc, split.snapshots, { source: meta.source, userId: meta.userId, invalid });

  let powerplay: PilotPowerplayResult = { ...EMPTY_PILOT_POWERPLAY, systems: [] };
  let powerplayError: string | null = null;
  if (split.powerplay.length > 0) {
    try {
      powerplay = await applyPilotPowerplay(svc, split.powerplay, { source: meta.source });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      powerplayError = /powerplay_apply_observations|schema cache|does not exist/i.test(message)
        ? 'PowerPlay из журналов ждёт миграцию 20261020120000_unified_system_data.sql'
        : 'Слой PowerPlay временно недоступен';
      console.warn('[systemObservations] PowerPlay not updated:', message);
    }
  }

  return {
    received: events.length,
    factions: { ...factions, accepted: split.snapshots.length, invalid, rejected: split.bgsRejected },
    powerplay: { ...powerplay, accepted: split.powerplay.length, rejected: split.powerplayRejected, error: powerplayError },
  };
}

/**
 * Журнал целиком (текст: строка — событие) → проекции наблюдений, по одной
 * самой свежей на систему. Тот же отбор, что у загрузчика на сайте и у Helper'а;
 * нужен там, где журнал приходит на сервер сразу текстом (Frontier CAPI).
 */
export function observationEventsFromJournalText(text: string): Record<string, unknown>[] {
  const collector = new BgsSnapshotCollector();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      collector.feed(trimmed, event);
    } catch {
      // Битая строка журнала — не повод терять остальные наблюдения.
    }
  }
  return collector.drain();
}
