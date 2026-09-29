/**
 * Движок «Архитектора системы»: расчёт плана застройки под колонизацию.
 *
 * Что здесь считается (правила Elite Dangerous: Trailblazers / Operations):
 *
 * 1. **Наземные слоты тела.** Число площадок под поселения зависит от радиуса,
 *    типа тела и признаков (атмосфера, вулканизм, терраформирование, HMC).
 *    Тело без посадки, горячее 700 K или тяжелее 2.7 g слотов не даёт.
 * 2. **Очки системы (tier points).** Аванпосты и поселения T1 дают очки T2,
 *    постройки T2 дают очки T3, порты T2/T3 их тратят. Первый порт системы
 *    очков не стоит, а каждый следующий порт дороже: третий платный порт
 *    обходится вдвое (T3) или на 75 % за шаг дороже (T2).
 * 3. **Предшественники.** Военная установка невозможна без военного поселения,
 *    хаб — без соответствующего поселения или установки, и так далее.
 * 4. **Товары и тоннаж.** План превращается в список грузов, которые реально
 *    надо привезти: это то, что видят пилоты-перевозчики.
 *
 * Модуль не зависит от React и от сети, поэтому целиком покрыт тестами
 * (`scripts/tests/system-architect.test.mjs`).
 */

import { activeSignalKinds, mergeSignals, signalsFromRecord } from '../bodySignals.ts';
import { buildBodyIndex, normalizeBodyKey, resolveBodyName, sameBodyName } from './bodyNames.ts';
import {
  CATALOGUE_VERSION,
  COMMODITY_LABELS_RU,
  ECONOMY_LABELS_RU,
  INSTALLATIONS,
  PRE_REQS,
  SYSTEM_UNLOCKS,
} from './catalogue.ts';
import { economyBodyFit } from './economy.ts';
import type {
  ArchitectBody,
  ArchitectInstallation,
  ArchitectPlan,
  ArchitectPreReq,
  PlanEvaluation,
  PlanIssue,
  PlanStep,
  PlannedSite,
  PlannedSiteStatus,
  PlacementCheck,
  SystemEffectKey,
  SystemEffects,
  SystemEconomy,
} from './types.ts';

/** Версия формата плана: меняется, если меняется структура `ArchitectPlan`. */
export const PLAN_FORMAT_VERSION = 3;

/** Потолок наземных слотов у одного тела. */
export const SURFACE_SLOT_LIMIT = 7;

/** Защита от случайного ввода нереалистичного числа орбитальных слотов. */
export const ORBITAL_SLOT_LIMIT = 12;

/** Горячее этого наземную постройку не поставить. */
export const SURFACE_MAX_TEMP_K = 700;

/** Тяжелее этого наземную постройку не поставить. */
export const SURFACE_MAX_GRAVITY_G = 2.7;

const EMPTY_EFFECTS: SystemEffects = { pop: 0, mpop: 0, sec: 0, wealth: 0, tech: 0, sol: 0, dev: 0 };
const EFFECT_KEYS: SystemEffectKey[] = ['pop', 'mpop', 'sec', 'wealth', 'tech', 'sol', 'dev'];
const SITE_STATUSES: PlannedSiteStatus[] = ['plan', 'building', 'complete'];

const INSTALLATION_BY_ID = new Map<string, ArchitectInstallation>(
  INSTALLATIONS.map((installation) => [installation.id, installation]),
);

/** Постройка по игровому buildType. */
export function getInstallation(id: string | null | undefined): ArchitectInstallation | null {
  if (!id) return null;
  return INSTALLATION_BY_ID.get(id) ?? null;
}

/**
 * Может ли постройка быть основным портом системы.
 *
 * Основным портом бывает только порт (аванпост или звёздный порт): у таких
 * построек в каталоге есть список материалов основного порта (`primary`).
 */
export function canBePrimary(id: string | null | undefined): boolean {
  return getInstallation(id)?.primary != null;
}

/** Запись плана, отмеченная как основной порт. */
export function primarySiteOf(plan: ArchitectPlan): PlannedSite | null {
  return plan.sites.find((site) => site.primary && canBePrimary(site.installationId)) ?? null;
}

/**
 * Грузы записи плана с учётом роли: основной порт везёт «основной» список
 * материалов (дороже обычного), остальные — обычный.
 */
export function siteCargo(
  site: PlannedSite,
): { cargo: Record<string, number>; haulTons: number; isPrimaryPort: boolean } | null {
  const installation = getInstallation(site.installationId);
  if (!installation) return null;
  const isPrimaryPort = Boolean(site.primary) && installation.primary != null;
  const cargo = isPrimaryPort && installation.primary ? installation.primary.cargo : installation.cargo;
  const haulTons = Object.values(cargo).reduce((sum, tons) => sum + tons, 0);
  return { cargo, haulTons, isPrimaryPort };
}

