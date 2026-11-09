/**
 * Проекты строительства на сайте — первичный источник для Helper.
 *
 * Почему сайт, а не Raven Colonial
 * -------------------------------
 * Raven Colonial — сторонний сервис: он отвечает 503, теряет ключи и меняет
 * схему без предупреждения. Пока проект жил только там, любой его сбой
 * означал «нет действующих проектов»: вкладка «Колонизатор» пустела, а
 * оверлей CARRIER писал «Проект не выбран». При этом данные были — их
 * присылал сам Helper.
 *
 * Теперь порядок обратный: Helper регистрирует проект здесь
 * (`POST /api/projects/register`), а в Raven дублирует, если тот доступен.
 * Модуль собирает карточку проекта из трёх источников и не зависит ни от
 * одного из них в отдельности:
 *
 *   * `construction_projects` — то, что прислал Helper (главный источник);
 *   * кэш Raven `system_progress.data.projects` — вклад других командиров;
 *   * `colonisation_sites` — снимки `ColonisationConstructionDepot` из
 *     журналов: точные `RequiredAmount`/`ProvidedAmount`.
 *
 * Модуль чистый: ни сети, ни Supabase — поэтому проверяется тестами
 * (`scripts/tests/site-projects.test.mjs`).
 */

/** Откуда взялась карточка. */
export type ProjectSourceKind = 'site' | 'raven' | 'journal';

/** Состояние проекта. `complete` — потребность закрыта. */
export type ProjectStatus = 'active' | 'complete';

/** Карточка проекта в том виде, в каком её видит Helper. */
export interface SiteProjectCard {
  /** Стабильный ключ площадки: `address:marketId` либо `rc:<buildId>`. */
  key: string;
  /** Id проекта в Raven Colonial (если он его знает). */
  buildId: string | null;
  systemName: string;
  systemAddress: number | null;
  marketId: number | null;
  buildName: string;
  buildType: string | null;
  bodyName: string | null;
  bodyNum: number | null;
  starPos: [number, number, number] | null;
  architectName: string | null;
  commander: string | null;
  status: ProjectStatus;
  /** Остаток потребности по товарам: `{steel: 900}`. */
  commodities: Record<string, number>;
  /** Исходный объём: число тонн либо остаток по товарам на старте. */
  maxNeed: number | Record<string, number> | null;
  /** Точные ресурсы депота: `{Name, RequiredAmount, ProvidedAmount}[]`. */
  resources: CompactResourceRow[];
  progress: number | null;
  primary: boolean;
  /** Из каких источников собрана карточка (сайт → депот → кэш Raven). */
  sources: ProjectSourceKind[];
  /** Время самого свежего источника. */
  updatedAt: string | null;
  /** Данные старше `STALE_HOURS`: показать можно, но с оговоркой. */
  stale: boolean;
  /** Состояние синхронизации с Raven по последней попытке Helper. */
  rcState: string;
}

export interface CompactResourceRow {
  Name: string;
  RequiredAmount: number;
  ProvidedAmount: number;
}

/** Запись `colonisation_sites`, нужная для карточки. */
export interface JournalSiteRow {
  market_id: number | string | null;
  system_name: string | null;
  construction_name: string | null;
  construction_progress: number | string | null;
  resources_total: unknown;
  event_timestamp: string | null;
}

/** Запись `construction_projects`. */
export interface StoredProjectRow {
  project_key: string;
  system_name: string | null;
  system_address: number | string | null;
  market_id: number | string | null;
  build_id: string | null;
  build_name: string | null;
  build_type: string | null;
  body_name: string | null;
  body_num: number | string | null;
  star_pos: unknown;
  architect_name: string | null;
  commander: string | null;
  status: string | null;
  commodities: unknown;
  max_need: unknown;
  resources: unknown;
  progress: number | string | null;
  is_primary_port: boolean | null;
  source: string | null;
  rc_state: string | null;
  updated_at: string | null;
}

/** Проект из кэша Raven (`system_progress.data.projects`). */
export interface RavenProjectRow {
  buildId?: unknown;
  marketId?: unknown;
  buildName?: unknown;
  buildType?: unknown;
  bodyName?: unknown;
  bodyNum?: unknown;
  architectName?: unknown;
  complete?: unknown;
  progress?: unknown;
  resources?: unknown;
  [key: string]: unknown;
}

