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

import { buildBodyIndex, normalizeBodyKey, resolveBodyName, type BodyIndex, type BodyMatchKind } from './bodyNames.ts';
import { addSite, getInstallation, setSitePrimary, setSiteStatus, updateSite } from './planner.ts';
import { normalizeBuildType } from './progress.ts';
import type { ArchitectBody, ArchitectPlan, PlannedSiteStatus } from './types.ts';

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
  /**
   * Имя тела, приведённое к каталогу системы (если каталог передан).
   * Именно оно уходит в план — иначе постройка «проваливалась» мимо
   * карточек тел и изменения плана были не видны.
   */
  bodyName: string | null;
  /** Как имя тела называлось в источнике — показывается, когда оно уточнено. */
  rawBodyName: string | null;
  /** Как нашли тело: точное имя, короткое обозначение, номер тела… */
  bodyMatch: BodyMatchKind;
  status: PlannedSiteStatus;
  /** Процент готовности, если источник его сообщает. */
  progress: number | null;
  /** Источник пометил постройку основным портом системы. */
  primary: boolean;
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

/**
 * Ключ имени станции для схлопывания дублей. В отличие от `cleanKey`
 * сохраняет буквы любых алфавитов: русские названия («Первый порт») иначе
 * превращались бы в пустую строку, и разные станции считались бы одной.
 */