/** Каталог с фильтрами — для панели выбора постройки. */
export function listInstallations(filter: {
  location?: 'orbital' | 'surface';
  tier?: number;
  query?: string;
} = {}): ArchitectInstallation[] {
  const query = (filter.query || '').trim().toLowerCase();
  return INSTALLATIONS.filter((installation) => {
    if (filter.location && installation.location !== filter.location) return false;
    if (filter.tier != null && installation.tier !== filter.tier) return false;
    if (!query) return true;
    return [installation.nameRu, installation.nameEn, installation.group, installation.id]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
}

/** Русское имя товара; если перевода нет — человекочитаемое из ключа. */
export function commodityLabel(key: string): string {
  const known = COMMODITY_LABELS_RU[key];
  if (known) return known;
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyText(value: unknown, denied: string[]): string {
  const text = str(value);
  if (!text) return '';
  return denied.some((denial) => text.toLowerCase().includes(denial)) ? '' : text;
}

/**
 * Полнота записи тела: по ней при дублях выбирается лучшая версия.
 * Сигналы весят больше — их отдаёт только сканер игрока.
 */
function bodyCompleteness(body: ArchitectBody): number {
  let score = 0;
  if (body.radiusKm > 0) score += 1;
  if (body.gravity > 0) score += 1;
  if (body.tempK > 0) score += 1;
  if (body.subType && body.subType !== 'Неизвестно') score += 1;
  if (body.distanceLs > 0) score += 1;
  if (body.bodyId != null) score += 1;
  if (body.landable) score += 1;
  if (body.hasAtmosphere) score += 1;
  if (body.volcanism) score += 1;
  if (body.hasRings) score += 1;
  if (activeSignalKinds(body.signals).length > 0) score += 4;
  return score;
}

/**
 * Слияние дублей одного тела: за основу берётся более полная запись, а её
 * пустые поля достраиваются из второй. Так тело, пришедшее дважды (из базы и
 * из EDSM, либо двумя строками с разным регистром имени), не превращается ни
 * в две карточки, ни в потерю данных.
 */
function mergeBodies(primary: ArchitectBody, secondary: ArchitectBody): ArchitectBody {
  const merged: ArchitectBody = {
    ...primary,
    bodyId: primary.bodyId ?? secondary.bodyId,
    subType: primary.subType && primary.subType !== 'Неизвестно' ? primary.subType : secondary.subType,
    distanceLs: primary.distanceLs > 0 ? primary.distanceLs : secondary.distanceLs,
    radiusKm: primary.radiusKm > 0 ? primary.radiusKm : secondary.radiusKm,
    gravity: primary.gravity > 0 ? primary.gravity : secondary.gravity,
    tempK: primary.tempK > 0 ? primary.tempK : secondary.tempK,
    landable: primary.landable || secondary.landable,
    terraformable: primary.terraformable || secondary.terraformable,
    hasAtmosphere: primary.hasAtmosphere || secondary.hasAtmosphere,
    volcanism: primary.volcanism || secondary.volcanism,
    hasRings: primary.hasRings || secondary.hasRings,
    signals: mergeSignals(primary.signals, secondary.signals),
    features: [...new Set([...primary.features, ...secondary.features])],
  };
  // Признаки зависят от слитых полей — пересобираем, чтобы фильтры не врали.
  const features = new Set(merged.features);
  if (merged.landable) features.add('landable');
  if (merged.terraformable) features.add('terraformable');
  if (merged.hasAtmosphere) features.add('atmosphere');
  if (merged.volcanism) features.add('volcanism');
  if (merged.hasRings) features.add('rings');
  for (const kind of activeSignalKinds(merged.signals)) features.add(`signal:${kind}`);
  merged.features = [...features];
  return merged;
}

/**
 * Тела системы из строк `system_scans` (или сырых ответов EDSM/журнала).
 *
 * Функция тотальная: на мусоре она возвращает пустой список, а не падает —
 * страница планировщика обязана жить и на неполных данных.
 *
 * Здесь же чистятся данные, которые иначе ломали интерфейс:
 *
 *   * **дубли** одного тела (разный регистр, лишние пробелы, одна и та же
 *     запись из двух источников) схлопываются в одну карточку — раньше они
 *     давали два блока с одинаковым именем и один и тот же React-ключ;
 *   * тела **без имени** получают уникальную подпись `<система> Body N`, а не
 *     одно и то же имя на всех;
 *   * расстояние округляется до сотых: `112.40000000000001 св. с` — это не
 *     точность, а мусор в интерфейсе.
 */
export function fromScanRecords(rows: unknown, systemName = ''): ArchitectBody[] {
  if (!Array.isArray(rows)) return [];
  const bodies: ArchitectBody[] = [];
  let unnamed = 0;
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const raw = asRecord(record.raw_data) ?? asRecord(record.rawData);
    const rawName = str(record.body_name ?? record.name ?? record.bodyName).replace(/\s+/g, ' ');
    let name = rawName;
    if (!name) {
      unnamed += 1;
      name = systemName ? `${systemName} Body ${unnamed}` : `Неизвестное тело ${unnamed}`;
    }
    const bodyType = str(record.body_type ?? record.type ?? record.bodyType).toLowerCase();
    const subType = str(record.sub_type ?? record.subType ?? record.planet_class ?? record.star_type);
    const parents = Array.isArray(record.parents) ? record.parents : [];
    const hasPlanetParent = parents.some((entry) => {
      const parent = asRecord(entry);
      if (!parent) return false;
      const planet = parent.Planet ?? parent.planet;
      return planet != null && Number(planet) > 0;
    });
    const kind: ArchitectBody['kind'] = bodyType === 'star'
      ? 'star'
      : hasPlanetParent || subType.toLowerCase().includes('moon')
        ? 'moon'
        : 'planet';

    const radiusM = num(record.radius_m ?? record.radiusM);
    const radiusKm = radiusM > 0
      ? radiusM / 1000
      : num(record.radius) > 0
        ? num(record.radius)
        : num(record.solarRadius) * 695_700;

    const terraformState = nonEmptyText(
      record.terraform_state ?? record.terraformingState ?? raw?.terraformingState ?? raw?.TerraformState,
      ['not terraformable', 'не терраформ', 'candidate'],
    );
    const atmosphere = nonEmptyText(
      record.atmosphere ?? record.atmosphere_type ?? record.atmosphereType ?? raw?.atmosphereType,
      ['no atmosphere', 'нет атмосферы'],
    );
    const volcanism = nonEmptyText(
      record.volcanism ?? record.volcanismType ?? raw?.volcanismType,
      ['no volcanism', 'нет вулканизма', 'no geo'],
    );
    const rings = Array.isArray(record.rings) ? record.rings : (Array.isArray(raw?.rings) ? (raw!.rings as unknown[]) : []);

    const features: string[] = [];
    const landable = Boolean(record.is_landable ?? record.landable ?? record.isLandable ?? raw?.isLandable);
    if (landable) features.push('landable');
    if (terraformState) features.push('terraformable');
    if (atmosphere) features.push('atmosphere');
    if (volcanism) features.push('volcanism');
    if (rings.length > 0) features.push('rings');
    // Сигналы тела: каждый вид становится признаком, чтобы по ним можно
    // было фильтровать и сортировать тела в планировщике.
    const signals = signalsFromRecord(record);
    for (const kind of activeSignalKinds(signals)) features.push(`signal:${kind}`);

    bodies.push({
      name,
      bodyId: Number.isSafeInteger(num(record.body_id ?? record.bodyId)) ? num(record.body_id ?? record.bodyId) : null,
      kind,
      subType: subType || bodyType || 'Неизвестно',
      distanceLs: Math.round(num(record.distance_ls ?? record.distanceLs ?? record.distanceToArrival) * 100) / 100,
      radiusKm: Math.round(radiusKm * 10) / 10,
      gravity: Math.round(num(record.gravity) * 100) / 100,
      tempK: Math.round(num(record.surface_temp_k ?? record.surfaceTemperature ?? record.temp_k)),
      landable,
      terraformable: Boolean(terraformState),
      hasAtmosphere: Boolean(atmosphere),
      volcanism: Boolean(volcanism),
      hasRings: rings.length > 0,
      signals,
      features,
    });
  }

  // Схлопывание дублей: ключ — нормализованное имя (регистр и пробелы значения
  // не имеют), при совпадении остаётся более полная запись, дополненная второй.
  const byKey = new Map<string, ArchitectBody>();
  for (const body of bodies) {
    const key = normalizeBodyKey(body.name);
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, body);
      continue;
    }
    byKey.set(key, bodyCompleteness(body) > bodyCompleteness(known)
      ? mergeBodies(body, known)
      : mergeBodies(known, body));
  }

  return [...byKey.values()].sort((left, right) => (
    left.distanceLs - right.distanceLs
    || (left.bodyId ?? Number.MAX_SAFE_INTEGER) - (right.bodyId ?? Number.MAX_SAFE_INTEGER)
    || left.name.localeCompare(right.name, 'ru')
  ));
}