/** Свежесть данных: после шести часов молчаливых источников пишем «устарело». */
export const STALE_HOURS = 6;

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Процент готовности. Журнал и третий API пишут и долю (0.4), и проценты (40):
 * значение не больше единицы считается долей — так же его читает
 * `colonisationEvents.toPercent`, иначе стройка «на 40%» показывала бы 0.4%.
 */
function clampProgress(value: unknown): number | null {
  const number = finite(value);
  if (number == null) return null;
  const percent = number <= 1 ? number * 100 : number;
  return Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100;
}

function timestamp(value: unknown): number {
  const raw = text(value);
  if (!raw) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isoOrNull(value: unknown): string | null {
  const ms = timestamp(value);
  return Number.isFinite(ms) && ms !== Number.NEGATIVE_INFINITY
    ? new Date(ms).toISOString()
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Числовая карта товаров: `{steel: 900}`; мусор отбрасывается. */
export function commodityMap(value: unknown): Record<string, number> {
  const source = record(value);
  if (!source) return {};
  const out: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey.trim().toLowerCase();
    const amount = finite(rawValue);
    if (!key || amount == null || amount <= 0) continue;
    out[key] = Math.round(amount);
  }
  return out;
}

/**
 * Компактные ресурсы депота → `{Name, RequiredAmount, ProvidedAmount}`.
 * Принимает и PascalCase журнала, и camelCase парсера сайта.
 */
export function compactProjectResources(value: unknown): CompactResourceRow[] {
  if (!Array.isArray(value)) return [];
  const out: CompactResourceRow[] = [];
  for (const item of value) {
    const row = record(item);
    if (!row) continue;
    const name = text(row.Name ?? row.name).toLowerCase();
    const required = finite(row.RequiredAmount ?? row.requiredAmount);
    const provided = finite(row.ProvidedAmount ?? row.providedAmount);
    if (!name || required == null || provided == null) continue;
    out.push({
      Name: name,
      RequiredAmount: Math.max(0, Math.round(required)),
      ProvidedAmount: Math.max(0, Math.round(provided)),
    });
  }
  return out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
}

/**
 * Остаток потребности из точных ресурсов депота.
 *
 * Именно это число нужно оверлею: `RequiredAmount - ProvidedAmount` по
 * каждому товару. Оно не требует ни Raven, ни чужих снимков — достаточно
 * одного `ColonisationConstructionDepot`, который Helper уже присылает.
 */
export function remainingFromResources(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of compactProjectResources(value)) {
    const left = row.RequiredAmount - row.ProvidedAmount;
    if (left > 0) out[row.Name] = (out[row.Name] ?? 0) + left;
  }
  return out;
}

/** Ключ площадки: `address:marketId`, иначе `rc:<buildId>`, иначе `sys:<имя>`. */
export function projectKey(input: {
  systemAddress?: unknown;
  marketId?: unknown;
  buildId?: unknown;
  systemName?: unknown;
  buildName?: unknown;
}): string {
  const address = finite(input.systemAddress);
  const market = finite(input.marketId);
  if (address && market) return `${Math.trunc(address)}:${Math.trunc(market)}`;
  const buildId = text(input.buildId);
  if (buildId) return `rc:${buildId}`;
  if (market) return `m:${Math.trunc(market)}`;
  const system = text(input.systemName).toLowerCase();
  const name = text(input.buildName).toLowerCase();
  if (system && name) return `sys:${system}:${name}`;
  return '';
}

/** Поля регистрации, которые принимает `POST /api/projects/register`. */
export interface ProjectRegistrationInput {
  systemName?: unknown;
  systemAddress?: unknown;
  marketId?: unknown;
  buildId?: unknown;
  buildName?: unknown;
  buildType?: unknown;
  bodyName?: unknown;
  bodyNum?: unknown;
  starPos?: unknown;
  architectName?: unknown;
  commander?: unknown;
  commodities?: unknown;
  maxNeed?: unknown;
  progress?: unknown;
  isPrimaryPort?: unknown;
  status?: unknown;
  /** То же событие журнала, что Helper отправляет в Raven. */
  colonisationConstructionDepot?: unknown;
  rcState?: unknown;
  updatedAt?: unknown;
}

