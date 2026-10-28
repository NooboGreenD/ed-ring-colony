/**
 * Подсказка для оверлея Route: что проект знает о следующей системе маршрута.
 *
 * Оверлей — узкий блок поверх игры, и ему нужны две вещи, а не карточка
 * системы целиком:
 *
 *   * идёт ли в системе стройка и на сколько процентов она готова;
 *   * кто первым открыл систему — если система вообще есть в базе проекта.
 *
 * Поэтому ответ маленький и плоский, без профиля зрителя: его можно кэшировать
 * и запрашивать раз в несколько минут. Прогресс считается тем же расчётом, что
 * у «Проектов систем» и карточки системы (`buildSystemProgress` через
 * `system_progress_sources`), а первооткрыватель берётся из `system_scans` —
 * там он лежит по телам, поэтому для системы выбирается тело с наименьшим
 * расстоянием до точки входа (главная звезда).
 */
import type { CompactSystemProgress } from './systemOverview.ts';

/** Состояние стройки в системе — те же три статуса, что на карте кольца. */
export type RouteHintStatus = 'planned' | 'building' | 'done' | 'unknown';

export interface RouteHintNeed {
  label: string;
  remaining: number;
}

export interface RouteHintConstruction {
  /** Проект вообще что-то знает о стройке в этой системе. */
  known: boolean;
  status: RouteHintStatus;
  /** Процент готовности площадок: null — считать не из чего. */
  progress: number | null;
  sitesActive: number;
  sitesComplete: number;
  /** Сколько тонн ещё нужно завезти (весь набор площадок). */
  remaining: number | null;
  /** Пять самых тяжёлых недостач — оверлею хватает подсказки. */
  needs: RouteHintNeed[];
  updatedAt: string | null;
}

export interface RouteHintDiscovery {
  /** Система есть в базе проекта: журналы пилотов, EDSM, Spansh. */
  known: boolean;
  /** Первооткрыватель системы (тело с наименьшим расстоянием), если известен. */
  discoverer: string | null;
  /** Сколько тел системы описано в базе проекта. */
  bodies: number;
  /** У скольких тел известен первый картограф. */
  mapped: number;
  /** У скольких тел известен первый шаг по поверхности. */
  footfall: number;
  updatedAt: string | null;
}

export interface RouteHint {
  ok: true;
  system: string;
  construction: RouteHintConstruction;
  discovery: RouteHintDiscovery;
}

/** Строка `system_scans` в том виде, в каком её читает подсказка. */
export type RouteHintRow = Record<string, unknown>;

type Row = RouteHintRow;

function text(value: unknown, limit = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function count(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function timestamp(row: Row): number {
  const value = Date.parse(text(row.updated_at));
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Строки `system_scans` → «кто открыл систему» и насколько она изучена. */
export function shapeDiscovery(rows: Row[] | null | undefined): RouteHintDiscovery {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (list.length === 0) {
    return { known: false, discoverer: null, bodies: 0, mapped: 0, footfall: 0, updatedAt: null };
  }
  // Главная звезда — тело с наименьшим расстоянием до точки входа. Именно её
  // открывает тот, кого игра считает первооткрывателем системы.
  const sorted = [...list].sort((a, b) => {
    const first = text(a.body_type).toLowerCase() === 'star' ? 0 : 1;
    const second = text(b.body_type).toLowerCase() === 'star' ? 0 : 1;
    if (first !== second) return first - second;
    return count(a.distance_ls) - count(b.distance_ls);
  });
  const discoverer = sorted.map((row) => text(row.first_discovered_by, 80)).find(Boolean) ?? null;
  const mapped = list.filter((row) => text(row.first_mapped_by)).length;
  const footfall = list.filter((row) => text(row.first_footfall_by)).length;
  const updated = list.reduce<number>((best, row) => Math.max(best, timestamp(row)), Number.NEGATIVE_INFINITY);
  return {
    known: true,
    discoverer,
    bodies: list.length,
    mapped,
    footfall,
    updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null,
  };
}

/** Прогресс систем → состояние стройки для оверлея. */
export function shapeConstruction(progress: CompactSystemProgress | null | undefined): RouteHintConstruction {
  if (!progress) {
    return {
      known: false,
      status: 'unknown',
      progress: null,
      sitesActive: 0,
      sitesComplete: 0,
      remaining: null,
      needs: [],
      updatedAt: null,
    };
  }
  const percent = typeof progress.progress === 'number' && Number.isFinite(progress.progress)
    ? Math.min(100, Math.max(0, Math.round(progress.progress)))
    : null;
  const sitesActive = count(progress.sitesActive);
  const sitesComplete = count(progress.sitesComplete);
  const known = percent != null || sitesActive > 0 || sitesComplete > 0;
  const status: RouteHintStatus = !known
    ? 'unknown'
    : progress.status === 'done' || percent === 100
      ? 'done'
      : progress.status === 'building' || (percent ?? 0) > 0 || sitesActive > 0
        ? 'building'
        : 'planned';
  return {
    known,
    status,
    progress: percent,
    sitesActive,
    sitesComplete,
    remaining: typeof progress.remaining === 'number' && Number.isFinite(progress.remaining)
      ? Math.max(0, Math.round(progress.remaining))
      : null,
    needs: (progress.needs ?? []).slice(0, 5).map((need) => ({
      label: text(need.label, 60),
      remaining: Math.max(0, Math.round(count(need.remaining))),
    })),
    updatedAt: progress.ravenUpdatedAt || progress.journalUpdatedAt || null,
  };
}

/** Собрать ответ подсказки: имя системы, стройка, первооткрыватель. */
export function buildRouteHint(
  systemName: string,
  sources: { progress?: CompactSystemProgress | null; scans?: Row[] | null },
): RouteHint {
  return {
    ok: true,
    system: text(systemName, 200),
    construction: shapeConstruction(sources.progress ?? null),
    discovery: shapeDiscovery(sources.scans ?? []),
  };
}