/**
 * Сколько наземных слотов у тела.
 *
 * Правило то же, что использует сообщество (и Raven Colonial): базовое число по
 * радиусу плюс бонусы за признаки, потолок — 7. `-1` не возвращаем: неизвестное
 * тело даёт 0 слотов, а причина видна в `surfaceSlotReason`.
 */
export function predictSurfaceSlots(body: ArchitectBody | null | undefined): number {
  if (!body || body.kind === 'star') return 0;
  if (!body.landable) return 0;
  if (body.tempK > SURFACE_MAX_TEMP_K) return 0;
  if (body.gravity > SURFACE_MAX_GRAVITY_G) return 0;

  let slots = body.radiusKm < 1500 ? 1 : body.radiusKm < 3750 ? 2 : body.radiusKm < 6000 ? 3 : 4;
  if (body.subType.toLowerCase().includes('high metal content')) slots += 1;
  if (body.terraformable) slots += 1;
  if (body.volcanism) slots += 1;
  if (body.hasAtmosphere) slots += 2;
  return Math.min(slots, SURFACE_SLOT_LIMIT);
}

/** Почему тело не даёт наземных слотов (для подсказки в интерфейсе). */
export function surfaceSlotReason(body: ArchitectBody | null | undefined): string {
  if (!body) return 'Тело неизвестно';
  if (body.kind === 'star') return 'Звезда: наземных построек не бывает';
  if (!body.landable) return 'Нет посадки';
  if (body.tempK > SURFACE_MAX_TEMP_K) return `Слишком горячо (${body.tempK} K > ${SURFACE_MAX_TEMP_K} K)`;
  if (body.gravity > SURFACE_MAX_GRAVITY_G) return `Гравитация ${body.gravity} g > ${SURFACE_MAX_GRAVITY_G} g`;
  return '';
}

/**
 * Сколько орбитальных построек вмещает тело. `null` — без жёсткого лимита.
 *
 * Внешние каталоги тел не передают игровые орбитальные площадки. Поэтому для
 * планет и лун безопасное начальное значение — 0: доступными становятся только
 * тела, которым пользователь подтвердил число слотов на карточке. Звёзды
 * сохраняют прежнее поведение без жёсткого лимита.
 */
export function orbitalLimit(
  body: ArchitectBody | null | undefined,
  plan?: Pick<ArchitectPlan, 'orbitalSlots' | 'system'> | null,
): number | null {
  if (!body) return 0;
  if (body.kind === 'star') return null;
  for (const [bodyName, slots] of Object.entries(plan?.orbitalSlots ?? {})) {
    if (sameBodyName(bodyName, body.name, plan?.system)) return slots;
  }
  return 0;
}

/** Записать подтверждённое пользователем число орбитальных слотов тела. */
export function setOrbitalSlots(plan: ArchitectPlan, bodyName: string, slots: number): ArchitectPlan {
  const name = bodyName.trim().slice(0, 120);
  if (!name) return plan;
  const value = Math.max(0, Math.min(ORBITAL_SLOT_LIMIT, Math.trunc(Number(slots) || 0)));
  const orbitalSlots = { ...plan.orbitalSlots };
  // Не плодим ключи для разных написаний одного и того же тела.
  for (const knownName of Object.keys(orbitalSlots)) {
    if (knownName !== name && sameBodyName(knownName, name, plan.system)) delete orbitalSlots[knownName];
  }
  orbitalSlots[name] = value;
  return touched({ ...plan, orbitalSlots });
}

function needsPreReq(installation: ArchitectInstallation, sites: PlannedSite[]): string | null {
  const preReq = installation.preReq as ArchitectPreReq | undefined;
  if (!preReq) return null;
  const rule = PRE_REQS[preReq];
  if (!rule) return null;
  const satisfied = sites.some((site) => site.id !== undefined && rule.buildTypes.includes(site.installationId));
  return satisfied ? null : rule.label;
}