export interface NormalizedRegistration {
  project_key: string;
  system_name: string;
  system_address: number | null;
  market_id: number | null;
  build_id: string | null;
  build_name: string;
  build_type: string;
  body_name: string | null;
  body_num: number | null;
  star_pos: [number, number, number] | null;
  architect_name: string | null;
  commander: string | null;
  status: ProjectStatus;
  commodities: Record<string, number>;
  max_need: number | Record<string, number> | null;
  resources: CompactResourceRow[];
  progress: number | null;
  is_primary_port: boolean;
  rc_state: string;
  updated_at: string;
}

const MAX_TEXT = 200;

/**
 * Проверить и привести тело регистрации к строке таблицы.
 *
 * Обязателен только ключ площадки: система + MarketID (или buildId). Имя
 * постройки может прийти позже — Helper иногда знает площадку раньше, чем
 * название. Всё остальное необязательно, но мусор из тела не проходит.
 */
export function normalizeProjectRegistration(
  input: ProjectRegistrationInput,
): { ok: true; value: NormalizedRegistration } | { ok: false; error: string } {
  const systemName = text(input.systemName).slice(0, 128);
  const systemAddress = finite(input.systemAddress);
  const marketId = finite(input.marketId);
  const buildId = text(input.buildId).slice(0, 120) || null;
  const buildName = text(input.buildName).slice(0, MAX_TEXT);

  const key = projectKey({
    systemAddress,
    marketId,
    buildId,
    systemName,
    buildName,
  });
  if (!key) {
    return { ok: false, error: 'project key required (systemAddress+marketId or buildId)' };
  }

  const starRaw = Array.isArray(input.starPos) ? input.starPos : null;
  const starPos: [number, number, number] | null = starRaw && starRaw.length === 3
    ? (() => {
      const point = starRaw.map((item) => finite(item));
      return point.every((item): item is number => item != null)
        ? [point[0]!, point[1]!, point[2]!]
        : null;
    })()
    : null;

  const depot = record(input.colonisationConstructionDepot);
  const resources = compactProjectResources(
    depot?.Resources ?? depot?.resources ?? input.colonisationConstructionDepot,
  );
  // Остаток берём из точных ресурсов, если они есть: это единственный
  // источник, который не зависит от Raven. Присланный `commodities` — запасной.
  const fromDepot = remainingFromResources(resources);
  const commodities = Object.keys(fromDepot).length > 0
    ? fromDepot
    : commodityMap(input.commodities);

  const explicitProgress = clampProgress(input.progress ?? depot?.ConstructionProgress);
  const progress = explicitProgress ?? (resources.length > 0
    ? progressFromResources(resources)
    : null);

  const maxNeedRaw = input.maxNeed;
  let maxNeed: number | Record<string, number> | null = null;
  if (typeof maxNeedRaw === 'number' || typeof maxNeedRaw === 'string') {
    const number = finite(maxNeedRaw);
    if (number != null && number >= 0) maxNeed = Math.round(number);
  } else {
    const map = commodityMap(maxNeedRaw);
    if (Object.keys(map).length > 0) maxNeed = map;
  }

  const statusRaw = text(input.status).toLowerCase();
  const status: ProjectStatus = statusRaw === 'complete'
    || (progress != null && progress >= 100)
    ? 'complete'
    : 'active';

  const rcRaw = text(input.rcState).toLowerCase();
  const rcState = ['ok', 'unavailable', 'no_key', 'skipped'].includes(rcRaw) ? rcRaw : 'unknown';

  return {
    ok: true,
    value: {
      project_key: key,
      system_name: systemName,
      system_address: systemAddress == null ? null : Math.trunc(systemAddress),
      market_id: marketId == null ? null : Math.trunc(marketId),
      build_id: buildId,
      build_name: buildName,
      build_type: text(input.buildType).slice(0, 80),
      body_name: text(input.bodyName).slice(0, 128) || null,
      body_num: (() => {
        const number = finite(input.bodyNum);
        return number == null ? null : Math.trunc(number);
      })(),
      star_pos: starPos,
      architect_name: text(input.architectName).slice(0, 128) || null,
      commander: text(input.commander).slice(0, 128) || null,
      status,
      commodities,
      max_need: maxNeed,
      resources,
      progress,
      is_primary_port: input.isPrimaryPort === true,
      rc_state: rcState,
      updated_at: isoOrNull(input.updatedAt) ?? new Date().toISOString(),
    },
  };
}

