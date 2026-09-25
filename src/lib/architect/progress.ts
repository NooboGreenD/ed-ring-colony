/**
 * Сверка плана архитектора с фактическими стройплощадками системы.
 *
 * Данные о факте приходят из Raven Colonial через `/api/systems/progress`
 * (`src/lib/ravenColonial.ts`): список проектов с `buildType`, `bodyName`,
 * прогрессом и тоннажом. Задача модуля — честно сопоставить их с записями
 * плана и показать расхождения в обе стороны:
 *
 *   * что из плана уже строится или построено (и насколько);
 *   * что стоит на площадке, но в плане не значится;
 *   * что запланировано, но ещё не началось.
 *
 * Совпадение ищется в три прохода — точное (тип + тело), по типу (тело могло
 * не доехать в данных) и по телу с классом постройки (Raven для старых
 * проектов отдаёт класс вместо конкретного типа). Каждый фактический объект
 * сопоставляется не более чем с одной записью плана, порядок проходов
 * детерминирован — иначе сводка «прыгала» бы между обновлениями.
 *
 * Модуль чистый: ни сети, ни React, поэтому покрыт тестами
 * (`scripts/tests/architect-progress.test.mjs`).
 */

import { getInstallation } from './planner.ts';
import type { ArchitectBuildClass, ArchitectPlan, PlannedSite } from './types.ts';

/**
 * Игровые `buildType` из Raven: варианты одной и той же постройки и устаревшие
 * имена приводятся к id из нашего каталога.
 */
export const BUILD_TYPE_ALIASES: Record<string, string> = {
  // Звёздные порты: макеты одного класса.
  coriolis: 'no_truss',
  dual_truss: 'no_truss',
  quad_truss: 'no_truss',
  no_truss: 'no_truss',
  asteroid: 'asteroid',
  dodec: 'dodec',
  quint_truss: 'dodec',
  dec_truss: 'dodec',
  ocellus: 'ocellus',
  apollo: 'apollo',
  artemis: 'apollo',
  orbis: 'apollo',
  // Орбитальные аванпосты.
  plutus: 'plutus',
  vulcan: 'vulcan',
  dysnomia: 'dysnomia',
  vesta: 'vesta',
  prometheus: 'prometheus',
  nemesis: 'nemesis',
  // Орбитальные установки.
  hermes: 'hermes',
  angelia: 'hermes',
  eirene: 'hermes',
  pistis: 'pistis',
  soter: 'pistis',
  aletheia: 'pistis',
  demeter: 'demeter',
  apate: 'apate',
  taverna: 'apate',
  euthenia: 'euthenia',
  phorcys: 'euthenia',
  enodia: 'enodia',
  ichnaea: 'enodia',
  vacuna: 'vacuna',
  alastor: 'vacuna',
  dicaeosyne: 'dicaeosyne',
  eunomia: 'dicaeosyne',
  nomos: 'dicaeosyne',
  poena: 'dicaeosyne',
  harmonia: 'harmonia',
  asclepius: 'asclepius',
  eupraxia: 'asclepius',
  astraeus: 'astraeus',
  coeus: 'astraeus',
  dione: 'astraeus',
  dodona: 'astraeus',
  hedone: 'hedone',
  opora: 'hedone',
  pasithea: 'hedone',
  dionysus: 'dionysus',
  bacchus: 'dionysus',
  // Наземные аванпосты и порт.
  hestia: 'hestia',
  atropos: 'hestia',
  clotho: 'hestia',
  decima: 'hestia',
  lachesis: 'hestia',
  hephaestus: 'hephaestus',
  bia: 'hephaestus',
  mefitis: 'hephaestus',
  opis: 'hephaestus',
  ponos: 'hephaestus',
  necessitas: 'necessitas',
  ananke: 'necessitas',
  antevorta: 'necessitas',
  fauna: 'necessitas',
  zeus: 'zeus',
  aphrodite: 'zeus',
  hera: 'zeus',
  poseidon: 'zeus',
  // Поселения: размеры внутри одной ветки.
  consus: 'consus',
  picumnus: 'picumnus',
  annona: 'picumnus',
  ceres: 'ceres',
  fornax: 'ceres',
  ourea: 'ourea',
  mantus: 'mantus',
  orcus: 'mantus',
  erebus: 'erebus',
  aerecura: 'erebus',
  fontus: 'fontus',
  meteope: 'meteope',
  minthe: 'meteope',
  palici: 'meteope',
  gaea: 'gaea',
  ioke: 'ioke',
  bellona: 'bellona',
  enyo: 'bellona',
  polemos: 'bellona',
  minerva: 'minerva',
  pheobe: 'pheobe',
  phoebe: 'pheobe',
  asteria: 'asteria',
  caerus: 'asteria',
  chronos: 'chronos',
  aergia: 'aergia',
  comus: 'comus',
  gelos: 'comus',
  fufluns: 'fufluns',
  // Хабы.
  tartarus: 'tartarus',
  aegle: 'aegle',
  tellus: 'tellus',
  tellus_e: 'tellus',
  tellus_i: 'molae',
  eunostus: 'molae',
  molae: 'molae',
  io: 'io',
  athena: 'athena',
  caelus: 'athena',
  alala: 'alala',
  ares: 'alala',
  silenus: 'silenus',
  janus: 'janus',
};