/**
 * Можно ли поставить постройку на тело в текущем плане.
 *
 * Очки системы здесь не проверяются: они считаются на весь план сразу в
 * `evaluatePlan`, потому что зависят от порядка стройки.
 */
export function placementCheck(
  body: ArchitectBody | null | undefined,
  installationId: string,
  plan: ArchitectPlan,
): PlacementCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const installation = getInstallation(installationId);
  if (!installation) return { ok: false, errors: ['Неизвестная постройка'], warnings };
  if (!body) return { ok: false, errors: ['Тело не найдено в данных системы'], warnings };

  // Имена тел в плане могут прийти из стороннего источника («A 1» вместо
  // «Sol A 1»), поэтому слоты считаем по терпимому сравнению имён — иначе
  // перенесённая застройка не занимала бы слоты и переполнение не ловилось.
  const others = plan.sites.filter((site) => sameBodyName(site.bodyName, body.name, plan.system));

  if (installation.location === 'surface') {
    const limit = predictSurfaceSlots(body);
    if (limit <= 0) errors.push(surfaceSlotReason(body) || 'Наземные постройки невозможны');
    else if (others.filter((site) => getInstallation(site.installationId)?.location === 'surface').length >= limit) {
      errors.push(`Свободных наземных слотов нет: занято ${limit} из ${limit}`);
    }
  } else {
    const limit = orbitalLimit(body, plan);
    const used = others.filter((site) => getInstallation(site.installationId)?.location === 'orbital').length;
    if (limit === 0) errors.push('У тела нет доступных орбитальных слотов');
    else if (limit !== null && used >= limit) {
      errors.push(`Свободных орбитальных слотов нет: занято ${limit} из ${limit}`);
    }
    if (installation.id === 'asteroid' && !body.hasRings) {
      errors.push('Астероидная база ставится только у пояса астероидов');
    }
  }

  const missingPreReq = needsPreReq(installation, plan.sites);
  if (missingPreReq) errors.push(`Сначала нужен предшественник: ${missingPreReq}`);

  if (others.some((site) => site.installationId === installation.id)) {
    warnings.push('Такая постройка на этом теле уже запланирована');
  }
  if (installation.location === 'surface' && body.terraformable) {
    warnings.push('Тело терраформируемое: часть площадки может уйти под терраформирование');
  }
  // Экономика постройки зависит от тела: у профильных экономик (добыча, сельское
  // хозяйство, переработка, промышленность, туризм) на неподходящем теле выхлоп
  // слабее — стоит предупредить. Звёзды не проверяем: их порты экономику тела не наследуют.
  if (body.kind !== 'star' && installation.influence !== 'none') {
    const fit = economyBodyFit(installation.influence, body);
    if (fit.level === 'weak') {
      warnings.push(`${ECONOMY_LABELS_RU[installation.influence]}: ${fit.reason}`);
    }
  }
  if (installation.tier === 3 && !plan.sites.some((site) => getInstallation(site.installationId)?.buildClass === 'starport')) {
    warnings.push('Порт T3 стоит 6 очков T3 — без построек T1/T2 очков не хватит');
  }
  if (body.kind === 'star' && installation.location === 'orbital' && others.length >= 2) {
    warnings.push('У звезды уже две орбитальные постройки — проверьте, нужна ли третья');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Пустой план. */
export function createPlan(system: string, architect = ''): ArchitectPlan {
  const now = new Date().toISOString();
  return {
    version: PLAN_FORMAT_VERSION,
    system: system.trim(),
    architect: architect.trim(),
    createdAt: now,
    updatedAt: now,
    notes: '',
    sites: [],
    orbitalSlots: {},
  };
}

let siteCounter = 0;
/** Локальный id записи плана — уникален в пределах сессии и не зависит от времени. */
export function nextSiteId(): string {
  siteCounter += 1;
  return `site-${Date.now().toString(36)}-${siteCounter}`;
}

function touched(plan: ArchitectPlan): ArchitectPlan {
  return { ...plan, updatedAt: new Date().toISOString() };
}

/** Убирает пометку основного порта со всех записей, кроме одной. */
function keepSinglePrimary(sites: PlannedSite[], keepSiteId: string): PlannedSite[] {
  return sites.map((site) => (site.id !== keepSiteId && site.primary ? { ...site, primary: undefined } : site));
}

/** Добавить постройку: возвращает новый план, старый не меняется. */
export function addSite(
  plan: ArchitectPlan,
  bodyName: string,
  installationId: string,
  extra: { note?: string; status?: PlannedSiteStatus; primary?: boolean } = {},
): ArchitectPlan {
  const wantsPrimary = extra.primary === true && canBePrimary(installationId);
  const site: PlannedSite = {
    id: nextSiteId(),
    bodyName,
    installationId,
    status: extra.status && SITE_STATUSES.includes(extra.status) ? extra.status : 'plan',
    primary: wantsPrimary || undefined,
    note: extra.note ? String(extra.note).slice(0, 300) : undefined,
  };
  const sites = wantsPrimary
    ? [...keepSinglePrimary(plan.sites, site.id), site]
    : [...plan.sites, site];
  return touched({ ...plan, sites });
}

export function removeSite(plan: ArchitectPlan, siteId: string): ArchitectPlan {
  return touched({ ...plan, sites: plan.sites.filter((site) => site.id !== siteId) });
}

export function setSiteStatus(plan: ArchitectPlan, siteId: string, status: PlannedSiteStatus): ArchitectPlan {
  if (!SITE_STATUSES.includes(status)) return plan;
  return touched({
    ...plan,
    sites: plan.sites.map((site) => (site.id === siteId ? { ...site, status } : site)),
  });
}

/**
 * Отметить или снять «основной порт» у записи.
 *
 * Основной порт в плане может быть только один: новая пометка снимает
 * прежнюю. Пометку можно поставить только порту — иначе план не меняется.
 */
export function setSitePrimary(plan: ArchitectPlan, siteId: string, primary: boolean): ArchitectPlan {
  const site = plan.sites.find((entry) => entry.id === siteId);
  if (!site) return plan;
  if (primary && !canBePrimary(site.installationId)) return plan;
  const sites = primary
    ? keepSinglePrimary(plan.sites, siteId).map((entry) => (entry.id === siteId ? { ...entry, primary: true } : entry))
    : plan.sites.map((entry) => (entry.id === siteId ? { ...entry, primary: undefined } : entry));
  return touched({ ...plan, sites });
}

/** Правка записи плана: что именно менять — каждое поле необязательно. */
export interface SitePatch {
  installationId?: string;
  bodyName?: string;
  status?: PlannedSiteStatus;
  note?: string | null;
  primary?: boolean;
}

/**
 * Редактирование уже добавленной в план постройки: тип, тело, статус,
 * заметка и роль основного порта. Проверки размещения (`placementCheck`)
 * остаются на вызывающем коде — здесь только аккуратное применение правок.
 */
export function updateSite(plan: ArchitectPlan, siteId: string, patch: SitePatch): ArchitectPlan {
  const site = plan.sites.find((entry) => entry.id === siteId);
  if (!site) return plan;

  const installationId = patch.installationId !== undefined
    ? (getInstallation(patch.installationId) ? patch.installationId : site.installationId)
    : site.installationId;
  const bodyName = patch.bodyName !== undefined ? patch.bodyName.trim().slice(0, 120) || site.bodyName : site.bodyName;
  const status = patch.status !== undefined && SITE_STATUSES.includes(patch.status) ? patch.status : site.status;
  const note = patch.note === undefined
    ? site.note
    : patch.note === null ? undefined : String(patch.note).slice(0, 300) || undefined;
  // Основным портом бывает только порт: смена типа на непригодный снимает пометку.
  const capable = canBePrimary(installationId);
  const primary = patch.primary === true && capable
    ? true
    : patch.primary === false || !capable ? undefined : site.primary;

  let sites: PlannedSite[] = plan.sites.map((entry) => (
    entry.id === siteId ? { ...entry, installationId, bodyName, status, note, primary } : entry
  ));
  if (primary) sites = keepSinglePrimary(sites, siteId);
  return touched({ ...plan, sites });
}

/** Указать командира, отвечающего за архитектуру системы. */
export function setPlanArchitect(plan: ArchitectPlan, architect: string): ArchitectPlan {
  return touched({ ...plan, architect: String(architect ?? '').trimStart().slice(0, 120) });
}

export function setPlanNotes(plan: ArchitectPlan, notes: string): ArchitectPlan {
  return touched({ ...plan, notes: String(notes ?? '').slice(0, 2000) });
}

/**
 * Порядок стройки.
 *
 * Выбираем по шагам: сначала первый порт системы (он бесплатный и даёт очки),
 * затем — самые «дешёвые» постройки, чьи предшественники уже стоят. Так план
 * читается как реальная последовательность рейсов, а не как список файлов.
 */
export function computeBuildOrder(plan: ArchitectPlan): string[] {
  const sites = plan.sites.slice();
  if (sites.length === 0) return [];

  // Основной порт строится первым; если он не отмечен, первым в порядке
  // остаётся первый звёздный порт (как в планах старого формата).
  const primary = primarySiteOf(plan)
    ?? sites.find((site) => getInstallation(site.installationId)?.buildClass === 'starport')
    ?? null;
  const remaining = new Set(sites.map((site) => site.id));
  const done = new Set<string>();
  const order: string[] = [];

  const installedTypes = () => sites.filter((site) => done.has(site.id)).map((site) => site.installationId);

  const weight = (site: PlannedSite): number[] => {
    const installation = getInstallation(site.installationId);
    const isPrimary = primary?.id === site.id;
    return [
      isPrimary ? 0 : 1,
      installation ? installation.needs.tier : 9,
      installation ? installation.needs.count : 99,
      installation ? installation.tier : 9,
      -(installation ? installation.score : 0),
      sites.indexOf(site),
    ];
  };

  const compare = (left: PlannedSite, right: PlannedSite): number => {
    const a = weight(left);
    const b = weight(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  };

  const satisfied = (site: PlannedSite): boolean => {
    const installation = getInstallation(site.installationId);
    if (!installation?.preReq) return true;
    const rule = PRE_REQS[installation.preReq];
    if (!rule) return true;
    return installedTypes().some((type) => rule.buildTypes.includes(type));
  };

  while (remaining.size > 0) {
    const candidates = sites.filter((site) => remaining.has(site.id));
    const eligible = candidates.filter(satisfied).sort(compare);
    const pick = eligible[0] ?? candidates.sort(compare)[0];
    if (!pick) break;
    remaining.delete(pick.id);
    done.add(pick.id);
    order.push(pick.id);
  }

  return order;
}

/**
 * «Налог» на дополнительные порты: третий платный порт системы стоит вдвое
 * (T3) или на 75 % за шаг дороже (T2). Правило повторяет игровое удорожание
 * портов и совпадает с тем, что показывает Raven Colonial.
 */
export function portTax(tier: number, cost: number, taxStep: number): number {
  if (taxStep <= 0) return cost;
  return tier === 3 ? cost + cost * taxStep : cost + Math.trunc(cost * 0.75 * taxStep);
}

/** Полный расчёт плана: очки, грузы, эффекты, порядок, замечания. */
export function evaluatePlan(plan: ArchitectPlan, bodies: ArchitectBody[] = []): PlanEvaluation {
  const issues: PlanIssue[] = [];
  // Тело записи ищется через индекс имён: план может хранить имя из чужого
  // источника, и строгое сравнение прятало бы такие постройки от расчёта.
  const bodyIndex = buildBodyIndex(bodies, plan.system);
  const bodyOf = (name: string): ArchitectBody | null => (
    bodies.length > 0 ? resolveBodyName(name, bodyIndex).body : null
  );
  const order = computeBuildOrder(plan);
  const sitesById = new Map(plan.sites.map((site) => [site.id, site]));
  const primarySite = primarySiteOf(plan);
  const hasPort = plan.sites.some((site) => {
    const buildClass = getInstallation(site.installationId)?.buildClass;
    return buildClass === 'starport' || buildClass === 'outpost';
  });

  const tierPoints = { tier2: 0, tier3: 0 };
  const tierSpent = { tier2: 0, tier3: 0 };
  const tierGiven = { tier2: 0, tier3: 0 };
  const portCosts: PlanEvaluation['portCosts'] = [];
  const timeline: PlanStep[] = [];
  const cargo: Record<string, number> = {};
  const effects: SystemEffects = { ...EMPTY_EFFECTS };
  const economies: Partial<Record<SystemEconomy, number>> = {};
  const surfaceUsage: PlanEvaluation['surfaceUsage'] = {};
  const orbitalUsage: PlanEvaluation['orbitalUsage'] = {};
  let score = 0;
  let haulTons = 0;
  let taxStep = -2;

  // Замечания по телам и слотам — до расчёта очков, чтобы список читался сверху вниз.
  for (const site of plan.sites) {
    const installation = getInstallation(site.installationId);
    const body = bodyOf(site.bodyName);
    if (!installation) {
      issues.push({ level: 'error', siteId: site.id, message: `Неизвестная постройка «${site.installationId}» — удалите запись или обновите каталог` });
      continue;
    }
    if (bodies.length > 0 && !body) {
      issues.push({
        level: 'warning',
        siteId: site.id,
        bodyName: site.bodyName,
        message: site.bodyName
          ? `Тело «${site.bodyName}» не найдено в данных системы`
          : `Не указано тело для «${installation.nameRu}»: задайте его в редакторе записи`,
      });
    }
    // Слоты считаем «без этой записи»: так переполнение видно на самой записи.
    const check = placementCheck(body, site.installationId, { ...plan, sites: plan.sites.filter((other) => other.id !== site.id) });
    for (const message of check.errors) issues.push({ level: 'error', siteId: site.id, bodyName: site.bodyName, message });
    for (const message of check.warnings) issues.push({ level: 'warning', siteId: site.id, bodyName: site.bodyName, message });
  }

  // Симулируем стройку в правильном порядке: очки приходят по мере завершения.
  for (const siteId of order) {
    const site = sitesById.get(siteId);
    if (!site) continue;
    const installation = getInstallation(site.installationId);
    if (!installation) continue;

    let cost = installation.needs.count;
    const isPort = installation.buildClass === 'starport';
    const isPrimary = primarySite?.id === site.id;
    if (isPort && installation.tier > 1 && !isPrimary) {
      taxStep += 1;
      cost = portTax(installation.needs.tier, cost, taxStep);
    } else if (isPort && isPrimary) {
      cost = 0;
    }

    if (isPort) {
      portCosts.push({
        siteId: site.id,
        installationId: installation.id,
        tier: installation.needs.tier,
        cost,
        taxed: cost > installation.needs.count,
      });
    }

    if (cost > 0) {
      const bucket = installation.needs.tier === 3 ? 'tier3' : 'tier2';
      if (tierPoints[bucket] < cost) {
        const missing = cost - tierPoints[bucket];
        issues.push({
          level: 'error',
          siteId: site.id,
          bodyName: site.bodyName,
          message: `Не хватает ${missing} очк. T${installation.needs.tier} для «${installation.nameRu}»: сначала постройте что-то из T${installation.needs.tier - 1}`,
        });
      }
      tierPoints[bucket] -= cost;
      tierSpent[bucket] += cost;
    }

    if (installation.gives.count > 0 && installation.gives.tier > 1) {
      const bucket = installation.gives.tier === 3 ? 'tier3' : 'tier2';
      tierPoints[bucket] += installation.gives.count;
      tierGiven[bucket] += installation.gives.count;
    }

    score += installation.score;
    // Основной порт везёт «основной» список материалов — дороже обычного.
    const effectiveCargo = siteCargo(site);
    const cargoMap = effectiveCargo ? effectiveCargo.cargo : installation.cargo;
    haulTons += effectiveCargo ? effectiveCargo.haulTons : installation.haulTons;
    for (const [key, tons] of Object.entries(cargoMap)) {
      cargo[key] = (cargo[key] ?? 0) + tons;
    }
    for (const key of EFFECT_KEYS) {
      effects[key] += installation.effects[key] ?? 0;
    }
    if (installation.influence !== 'none') {
      economies[installation.influence] = (economies[installation.influence] ?? 0) + 1;
    }

    if (installation.location === 'surface') {
      const body = bodyOf(site.bodyName);
      const limit = predictSurfaceSlots(body);
      // Ключ — каноническое имя тела: иначе одно тело попадало бы в отчёт
      // дважды под разными написаниями и слоты считались бы по отдельности.
      const key = body?.name ?? site.bodyName;
      const usage = surfaceUsage[key] ?? { used: 0, limit };
      usage.used += 1;
      usage.limit = limit;
      surfaceUsage[key] = usage;
    } else {
      const body = bodyOf(site.bodyName);
      const limit = orbitalLimit(body, plan);
      const key = body?.name ?? site.bodyName;
      const usage = orbitalUsage[key] ?? { used: 0, limit };
      usage.used += 1;
      usage.limit = limit;
      orbitalUsage[key] = usage;
    }

    // Снимок бюджета после шага — из него инфографика рисует график очков.
    const stepTons = effectiveCargo ? effectiveCargo.haulTons : installation.haulTons;
    timeline.push({
      index: timeline.length + 1,
      siteId: site.id,
      installationId: installation.id,
      nameRu: installation.nameRu,
      bodyName: site.bodyName,
      tier: installation.tier,
      status: site.status,
      primary: primarySite?.id === site.id,
      cost,
      costTier: cost > 0 ? installation.needs.tier : 0,
      gives: installation.gives.tier > 1 ? installation.gives.count : 0,
      givesTier: installation.gives.tier > 1 ? installation.gives.tier : 0,
      tier2After: tierPoints.tier2,
      tier3After: tierPoints.tier3,
      deficit: tierPoints.tier2 < 0 || tierPoints.tier3 < 0,
      tons: stepTons,
      tonsCumulative: haulTons,
    });
  }

  const installedTypes = plan.sites.map((site) => site.installationId);
  const unlocks = SYSTEM_UNLOCKS.map((unlock) => ({
    id: unlock.id,
    label: unlock.label,
    satisfied: unlock.buildTypes.some((type) => installedTypes.includes(type)),
  }));

  if (plan.sites.length > 0 && !hasPort) {
    issues.push({
      level: 'warning',
      message: 'В плане нет ни одного порта: система останется без статуса колонизированной',
    });
  }
  if (hasPort && !primarySite) {
    issues.push({
      level: 'warning',
      message: 'Не отмечен основной порт — все порты посчитаны платными. Для новой колонии отметьте порт, который строится с колониального корабля (он не тратит очки системы); если система уже колонизирована, снимите пометку с портов',
    });
  }

  const primaryInstallation = primarySite ? getInstallation(primarySite.installationId) : null;
  const primaryPort: PlanEvaluation['primaryPort'] = primarySite && primaryInstallation
    ? {
      siteId: primarySite.id,
      installationId: primarySite.installationId,
      bodyName: primarySite.bodyName,
      tons: siteCargo(primarySite)?.haulTons ?? primaryInstallation.haulTons,
      approximate: primaryInstallation.primary?.approximate === true,
      economy: primaryInstallation.influence,
    }
    : null;

  return {
    order,
    timeline,
    tierPoints,
    tierSpent,
    tierGiven,
    portCosts,
    primaryPort,
    cargo,
    haulTons,
    score,
    effects,
    economies,
    unlocks,
    issues,
    surfaceUsage,
    orbitalUsage,
  };
}

/**
 * Разбор сохранённого/импортированного плана.
 *
 * Возвращает `error`, если файл вообще не наш план, и `warning`, если план
 * удалось починить (чужая версия, неизвестные постройки, мусорные поля).
 */
export function parsePlan(raw: unknown): { plan: ArchitectPlan | null; error?: string; warning?: string } {
  let record = asRecord(raw);
  if (!record && typeof raw === 'string') {
    try {
      record = asRecord(JSON.parse(raw));
    } catch {
      return { plan: null, error: 'Файл не является JSON' };
    }
  }
  if (!record) return { plan: null, error: 'Ожидался объект плана' };
  if (Array.isArray(record.sites) === false && record.sites !== undefined) {
    return { plan: null, error: 'Поле sites должно быть списком' };
  }

  const warnings: string[] = [];
  const version = num(record.version);
  if (version && version !== PLAN_FORMAT_VERSION) {
    warnings.push(`Файл сохранён в формате v${version}, текущий v${PLAN_FORMAT_VERSION} — часть полей могла измениться`);
  }
  if (num(record.catalogue) && num(record.catalogue) !== CATALOGUE_VERSION) {
    warnings.push(`План считался по каталогу v${num(record.catalogue)}, сейчас v${CATALOGUE_VERSION}: стоимости могли измениться`);
  }

  const sites: PlannedSite[] = [];
  for (const entry of Array.isArray(record.sites) ? record.sites : []) {
    const site = asRecord(entry);
    if (!site) continue;
    const installationId = str(site.installationId ?? site.buildType);
    const bodyName = str(site.bodyName ?? site.body_name);
    if (!installationId || !bodyName) continue;
    if (!getInstallation(installationId)) {
      warnings.push(`Неизвестная постройка «${installationId}» пропущена`);
      continue;
    }
    const status = str(site.status);
    const primary = site.primary === true;
    if (primary && !canBePrimary(installationId)) {
      warnings.push(`Пометка «основной порт» снята с постройки «${getInstallation(installationId)?.nameRu ?? installationId}»: основным портом бывает только порт`);
    }
    sites.push({
      id: str(site.id) || nextSiteId(),
      bodyName,
      installationId,
      status: SITE_STATUSES.includes(status as PlannedSiteStatus) ? (status as PlannedSiteStatus) : 'plan',
      primary: primary && canBePrimary(installationId) ? true : undefined,
      note: str(site.note) ? str(site.note).slice(0, 300) : undefined,
    });
  }

  // Основной порт в плане один: лишние пометки снимаем, честно предупреждая.
  const primaryIndex = sites.findIndex((site) => site.primary);
  if (primaryIndex >= 0) {
    for (let index = primaryIndex + 1; index < sites.length; index += 1) {
      if (sites[index].primary) {
        warnings.push(`Основным портом остаётся только «${getInstallation(sites[primaryIndex].installationId)?.nameRu}» — пометка с «${getInstallation(sites[index].installationId)?.nameRu}» снята`);
        sites[index] = { ...sites[index], primary: undefined };
      }
    }
  }

  // Старый формат (v1) не знал явной пометки: первый звёздный порт в нём всегда
  // считался бесплатным, поэтому миграция отмечает его основным — расчёт старого
  // плана сохраняет смысл.
  if (version > 0 && version < 2 && !sites.some((site) => site.primary)) {
    const firstPort = sites.find((site) => getInstallation(site.installationId)?.buildClass === 'starport');
    if (firstPort) {
      firstPort.primary = true;
      warnings.push('План сохранён в старом формате: первый звёздный порт отмечен основным, тоннаж пересчитан по списку материалов основного порта');
    }
  }

  const system = str(record.system ?? record.systemName) || 'Неизвестная система';
  const orbitalSlots: Record<string, number> = {};
  const rawOrbitalSlots = asRecord(record.orbitalSlots ?? record.orbital_slots);
  for (const [rawName, rawSlots] of Object.entries(rawOrbitalSlots ?? {})) {
    const name = rawName.trim().slice(0, 120);
    const slots = Math.trunc(num(rawSlots));
    if (name && Number.isFinite(slots) && slots >= 0) orbitalSlots[name] = Math.min(slots, ORBITAL_SLOT_LIMIT);
  }
  // Старые планы не знали лимита. Сохраняем уже запланированные орбитальные
  // объекты доступными, даже если их на одном теле больше нового дефолта.
  if (version > 0 && version < 3) {
    for (const site of sites) {
      if (getInstallation(site.installationId)?.location !== 'orbital') continue;
      const knownName = Object.keys(orbitalSlots).find((name) => sameBodyName(name, site.bodyName, system));
      const key = knownName ?? site.bodyName;
      orbitalSlots[key] = (orbitalSlots[key] ?? 0) + 1;
    }
  }

  const now = new Date().toISOString();
  return {
    plan: {
      version: PLAN_FORMAT_VERSION,
      system,
      architect: str(record.architect).trim().slice(0, 120),
      createdAt: str(record.createdAt) || now,
      updatedAt: now,
      notes: str(record.notes).slice(0, 2000),
      sites,
      orbitalSlots,
    },
    warning: warnings.length ? warnings.join('; ') : undefined,
  };
}

/** Сериализация для экспорта: с версией каталога, чтобы импорт был честным. */
export function serializePlan(plan: ArchitectPlan): string {
  return JSON.stringify({ ...plan, catalogue: CATALOGUE_VERSION }, null, 2);
}

/**
 * Постройки плана в формате оверрея (`lib/systemOrrery`): та же сцена карты
 * системы показывает запланированные объекты без отдельного движка.
 */
export function planToStructures(plan: ArchitectPlan): {
  id: string;
  name: string;
  type: string;
  bodyName: string;
  progress: number;
  complete: boolean;
  requiredTons: number;
  providedTons: number;
  surface: boolean;
  resources: { name: string; required: number; provided: number }[];
}[] {
  return plan.sites.flatMap((site) => {
    const installation = getInstallation(site.installationId);
    if (!installation) return [];
    const effectiveCargo = siteCargo(site);
    const requiredTons = effectiveCargo ? effectiveCargo.haulTons : installation.haulTons;
    const cargoMap = effectiveCargo ? effectiveCargo.cargo : installation.cargo;
    const complete = site.status === 'complete';
    const baseName = site.note ? `${installation.nameRu} — ${site.note}` : installation.nameRu;
    return [{
      id: site.id,
      name: effectiveCargo?.isPrimaryPort ? `★ ${baseName}` : baseName,
      type: installation.nameEn,
      bodyName: site.bodyName,
      progress: complete ? 100 : site.status === 'building' ? 50 : 0,
      complete,
      requiredTons,
      providedTons: complete ? requiredTons : 0,
      surface: installation.location === 'surface',
      resources: Object.entries(cargoMap)
        .sort((left, right) => right[1] - left[1])
        .map(([key, tons]) => ({ name: commodityLabel(key), required: tons, provided: complete ? tons : 0 })),
    }];
  });
}

/** Товары плана списком, от тяжёлых к лёгким. */
export function cargoList(evaluation: PlanEvaluation): { key: string; label: string; tons: number }[] {
  return Object.entries(evaluation.cargo)
    .map(([key, tons]) => ({ key, label: commodityLabel(key), tons }))
    .sort((left, right) => right.tons - left.tons || left.label.localeCompare(right.label));
}

/** Форматирование тоннажа: 53 723 т. */
export function formatTons(tons: number): string {
  if (!Number.isFinite(tons)) return '—';
  return `${Math.round(tons).toLocaleString('ru-RU')} т`;
}

/** Человекочитаемая сводка плана — для буфера обмена и отчёта эскадрилье. */
export function summarizePlan(plan: ArchitectPlan, evaluation: PlanEvaluation): string {
  const lines: string[] = [];
  const sitesById = new Map(plan.sites.map((site) => [site.id, site]));
  lines.push(`План застройки: ${plan.system}${plan.architect ? ` (архитектор ${plan.architect})` : ''}`);
  lines.push(`Построек: ${plan.sites.length}, тоннаж: ${formatTons(evaluation.haulTons)}, оценка системы: ${evaluation.score}`);
  lines.push(`Очки системы: T2 ${evaluation.tierPoints.tier2 >= 0 ? '+' : ''}${evaluation.tierPoints.tier2}, T3 ${evaluation.tierPoints.tier3 >= 0 ? '+' : ''}${evaluation.tierPoints.tier3}`);

  if (evaluation.primaryPort) {
    const installation = getInstallation(evaluation.primaryPort.installationId);
    lines.push(`Основной порт: ${installation?.nameRu ?? evaluation.primaryPort.installationId} — ${evaluation.primaryPort.bodyName} (${formatTons(evaluation.primaryPort.tons)})`);
  }

  const orderLines = evaluation.order
    .map((siteId, index) => {
      const site = sitesById.get(siteId);
      const installation = site ? getInstallation(site.installationId) : null;
      if (!site || !installation) return null;
      const tons = siteCargo(site)?.haulTons ?? installation.haulTons;
      return `${index + 1}. ${site.primary ? '★ ' : ''}${installation.nameRu} — ${site.bodyName} (${formatTons(tons)})`;
    })
    .filter((line): line is string => Boolean(line));
  if (orderLines.length) {
    lines.push('', 'Порядок стройки:');
    lines.push(...orderLines);
  }

  const cargo = cargoList(evaluation).slice(0, 10);
  if (cargo.length) {
    lines.push('', 'Основные грузы:');
    lines.push(...cargo.map((item) => `${item.label}: ${formatTons(item.tons)}`));
  }

  const errors = evaluation.issues.filter((issue) => issue.level === 'error');
  if (errors.length) {
    lines.push('', 'Ошибки плана:');
    lines.push(...errors.map((issue) => `• ${issue.message}`));
  }

  lines.push('', `Сформировано в ED Ring Colony, каталог v${CATALOGUE_VERSION}.`);
  return lines.join('\n');
}