/** Процент готовности по точным ресурсам: сдано / требуется. */
export function progressFromResources(value: unknown): number | null {
  const rows = compactProjectResources(value);
  const required = rows.reduce((sum, row) => sum + row.RequiredAmount, 0);
  if (required <= 0) return null;
  const provided = rows.reduce((sum, row) => sum + Math.min(row.ProvidedAmount, row.RequiredAmount), 0);
  return Math.round(Math.min(100, Math.max(0, (provided / required) * 100)) * 100) / 100;
}

function emptyCard(partial: Partial<SiteProjectCard> & { key: string }): SiteProjectCard {
  return {
    key: partial.key,
    buildId: partial.buildId ?? null,
    systemName: partial.systemName ?? '',
    systemAddress: partial.systemAddress ?? null,
    marketId: partial.marketId ?? null,
    buildName: partial.buildName ?? '',
    buildType: partial.buildType ?? null,
    bodyName: partial.bodyName ?? null,
    bodyNum: partial.bodyNum ?? null,
    starPos: partial.starPos ?? null,
    architectName: partial.architectName ?? null,
    commander: partial.commander ?? null,
    status: partial.status ?? 'active',
    commodities: partial.commodities ?? {},
    maxNeed: partial.maxNeed ?? null,
    resources: partial.resources ?? [],
    progress: partial.progress ?? null,
    primary: partial.primary ?? false,
    sources: partial.sources ?? ['site'],
    updatedAt: partial.updatedAt ?? null,
    stale: partial.stale ?? false,
    rcState: partial.rcState ?? 'unknown',
  };
}

/** Карточки из таблицы `construction_projects`. */
export function cardsFromStored(rows: StoredProjectRow[] | null | undefined): SiteProjectCard[] {
  const out: SiteProjectCard[] = [];
  for (const row of rows ?? []) {
    const key = text(row.project_key);
    if (!key) continue;
    const resources = compactProjectResources(row.resources);
    const fromResources = remainingFromResources(resources);
    const commodities = Object.keys(fromResources).length > 0
      ? fromResources
      : commodityMap(row.commodities);
    const maxNeedRaw = row.max_need;
    const maxNeed = typeof maxNeedRaw === 'number' || typeof maxNeedRaw === 'string'
      ? finite(maxNeedRaw)
      : (() => {
        const map = commodityMap(maxNeedRaw);
        return Object.keys(map).length > 0 ? map : null;
      })();
    const progress = clampProgress(row.progress)
      ?? (resources.length > 0 ? progressFromResources(resources) : null);
    const status: ProjectStatus = text(row.status) === 'complete' || (progress != null && progress >= 100)
      ? 'complete'
      : 'active';
    out.push(emptyCard({
      key,
      buildId: text(row.build_id) || null,
      systemName: text(row.system_name),
      systemAddress: finite(row.system_address),
      marketId: finite(row.market_id),
      buildName: text(row.build_name),
      buildType: text(row.build_type) || null,
      bodyName: text(row.body_name) || null,
      bodyNum: finite(row.body_num),
      starPos: Array.isArray(row.star_pos) && row.star_pos.length === 3
        ? [Number(row.star_pos[0]), Number(row.star_pos[1]), Number(row.star_pos[2])] as [number, number, number]
        : null,
      architectName: text(row.architect_name) || null,
      commander: text(row.commander) || null,
      status,
      commodities,
      maxNeed: maxNeed ?? null,
      resources,
      progress,
      primary: row.is_primary_port === true,
      sources: ['site'],
      updatedAt: isoOrNull(row.updated_at),
      rcState: text(row.rc_state) || 'unknown',
    }));
  }
  return out;
}

