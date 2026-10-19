/**
 * PowerPlay из журналов пилотов — то же наблюдение системы, что и для фракций.
 *
 * В FSDJump / Location / CarrierJump населённой системы игра пишет не только
 * фракции, но и PowerPlay 2.0: `ControllingPower`, `Powers`, `PowerplayState`
 * и счётчики `PowerplayStateControlProgress` / `…Reinforcement` /
 * `…Undermining`. Раньше слой PowerPlay жил только ночным дампом EDSM (раз в
 * 12 часов, и то если сервер до EDSM достучался), а эти поля из журналов
 * отбрасывались ещё на клиенте. Теперь одна проекция события
 * (`projectBgsEvent` / `uploader/bgs_sync.py`) несёт оба набора полей, а
 * сервер раскладывает одно наблюдение по двум слоям (`systemObservations.ts`).
 *
 * Правила, которые защищают слой от старых журналов:
 *   * наблюдения до запуска PowerPlay 2.0 (29.10.2024) не принимаются — в
 *     PowerPlay 1.0 те же поля значили другое;
 *   * база применяет наблюдение, только если оно новее сохранённого, а новую
 *     систему добавляет, только если наблюдение новее последнего дампа
 *     (`powerplay_apply_observations`);
 *   * `Unoccupied` — тоже факт: система больше не под контролем, слой её не
 *     показывает, а более старый дамп не возвращает.
 *
 * Без node-зависимостей: модуль общий для браузера, маршрутов и тестов.
 */

import { cleanName, coordinate, id64FromAny, normalizeAllegiance, normalizeGovernment, observationTime } from './bgs.ts';
import { normalizePowerName, normalizePowerplayState, type PowerplayState } from './powerplay.ts';

/** Поля PowerPlay в событиях журнала — тот же список, что `POWERPLAY_SYSTEM_FIELDS` в uploader/bgs_sync.py. */
export const POWERPLAY_JOURNAL_FIELDS = [
  'ControllingPower',
  'Powers',
  'PowerplayState',
  'PowerplayStateControlProgress',
  'PowerplayStateReinforcement',
  'PowerplayStateUndermining',
] as const;

/** Запуск PowerPlay 2.0 (обновление «Ascendancy»): раньше поля значили другое. */
export const POWERPLAY2_START_MS = Date.parse('2024-10-29T00:00:00Z');

const MAX_POWERS = 16;

export type PowerplayObservedState = PowerplayState | 'Unoccupied';

export interface PowerplayObservation {
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Держава под контролем; у `Unoccupied` — null. */
  power: string | null;
  state: PowerplayObservedState;
  /** Державы, присутствующие в системе (включая захватывающие свободную). */
  powers: string[];
  /** Доля шкалы контроля (0…1, у оплота может быть больше 1). */
  controlProgress: number | null;
  reinforcement: number | null;
  undermining: number | null;
  allegiance: string | null;
  government: string | null;
  observedAt: string;
}

export type PowerplayJournalReject =
  | 'event'
  | 'no_powerplay'
  | 'timestamp'
  | 'before_pp2'
  | 'system'
  | 'address'
  | 'position'
  | 'state'
  | 'power';

function finiteNumber(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function powerList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = normalizePowerName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_POWERS) break;
  }
  return out;
}

/** Есть ли в проекции события хоть одно поле PowerPlay. */
export function hasPowerplayFields(event: Record<string, unknown> | null | undefined): boolean {
  if (!event || typeof event !== 'object') return false;
  return POWERPLAY_JOURNAL_FIELDS.some((key) => event[key] != null);
}

/**
 * Проекция события журнала (FSDJump / Location / CarrierJump) → наблюдение
 * PowerPlay. Отказ — если полей PowerPlay нет (система вне PowerPlay или
 * старый клиент их не прислал) или наблюдение не годится.
 */
export function journalEventToPowerplay(
  value: unknown,
  nowMs = Date.now(),
): { observation: PowerplayObservation } | { reject: PowerplayJournalReject } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reject: 'event' };
  const event = value as Record<string, unknown>;
  if (!['FSDJump', 'Location', 'CarrierJump'].includes(String(event.event))) return { reject: 'event' };
  if (typeof event.PowerplayState !== 'string' || !event.PowerplayState.trim()) return { reject: 'no_powerplay' };

  const observedAt = observationTime(event.timestamp, nowMs);
  if (!observedAt) return { reject: 'timestamp' };
  if (Date.parse(observedAt) < POWERPLAY2_START_MS) return { reject: 'before_pp2' };
  const name = cleanName(event.StarSystem, 120);
  if (!name) return { reject: 'system' };
  const id64 = id64FromAny(event.SystemAddress);
  if (!id64) return { reject: 'address' };
  const pos = Array.isArray(event.StarPos) ? event.StarPos : [];
  const x = coordinate(pos[0]);
  const y = coordinate(pos[1]);
  const z = coordinate(pos[2]);
  if (pos.length !== 3 || x == null || y == null || z == null) return { reject: 'position' };

  const rawState = event.PowerplayState.trim();
  const controlled = normalizePowerplayState(rawState);
  const unoccupied = rawState.toLowerCase() === 'unoccupied';
  if (!controlled && !unoccupied) return { reject: 'state' };

  let power: string | null = null;
  if (controlled) {
    // Только ControllingPower. `Powers` — державы, чьи зоны накрывают систему:
    // владельца там может и не быть (система под угрозой потери), а
    // единственная держава в списке бывает соседом. Угадывать по нему — та же
    // ошибка, из-за которой дамп EDSM раздавал пограничье не тем державам.
    power = normalizePowerName(event.ControllingPower);
    if (!power) return { reject: 'power' };
  }

  return {
    observation: {
      id64,
      name,
      x,
      y,
      z,
      power,
      state: controlled ?? 'Unoccupied',
      powers: powerList(event.Powers),
      controlProgress: finiteNumber(event.PowerplayStateControlProgress, -10, 10),
      reinforcement: finiteNumber(event.PowerplayStateReinforcement, 0, 1e12),
      undermining: finiteNumber(event.PowerplayStateUndermining, 0, 1e12),
      allegiance: event.SystemAllegiance == null ? null : normalizeAllegiance(event.SystemAllegiance),
      government: normalizeGovernment(event.SystemGovernment),
      observedAt,
    },
  };
}

/** Наблюдение → строка для RPC `powerplay_apply_observations` (id64 строкой — без потери разрядов). */
export function powerplayObservationToRpcRow(observation: PowerplayObservation): Record<string, unknown> {
  return {
    id64: observation.id64,
    name: observation.name,
    x: observation.x,
    y: observation.y,
    z: observation.z,
    power: observation.power,
    power_state: observation.state,
    powers: observation.powers,
    control_progress: observation.controlProgress,
    reinforcement: observation.reinforcement,
    undermining: observation.undermining,
    allegiance: observation.allegiance,
    government: observation.government,
    observed_at: observation.observedAt,
  };
}

/** Из нескольких наблюдений одной системы в пачке нужна только самая свежая. */
export function latestPowerplayObservations(observations: PowerplayObservation[]): PowerplayObservation[] {
  const byId = new Map<string, PowerplayObservation>();
  for (const observation of observations) {
    const current = byId.get(observation.id64);
    if (!current || Date.parse(observation.observedAt) >= Date.parse(current.observedAt)) byId.set(observation.id64, observation);
  }
  return Array.from(byId.values());
}