/** Классы, которыми Raven подменяет конкретный тип у старых проектов. */
const GENERIC_TYPES = new Set(['installation', 'outpost', 'settlement', 'facility', 'port', 'planetary']);

/**
 * Слова игрового токена: `$Agricultural_Settlement; (primary)` →
 * `['agricultural', 'settlement', 'primary']`.
 *
 * Нужно, чтобы узнавать класс постройки в токенах, где перед классом стоит
 * экономика (`$Agricultural_Settlement;`): целиком такая строка в таблицу
 * псевдонимов не попадает, а слово `settlement` в ней есть.
 */
function tokenWords(value: unknown): string[] {
  return String(value ?? '')
    .replace(/\s*\(primary\)\s*$/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

/** Есть ли в токене слово класса — то есть Raven назвал класс, а не тип. */
function isGenericToken(value: unknown): boolean {
  return tokenWords(value).some((word) => GENERIC_TYPES.has(word));
}

/**
 * Таблица псевдонимов в нормализованном виде: ключи `BUILD_TYPE_ALIASES`
 * пишутся по-человечески (`no_truss`), а ищем мы по строке без разделителей
 * (`notruss`) — иначе `no_truss` из Raven не находился бы сам в себе.
 */
const ALIAS_LOOKUP: Record<string, string> = Object.fromEntries(
  Object.entries(BUILD_TYPE_ALIASES).map(([alias, id]) => [
    alias.replace(/[^a-z0-9]+/gi, '').toLowerCase(),
    id,
  ]),
);

function lookup(cleaned: string): string | null {
  if (!cleaned) return null;
  const byAlias = ALIAS_LOOKUP[cleaned];
  if (byAlias) return byAlias;
  return getInstallation(cleaned)?.id ?? null;
}

/** `$Coriolis_Starport; (primary)` → `no_truss`; неизвестное → null. */
export function normalizeBuildType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\s*\(primary\)\s*$/i, '')
    .replace(/^\$+/, '')
    .replace(/_name;?$/i, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
  const direct = lookup(cleaned);
  if (direct) return direct;
  // Игровые токены пишут класс постройки суффиксом: `$Coriolis_Starport;` →
  // `coriolisstarport`. Отбрасываем слово класса и пробуем снова — иначе
  // площадка порта не сопоставилась бы с планом.
  const withoutClass = cleaned.replace(/(starport|settlement|installation|outpost|hub|port)$/, '');
  return withoutClass && withoutClass !== cleaned ? lookup(withoutClass) : null;
}

/** Фактическая стройплощадка — то, что отдаёт Raven Colonial. */
export interface ActualSite {
  buildId: string;
  name: string;
  buildType: string | null;
  bodyName: string | null;
  progress: number;
  complete: boolean;
  totalRequired?: number | null;
  totalProvided?: number | null;
  totalRemaining?: number | null;
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Разбор ответа `/api/systems/progress` в список площадок.
 *
 * Функция тотальная: на пустом или битом ответе возвращает пустой список —
 * страница планировщика обязана жить и когда Raven недоступен.
 */
export function parseActualSites(payload: unknown): ActualSite[] {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const projects = Array.isArray(record?.projects) ? (record!.projects as unknown[]) : [];
  const sites: ActualSite[] = [];
  for (const entry of projects) {
    if (!entry || typeof entry !== 'object') continue;
    const project = entry as Record<string, unknown>;
    const buildType = typeof project.buildType === 'string' ? project.buildType : null;
    const bodyName = typeof project.bodyName === 'string' ? project.bodyName : null;
    const complete = project.complete === true;
    const progress = Math.min(100, Math.max(0, Math.round(num(project.progress) * 100) / 100));
    sites.push({
      buildId: String(project.buildId ?? project.marketId ?? `${bodyName ?? 'site'}-${sites.length}`),
      name: typeof project.buildName === 'string' ? project.buildName : 'Стройплощадка',
      buildType,
      bodyName,
      progress: complete ? 100 : progress,
      complete,
      totalRequired: project.totalRequired == null ? null : num(project.totalRequired),
      totalProvided: project.totalProvided == null ? null : num(project.totalProvided),
      totalRemaining: project.totalRemaining == null ? null : num(project.totalRemaining),
    });
  }
  return sites;
}

export type MatchKind = 'exact' | 'type' | 'body' | 'none';

export interface SiteProgress {
  siteId: string;
  site: PlannedSite;
  actual: ActualSite | null;
  matchKind: MatchKind;
  /** Прогресс площадки в процентах; null — стройка ещё не началась. */
  progress: number | null;
  /** Привезено тонн; null — данных нет. */
  deliveredTons: number | null;
  /** Нужно тонн по данным площадки; null — данных нет. */
  requiredTons: number | null;
  /** Расхождение плана и факта по типу постройки. */
  mismatch?: string;
}

export interface ProgressReport {
  sites: SiteProgress[];
  /** Площадки, которых нет в плане. */
  unplanned: ActualSite[];
  /** Записи плана без начатой стройки. */
  notStarted: string[];
  matchedCount: number;
  completeCount: number;
  totals: {
    required: number | null;
    provided: number | null;
    remaining: number | null;
    /** Взвешенный по тоннажу прогресс системы; null — нет данных. */
    progress: number | null;
  };
}

function bodyKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function buildClassOf(site: PlannedSite): ArchitectBuildClass | null {
  return getInstallation(site.installationId)?.buildClass ?? null;
}

/**
 * Сопоставление плана и факта.
 *
 * `actualSites` — площадки из Raven; пустой список означает «данных нет», и
 * тогда отчёт честно говорит, что ни одна стройка не подтверждена, а не
 * выдумывает нулевой прогресс.
 */
export function matchProgress(plan: ArchitectPlan, actualSites: ActualSite[]): ProgressReport {
  const available = new Map<string, ActualSite>();
  for (const site of actualSites) available.set(site.buildId, site);

  const usedActual = new Set<string>();
  const sites: SiteProgress[] = [];

  const take = (site: PlannedSite, match: (actual: ActualSite) => boolean, kind: MatchKind): SiteProgress => {
    let found: ActualSite | null = null;
    for (const actual of available.values()) {
      if (usedActual.has(actual.buildId)) continue;
      if (match(actual)) {
        found = actual;
        break;
      }
    }
    if (found) usedActual.add(found.buildId);
    const required = found?.totalRequired ?? null;
    const provided = found?.totalProvided ?? null;
    return {
      siteId: site.id,
      site,
      actual: found,
      matchKind: found ? kind : 'none',
      progress: found ? found.progress : null,
      deliveredTons: provided,
      requiredTons: required,
      mismatch: found && found.buildType && normalizeBuildType(found.buildType) !== site.installationId
        ? `На площадке ${found.buildType}, в плане ${site.installationId}`
        : undefined,
    };
  };

  // Проход 1: тот же тип постройки на том же теле.
  for (const site of plan.sites) {
    const wantedBody = bodyKey(site.bodyName);
    sites.push(take(site, (actual) => (
      normalizeBuildType(actual.buildType) === site.installationId
      && bodyKey(actual.bodyName) === wantedBody
    ), 'exact'));
  }

  // Проход 2: тип совпал, тело в данных не указано или отличается.
  for (let index = 0; index < sites.length; index += 1) {
    const entry = sites[index];
    if (entry.actual) continue;
    sites[index] = take(entry.site, (actual) => normalizeBuildType(actual.buildType) === entry.site.installationId, 'type');
  }

  // Проход 3: то же тело и тот же класс постройки — так ловятся проекты,
  // где Raven отдал класс (`outpost`) вместо конкретного типа.
  for (let index = 0; index < sites.length; index += 1) {
    const entry = sites[index];
    if (entry.actual) continue;
    const wantedBody = bodyKey(entry.site.bodyName);
    const wantedClass = buildClassOf(entry.site);
    if (!wantedClass) continue;
    sites[index] = take(entry.site, (actual) => {
      if (bodyKey(actual.bodyName) !== wantedBody) return false;
      const normalized = normalizeBuildType(actual.buildType);
      if (normalized) return buildClassOf({ ...entry.site, installationId: normalized }) === wantedClass;
      // Токен вида `$Agricultural_Settlement;`: конкретного типа нет, но класс
      // постройки угадывается по слову в токене.
      return isGenericToken(actual.buildType);
    }, 'body');
  }

  const unplanned = actualSites.filter((actual) => !usedActual.has(actual.buildId));
  const notStarted = sites.filter((entry) => !entry.actual).map((entry) => entry.siteId);

  let required: number | null = null;
  let provided: number | null = null;
  for (const actual of actualSites) {
    if (actual.totalRequired != null) required = (required ?? 0) + actual.totalRequired;
    if (actual.totalProvided != null) provided = (provided ?? 0) + actual.totalProvided;
  }
  const remaining = required != null && provided != null ? Math.max(0, required - provided) : null;
  const progress = required != null && required > 0 && provided != null
    ? Math.round((provided / required) * 10000) / 100
    : null;

  return {
    sites,
    unplanned,
    notStarted,
    matchedCount: sites.filter((entry) => entry.actual).length,
    completeCount: sites.filter((entry) => entry.actual?.complete).length,
    totals: { required, provided, remaining, progress },
  };
}