/** Карточки из кэша Raven: `system_progress.data.projects`. */
export function cardsFromRavenCache(
  rows: { system_name: string | null; data: unknown; updated_at?: string | null }[] | null | undefined,
): SiteProjectCard[] {
  const out: SiteProjectCard[] = [];
  for (const row of rows ?? []) {
    const data = record(row.data);
    const projects = Array.isArray(data?.projects) ? (data?.projects as RavenProjectRow[]) : [];
    const architect = text(data?.architectName) || null;
    projects.forEach((raw, position) => {
      const buildId = text(raw.buildId);
      const marketId = finite(raw.marketId);
      const key = projectKey({
        systemAddress: null,
        marketId,
        buildId,
        systemName: row.system_name,
        buildName: raw.buildName,
      });
      if (!key) return;
      const resources = compactProjectResources(raw.resources);
      const fromResources = remainingFromResources(resources);
      const progress = clampProgress(raw.progress);
      out.push(emptyCard({
        key,
        buildId: buildId || null,
        systemName: text(row.system_name),
        marketId,
        buildName: text(raw.buildName) || `#${position + 1}`,
        buildType: text(raw.buildType) || null,
        bodyName: text(raw.bodyName) || null,
        bodyNum: finite(raw.bodyNum),
        architectName: architect,
        status: raw.complete === true || (progress != null && progress >= 100) ? 'complete' : 'active',
        // Raven отдаёт остаток только как сумму и витрину ресурсов; точные
        // Required/Provided берём из депота, если они там есть.
        commodities: fromResources,
        resources,
        progress,
        sources: ['raven'],
        updatedAt: isoOrNull(row.updated_at),
        rcState: 'ok',
      }));
    });
  }
  return out;
}

/** Карточки из снимков депота `colonisation_sites`. */
export function cardsFromJournalSites(
  rows: JournalSiteRow[] | null | undefined,
  fallbackSystem = '',
): SiteProjectCard[] {
  const out: SiteProjectCard[] = [];
  for (const row of rows ?? []) {
    const marketId = finite(row.market_id);
    const systemName = text(row.system_name) || fallbackSystem;
    const key = projectKey({ marketId, systemName });
    if (!key) continue;
    const resources = compactProjectResources(row.resources_total);
    const commodities = remainingFromResources(resources);
    const progress = clampProgress(row.construction_progress)
      ?? (resources.length > 0 ? progressFromResources(resources) : null);
    out.push(emptyCard({
      key,
      systemName,
      marketId,
      buildName: text(row.construction_name),
      status: progress != null && progress >= 100 ? 'complete' : 'active',
      commodities,
      resources,
      progress,
      sources: ['journal'],
      updatedAt: isoOrNull(row.event_timestamp),
      rcState: 'unknown',
    }));
  }
  return out;
}

const SOURCE_PRIORITY: Record<ProjectSourceKind, number> = { site: 0, journal: 1, raven: 2 };

/**
 * Слить карточки из разных источников в одну на площадку.
 *
 * Идентичность — `marketId`, затем `buildId`, затем ключ: одна и та же
 * площадка приходит из трёх источников с разными ключами (в журнале нет
 * buildId, в кэше Raven нет системы). Числовые значения берём из самой
 * свежей карточки, где они есть; при равном времени — из источника с более
 * точными данными (депот -> кэш Raven -> регистрация).
 */
export function mergeProjectCards(cards: SiteProjectCard[]): SiteProjectCard[] {
  const buckets: SiteProjectCard[] = [];
  const byMarket = new Map<number, SiteProjectCard>();
  const byBuild = new Map<string, SiteProjectCard>();
  const byKey = new Map<string, SiteProjectCard>();

  const remember = (item: SiteProjectCard) => {
    if (item.marketId != null) byMarket.set(item.marketId, item);
    if (item.buildId) byBuild.set(item.buildId, item);
    byKey.set(item.key, item);
  };

  for (const card of cards) {
    const found = (card.marketId != null ? byMarket.get(card.marketId) : undefined)
      ?? (card.buildId ? byBuild.get(card.buildId) : undefined)
      ?? byKey.get(card.key);
    if (found) {
      mergeInto(found, card);
      remember(found);
      continue;
    }
    const created = { ...card, sources: [...card.sources] };
    buckets.push(created);
    remember(created);
  }

  return buckets.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    const byTime = timestamp(b.updatedAt) - timestamp(a.updatedAt);
    if (byTime !== 0) return byTime;
    return a.buildName.localeCompare(b.buildName);
  });
}

