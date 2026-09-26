/**
 * «Уже построено в системе» — перенос фактической застройки в план архитектора.
 *
 * Планировщик умел сверять план с фактом (`progress.ts`), но не умел главного:
 * взять систему, где уже что-то стоит, и получить план, который отражает
 * реальность. Из-за этого очки тиров считались от пустой системы, а «первый
 * порт бесплатно» доставался постройке, которая на самом деле уже стоит.
 *
 * Модуль решает ровно это:
 *
 *   1. `parseExistingStructures` — разбирает ответ `/api/architect/existing`
 *      (сайты Raven Colonial + станции EDSM) в один список построек;
 *   2. `adoptExisting` — добавляет их в план, не создавая дублей и не трогая
 *      то, что архитектор уже поставил руками.
 *
 * Модуль чистый: ни сети, ни React — поэтому проверяется тестами
 * (`scripts/tests/architect-existing.test.mjs`).
 */

import { addSite, getInstallation, setSiteStatus } from './planner.ts';
import { normalizeBuildType } from './progress.ts';
import type { ArchitectPlan, PlannedSiteStatus } from './types.ts';

/** Откуда узнали о постройке. */
export type ExistingSource = 'raven' | 'edsm';

/** Одна реально существующая постройка системы. */
export interface ExistingStructure {
  /** Стабильный ключ для списка и выбора в интерфейсе. */
  key: string;
  /** Как постройка называется в игре. */
  name: string;
  /** Исходный тип из источника — показывается, когда тип не опознан. */
  rawType: string | null;
  /** Опознанный id каталога; null — тип неизвестен, в план не переносим. */
  installationId: string | null;
  bodyName: string | null;
  status: PlannedSiteStatus;
  /** Процент готовности, если источник его сообщает. */
  progress: number | null;
  source: ExistingSource;
}

/**
 * Типы станций EDSM → id каталога.
 *
 * EDSM отдаёт человекочитаемый `type` станции, а не игровой `buildType`, и это
 * единственный источник по системам, застроенным до Trailblazers. Сопоставление
 * идёт по классу постройки: конкретный «макет» (Dual Truss / Quad Truss)
 * EDSM не знает, поэтому берётся представитель класса.
 */
export const EDSM_STATION_TYPES: Record<string, string> = {
  'coriolisstarport': 'no_truss',
  'orbisstarport': 'apollo',
  'ocellusstarport': 'ocellus',
  'bernallsphere': 'ocellus',
  'asteroidbase': 'asteroid',
  'megaship': '',
  'outpost': 'vulcan',
  'civilianoutpost': 'vulcan',
  'commercialoutpost': 'plutus',
  'industrialoutpost': 'vulcan',
  'militaryoutpost': 'nemesis',
  'miningoutpost': 'dysnomia',
  'scientificoutpost': 'vesta',
  'planetaryoutpost': 'hestia',
  'planetaryport': 'zeus',
  'crateroutpost': 'hestia',
  'craterport': 'zeus',
  'odysseysettlement': 'consus',
  'settlement': 'consus',
};