function nameKey(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function bodyKey(value: string | null | undefined): string {
  return normalizeBodyKey(value);
}

/** Источник прямо пометил постройку основным портом системы. */
function isPrimaryToken(value: unknown, record: Record<string, unknown> | null = null): boolean {
  if (record) {
    if (record.isPrimaryPort === true || record.primaryPort === true || record.primary === true) return true;
  }
  return /\(\s*primary\s*\)/i.test(String(value ?? ''));
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

export interface ParseExistingOptions {
  /** Тела системы: по ним имена приводятся к каталогу (`A 1` → `<система> A 1`). */
  bodies?: ArchitectBody[];
  /** Имя системы — помогает отрезать префикс в коротких обозначениях. */
  system?: string;
  /** Готовый индекс тел, если он уже построен вызывающим кодом. */
  index?: BodyIndex;
}

/**
 * Разбор ответа `/api/architect/existing`.
 *
 * Функция тотальная: на битом ответе возвращает пустой список, чтобы страница
 * архитектора продолжала работать при недоступном Raven или EDSM.
 *
 * Что здесь важно:
 *
 *   * имена тел приводятся к каталогу системы (`resolveBodyName`), поэтому
 *     короткое `A 1` из Raven и полное `<система> A 1` из EDSM — одно тело;
 *   * дубли схлопываются по трём признакам: «тело + тип», «имя станции + тип»
 *     и «имя станции» — одна и та же станция приходит и из Raven, и из EDSM;
 *   * приоритет у Raven: он знает точный `buildType`, стадию стройки и
 *     пометку основного порта. При схлопывании запись Raven дополняется
 *     телом из EDSM, если у Raven тела не было.
 */
export function parseExistingStructures(
  payload: unknown,
  options: ParseExistingOptions = {},
): ExistingStructure[] {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const systemName = options.system
    ?? (typeof record?.system === 'string' ? (record.system as string) : '');
  const index = options.index
    ?? (options.bodies ? buildBodyIndex(options.bodies, systemName) : null);

  const out: ExistingStructure[] = [];
  const byDedupe = new Map<string, ExistingStructure>();

  const resolve = (raw: unknown, bodyId: unknown): { name: string | null; rawName: string | null; kind: BodyMatchKind } => {
    const rawName = typeof raw === 'string' && raw.trim() ? raw.replace(/\s+/g, ' ').trim() : null;
    if (!index) return { name: rawName, rawName, kind: rawName ? 'exact' : 'none' };
    const match = resolveBodyName(rawName, index, { bodyId: typeof bodyId === 'number' ? bodyId : null });
    if (match.name) return { name: match.name, rawName, kind: match.kind };
    return { name: rawName, rawName, kind: 'none' };
  };

  const push = (entry: ExistingStructure) => {
    // Ключи схлопывания: от самого точного к самому широкому.
    const named = nameKey(entry.name);
    const keys = [
      `body:${bodyKey(entry.bodyName)}|${entry.installationId ?? named}`,
      named ? `name:${named}|${entry.installationId ?? ''}` : '',
      // Одна и та же станция из Raven и EDSM: типы могут читаться по-разному,
      // но имя станции в игре уникально — по нему и схлопываем.
      named.length >= 3 && entry.installationId ? `station:${named}` : '',
    ].filter(Boolean);

    const hit = keys.map((key) => byDedupe.get(key)).find(Boolean);
    if (hit) {
      // Raven точнее EDSM: дополняем его запись тем, чего у него не было.
      if (hit.source === 'edsm' && entry.source === 'raven') {
        Object.assign(hit, entry, {
          bodyName: entry.bodyName ?? hit.bodyName,
          bodyMatch: entry.bodyName ? entry.bodyMatch : hit.bodyMatch,
        });
      } else if (!hit.bodyName && entry.bodyName) {
        hit.bodyName = entry.bodyName;
        hit.rawBodyName = entry.rawBodyName;
        hit.bodyMatch = entry.bodyMatch;
      }
      for (const key of keys) if (!byDedupe.has(key)) byDedupe.set(key, hit);
      return;
    }

    for (const key of keys) byDedupe.set(key, entry);
    out.push(entry);
  };

  const ravenSites = Array.isArray(record?.sites) ? (record!.sites as unknown[]) : [];
  ravenSites.forEach((raw, position) => {
    if (!raw || typeof raw !== 'object') return;
    const site = raw as Record<string, unknown>;
    const rawType = typeof site.buildType === 'string' ? site.buildType : null;
    const progress = num(site.progress);
    const complete = site.complete === true;
    const status = statusOf(site.status, complete, progress);
    const body = resolve(site.bodyName, site.bodyNum ?? site.bodyId);
    push({
      key: `raven:${String(site.id ?? site.buildId ?? position)}`,
      name: typeof site.name === 'string' && site.name.trim() ? site.name : (rawType ?? 'Постройка'),
      rawType,
      installationId: normalizeBuildType(rawType),
      bodyName: body.name,
      rawBodyName: body.rawName,
      bodyMatch: body.kind,
      status,
      progress,
      primary: isPrimaryToken(rawType, site),
      source: 'raven',
    });
  });

  const stations = Array.isArray(record?.stations) ? (record!.stations as unknown[]) : [];
  stations.forEach((raw, position) => {
    if (!raw || typeof raw !== 'object') return;
    const station = raw as Record<string, unknown>;
    const rawType = typeof station.type === 'string' ? station.type : null;
    const installationId = installationFromStationType(rawType);
    if (!installationId && !rawType) return;
    // Флотоносцы игроков и мегакорабли кочуют между системами — это не застройка.
    if (/carrier|mega\s*ship/i.test(String(rawType ?? ''))) return;
    const body = resolve(station.bodyName, station.bodyId);
    push({
      key: `edsm:${String(station.id ?? station.marketId ?? position)}`,
      name: typeof station.name === 'string' && station.name.trim() ? station.name : (rawType ?? 'Станция'),
      rawType,
      installationId,
      bodyName: body.name,
      rawBodyName: body.rawName,
      bodyMatch: body.kind,
      // Станция в EDSM существует — значит достроена.
      status: 'complete',
      progress: 100,
      primary: false,
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
  /** Постройки, тело которых не нашлось в каталоге системы. */
  unmatchedBodies: ExistingStructure[];
  /** Id добавленных/обновлённых записей плана — интерфейс их подсвечивает. */
  touchedSiteIds: string[];
  /** Тела плана, которых коснулся перенос: их карточки надо раскрыть. */
  touchedBodies: string[];
}

export interface AdoptOptions {
  /** Ключи построек, которые надо перенести; не задан — переносим все опознанные. */
  keys?: string[];
  /** Переносить ли недостроенные площадки (по умолчанию да). */
  includeUnfinished?: boolean;
  /** Тела системы: имена из источников приводятся к каталогу. */
  bodies?: ArchitectBody[];
  /** Готовый индекс тел (если он уже построен). */
  index?: BodyIndex;
  /** Имя системы — для отрезания префикса в коротких обозначениях. */
  system?: string;
  /** Переносить пометку основного порта из источника (по умолчанию да). */
  adoptPrimary?: boolean;
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
  const adoptPrimary = options.adoptPrimary !== false;
  const index = options.index
    ?? (options.bodies ? buildBodyIndex(options.bodies, options.system ?? plan.system) : null);

  const added: ExistingStructure[] = [];
  const updated: ExistingStructure[] = [];
  const unknown: ExistingStructure[] = [];
  const unmatchedBodies: ExistingStructure[] = [];
  const touchedSiteIds: string[] = [];
  const touchedBodies = new Set<string>();
  let next = plan;
  let primaryStructure: { siteId: string; structure: ExistingStructure } | null = null;

  for (const raw of structures) {
    if (wanted && !wanted.has(raw.key)) continue;
    if (!raw.installationId || !getInstallation(raw.installationId)) {
      unknown.push(raw);
      continue;
    }
    if (!includeUnfinished && raw.status !== 'complete') continue;
    const installationId: string = raw.installationId;

    // Имя тела приводим к каталогу и здесь: панель могла разобрать ответ
    // до того, как тела системы догрузились.
    const structure = index && raw.bodyName
      ? (() => {
        const match = resolveBodyName(raw.bodyName, index, {});
        return match.name && match.name !== raw.bodyName
          ? { ...raw, bodyName: match.name, rawBodyName: raw.rawBodyName ?? raw.bodyName, bodyMatch: match.kind }
          : raw;
      })()
      : raw;

    if (index && (!structure.bodyName || !index.byExact.has(bodyKey(structure.bodyName)))) {
      unmatchedBodies.push(structure);
    }

    const targetBody = bodyKey(structure.bodyName);
    const existing = next.sites.find(
      (site) => site.installationId === installationId && bodyKey(site.bodyName) === targetBody,
    );
    if (existing) {
      if (existing.status !== structure.status) next = setSiteStatus(next, existing.id, structure.status);
      // Тело могло быть записано коротким именем — чиним на каноническое.
      if (structure.bodyName && existing.bodyName !== structure.bodyName) {
        next = updateSite(next, existing.id, { bodyName: structure.bodyName });
      }
      updated.push(structure);
      touchedSiteIds.push(existing.id);
      if (existing.bodyName) touchedBodies.add(structure.bodyName ?? existing.bodyName);
      if (structure.primary) primaryStructure = { siteId: existing.id, structure };
      continue;
    }

    // Если тело не опознано, в план уходит имя из источника — потерять его
    // нельзя: по нему пользователь поймёт, к чему привязывать постройку.
    next = addSite(next, structure.bodyName ?? structure.rawBodyName ?? '', installationId, {
      status: structure.status,
      note: `из факта: ${structure.name}`,
    });
    const createdId = next.sites[next.sites.length - 1]?.id;
    if (createdId) {
      touchedSiteIds.push(createdId);
      if (structure.primary) primaryStructure = { siteId: createdId, structure };
    }
    if (structure.bodyName) touchedBodies.add(structure.bodyName);
    added.push(structure);
  }

  // Основной порт системы: если источник его знает, план должен считать
  // очки тиров от реальности, а не выдавать «бесплатный» первый порт заново.
  if (adoptPrimary && primaryStructure) {
    next = setSitePrimary(next, primaryStructure.siteId, true);
  }

  return {
    plan: next,
    added,
    updated,
    unknown,
    unmatchedBodies,
    touchedSiteIds,
    touchedBodies: [...touchedBodies],
  };
}