function mergeInto(target: SiteProjectCard, incoming: SiteProjectCard): void {
  const sources = new Set<ProjectSourceKind>([...target.sources, ...incoming.sources]);
  target.sources = Array.from(sources).sort((a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b]);

  // Пустые поля дополняем, но никогда не затираем уже известное пустым.
  target.buildId = target.buildId ?? incoming.buildId;
  target.systemAddress = target.systemAddress ?? incoming.systemAddress;
  target.marketId = target.marketId ?? incoming.marketId;
  target.systemName = target.systemName || incoming.systemName;
  target.buildName = target.buildName || incoming.buildName;
  target.buildType = target.buildType ?? incoming.buildType;
  target.bodyName = target.bodyName ?? incoming.bodyName;
  target.bodyNum = target.bodyNum ?? incoming.bodyNum;
  target.starPos = target.starPos ?? incoming.starPos;
  target.architectName = target.architectName ?? incoming.architectName;
  target.commander = target.commander ?? incoming.commander;

  const incomingHasNumbers = Object.keys(incoming.commodities).length > 0
    || incoming.progress != null;
  const targetHasNumbers = Object.keys(target.commodities).length > 0
    || target.progress != null;
  const incomingIsNewer = timestamp(incoming.updatedAt) > timestamp(target.updatedAt);
  const sameMoment = timestamp(incoming.updatedAt) === timestamp(target.updatedAt);
  const incomingIsBetter = sameMoment
    && SOURCE_PRIORITY[incoming.sources[0] ?? 'site'] < SOURCE_PRIORITY[target.sources[0] ?? 'site'];

  if (incomingHasNumbers && (!targetHasNumbers || incomingIsNewer || incomingIsBetter)) {
    if (Object.keys(incoming.commodities).length > 0) target.commodities = { ...incoming.commodities };
    if (incoming.resources.length > 0) target.resources = [...incoming.resources];
    target.progress = incoming.progress ?? target.progress;
  }
  if (incoming.maxNeed != null && target.maxNeed == null) target.maxNeed = incoming.maxNeed;
  if (incoming.progress != null && incoming.progress >= 100) target.status = 'complete';
  if (incoming.status === 'active' && target.status !== 'complete') target.status = 'active';
  if (incoming.primary) target.primary = true;
  if (incoming.rcState === 'ok' || target.rcState === 'unknown') target.rcState = incoming.rcState;
  if (timestamp(incoming.updatedAt) > timestamp(target.updatedAt)) target.updatedAt = incoming.updatedAt;
  target.stale = target.stale || incoming.stale;
}

/** Пометить карточки, которые давно не обновлялись. */
export function markStale(cards: SiteProjectCard[], now = Date.now()): SiteProjectCard[] {
  const limit = STALE_HOURS * 60 * 60 * 1000;
  return cards.map((card) => {
    const at = timestamp(card.updatedAt);
    const stale = !Number.isFinite(at) || now - at > limit;
    return stale === card.stale ? card : { ...card, stale };
  });
}

/** Остаток потребности по карточке — то, что показывает оверлей. */
export function projectNeed(card: SiteProjectCard): Record<string, number> {
  return Object.fromEntries(
    Object.entries(card.commodities).filter(([, amount]) => amount > 0),
  );
}

/** Суммарная потребность карточки в тоннах. */
export function projectNeedTotal(card: SiteProjectCard): number {
  return Object.values(projectNeed(card)).reduce((sum, amount) => sum + amount, 0);
}

/** Собрать карточки системы из всех трёх источников. */
export function buildSystemCards(input: {
  stored?: StoredProjectRow[] | null;
  ravenCache?: { system_name: string | null; data: unknown; updated_at?: string | null }[] | null;
  journalSites?: JournalSiteRow[] | null;
  system?: string;
  now?: number;
}): SiteProjectCard[] {
  const cards = [
    ...cardsFromStored(input.stored),
    ...cardsFromJournalSites(input.journalSites, input.system ?? ''),
    ...cardsFromRavenCache(input.ravenCache),
  ];
  return markStale(mergeProjectCards(cards), input.now ?? Date.now());
}

/** Строка ресурсов в форме страницы системы (`required`/`provided`). */
export interface ProjectResourceRow {
  key: string;
  name: string;
  required: number | null;
  provided: number | null;
  remaining: number;
  exact: boolean;
}