function cleanKey(value: unknown): string {
  return String(value ?? '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function bodyKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function statusOf(raw: unknown, complete: boolean, progress: number | null): PlannedSiteStatus {
  if (complete) return 'complete';
  const token = String(raw ?? '').trim().toLowerCase();
  if (token === 'complete' || token === 'done' || token === 'built') return 'complete';
  if (token === 'build' || token === 'building' || token === 'construction') return 'building';
  if (progress != null && progress >= 100) return 'complete';
  if (progress != null && progress > 0) return 'building';
  return 'plan';
}

/** EDSM-тип станции → id каталога; пустая строка в таблице означает «не постройка колонизации». */
export function installationFromStationType(value: unknown): string | null {
  const key = cleanKey(value);
  if (!key) return null;
  const mapped = EDSM_STATION_TYPES[key];
  if (mapped === '') return null;
  if (mapped) return mapped;
  // Неизвестный EDSM-тип может оказаться игровым токеном — пробуем общий разбор.
  return normalizeBuildType(String(value));
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Разбор ответа `/api/architect/existing`.
 *
 * Функция тотальная: на битом ответе возвращает пустой список, чтобы страница
 * архитектора продолжала работать при недоступном Raven или EDSM.
 * Дубли (одна и та же станция пришла и из Raven, и из EDSM) схлопываются по
 * паре «тело + постройка»; приоритет у Raven — он знает точный `buildType`.
 */
export function parseExistingStructures(payload: unknown): ExistingStructure[] {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const out: ExistingStructure[] = [];
  const seen = new Set<string>();

  const push = (entry: ExistingStructure) => {
    const dedupe = `${bodyKey(entry.bodyName)}|${entry.installationId ?? cleanKey(entry.name)}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push(entry);
  };

  const ravenSites = Array.isArray(record?.sites) ? (record!.sites as unknown[]) : [];
  ravenSites.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const site = raw as Record<string, unknown>;
    const rawType = typeof site.buildType === 'string' ? site.buildType : null;
    const progress = num(site.progress);
    const complete = site.complete === true;
    const status = statusOf(site.status, complete, progress);
    push({
      key: `raven:${String(site.id ?? site.buildId ?? index)}`,
      name: typeof site.name === 'string' && site.name.trim() ? site.name : (rawType ?? 'Постройка'),
      rawType,
      installationId: normalizeBuildType(rawType),
      bodyName: typeof site.bodyName === 'string' && site.bodyName.trim() ? site.bodyName : null,
      status,
      progress,
      source: 'raven',
    });
  });

  const stations = Array.isArray(record?.stations) ? (record!.stations as unknown[]) : [];
  stations.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const station = raw as Record<string, unknown>;
    const rawType = typeof station.type === 'string' ? station.type : null;
    const installationId = installationFromStationType(rawType);
    if (!installationId && !rawType) return;
    // Флотоносцы игроков и мегакорабли кочуют между системами — это не застройка.
    if (/carrier|mega\s*ship/i.test(String(rawType ?? ''))) return;
    push({
      key: `edsm:${String(station.id ?? station.marketId ?? index)}`,
      name: typeof station.name === 'string' && station.name.trim() ? station.name : (rawType ?? 'Станция'),
      rawType,
      installationId,
      bodyName: typeof station.bodyName === 'string' && station.bodyName.trim() ? station.bodyName : null,
      // Станция в EDSM существует — значит достроена.
      status: 'complete',
      progress: 100,
      source: 'edsm',
    });
  });

  return out;
}

export interface AdoptResult {
  plan: ArchitectPlan;
  /** Что добавлено в план. */
  added: ExistingStructure[];
  /** Уже было в плане: статус подтянут к факту, дубль не создан. */
  updated: ExistingStructure[];
  /** Тип постройки не опознан — переносить нечего, показываем списком. */
  unknown: ExistingStructure[];
}

export interface AdoptOptions {
  /** Ключи построек, которые надо перенести; не задан — переносим все опознанные. */
  keys?: string[];
  /** Переносить ли недостроенные площадки (по умолчанию да). */
  includeUnfinished?: boolean;
}

/**
 * Перенос фактической застройки в план.
 *
 * Правила намеренно консервативные: план архитектора — его документ, поэтому
 *
 *   * ничего не удаляется;
 *   * если такая постройка на этом теле в плане уже есть, создаётся не дубль,
 *     а обновление статуса («план» → «готово»);
 *   * неопознанные типы не превращаются в выдуманные постройки, а честно
 *     возвращаются в `unknown`.
 */
export function adoptExisting(
  plan: ArchitectPlan,
  structures: ExistingStructure[],
  options: AdoptOptions = {},
): AdoptResult {
  const wanted = options.keys ? new Set(options.keys) : null;
  const includeUnfinished = options.includeUnfinished !== false;
  const added: ExistingStructure[] = [];
  const updated: ExistingStructure[] = [];
  const unknown: ExistingStructure[] = [];
  let next = plan;

  for (const structure of structures) {
    if (wanted && !wanted.has(structure.key)) continue;
    if (!structure.installationId || !getInstallation(structure.installationId)) {
      unknown.push(structure);
      continue;
    }
    if (!includeUnfinished && structure.status !== 'complete') continue;

    const targetBody = bodyKey(structure.bodyName);
    const existing = next.sites.find(
      (site) => site.installationId === structure.installationId && bodyKey(site.bodyName) === targetBody,
    );
    if (existing) {
      if (existing.status !== structure.status) next = setSiteStatus(next, existing.id, structure.status);
      updated.push(structure);
      continue;
    }

    next = addSite(next, structure.bodyName ?? '', structure.installationId, {
      status: structure.status,
      note: `из факта: ${structure.name}`,
    });
    added.push(structure);
  }

  return { plan: next, added, updated, unknown };
}