/** `liquidoxygen` → `Liquidoxygen` — страница показывает имя как есть. */
function displayCommodity(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Ресурсы карточки: точные строки депота, а если их нет — остаток из
 * `commodities`. Точные важнее: только у них известно, сколько уже завезено.
 */
export function cardResourceRows(card: SiteProjectCard): ProjectResourceRow[] {
  const rows: ProjectResourceRow[] = card.resources.map((row) => ({
    key: row.Name,
    name: displayCommodity(row.Name),
    required: row.RequiredAmount,
    provided: row.ProvidedAmount,
    remaining: Math.max(0, row.RequiredAmount - row.ProvidedAmount),
    exact: true,
  }));
  const known = new Set(rows.map((row) => row.key));
  for (const [key, amount] of Object.entries(card.commodities)) {
    if (known.has(key) || amount <= 0) continue;
    // `commodities` — только остаток: разбивку «завезено/нужно» он не знает.
    rows.push({ key, name: displayCommodity(key), required: null, provided: null, remaining: amount, exact: false });
  }
  return rows.sort((a, b) => b.remaining - a.remaining);
}

/** Тоннаж карточки: сколько нужно, сколько завезено и сколько осталось. */
export function cardTotals(card: SiteProjectCard): {
  totalRequired: number | null;
  totalProvided: number | null;
  totalRemaining: number;
} {
  const rows = cardResourceRows(card);
  const exactRows = rows.length > 0 && rows.every((row) => row.exact);
  const fromRows = exactRows
    ? rows.reduce((sum, row) => sum + (row.required ?? 0), 0)
    : null;
  const maxNeed = typeof card.maxNeed === 'number'
    ? Math.round(card.maxNeed)
    : card.maxNeed && typeof card.maxNeed === 'object'
      ? Object.values(card.maxNeed).reduce((sum, value) => sum + value, 0)
      : null;
  const complete = card.status === 'complete';
  const totalRemaining = complete ? 0 : rows.reduce((sum, row) => sum + row.remaining, 0);
  // Точные строки депота — это и есть объём проекта. `maxNeed` берём, только
  // когда депота не было: иначе старое значение спорило бы с самим депотом.
  let totalRequired = fromRows ?? maxNeed;
  if (totalRequired != null) totalRequired = Math.max(totalRequired, totalRemaining);
  let totalProvided = totalRequired == null ? null : Math.max(0, totalRequired - totalRemaining);
  if (complete && totalRequired != null) totalProvided = totalRequired;
  return { totalRequired, totalProvided, totalRemaining };
}

/** Карточка сайта в форме проекта Raven — её ждёт страница системы. */
export function ravenProjectFromCard(card: SiteProjectCard): {
  buildId: string;
  marketId: string | null;
  buildName: string;
  buildType: string | null;
  complete: boolean;
  progress: number;
  bodyName: string | null;
  resources: ProjectResourceRow[];
  totalRequired: number | null;
  totalProvided: number | null;
  totalRemaining: number;
} {
  const totals = cardTotals(card);
  const fromResources = totals.totalRequired && totals.totalRequired > 0
    ? (totals.totalProvided ?? 0) / totals.totalRequired * 100
    : null;
  const progress = card.status === 'complete'
    ? 100
    : card.progress ?? (fromResources == null ? 0 : fromResources);
  return {
    buildId: card.buildId ?? card.key,
    marketId: card.marketId == null ? null : String(card.marketId),
    buildName: card.buildName || card.systemName,
    buildType: card.buildType,
    complete: card.status === 'complete',
    progress: Math.round(Math.min(100, Math.max(0, progress)) * 100) / 100,
    bodyName: card.bodyName,
    resources: cardResourceRows(card),
    ...totals,
  };
}

/**
 * Сводка по системе: сумма строк проектов. Точные «нужно/завезено» остаются
 * известными, только если точны все строки — иначе честнее `null`.
 */
export function mergeResourceRows(rows: ProjectResourceRow[]): ProjectResourceRow[] {
  const merged = new Map<string, ProjectResourceRow>();
  for (const row of rows) {
    const found = merged.get(row.key);
    if (!found) {
      merged.set(row.key, { ...row });
      continue;
    }
    found.remaining += row.remaining;
    found.exact = found.exact && row.exact;
    found.required = found.exact && found.required != null && row.required != null
      ? found.required + row.required
      : null;
    found.provided = found.exact && found.provided != null && row.provided != null
      ? found.provided + row.provided
      : null;
  }
  return Array.from(merged.values()).sort((a, b) => b.remaining - a.remaining);
}
