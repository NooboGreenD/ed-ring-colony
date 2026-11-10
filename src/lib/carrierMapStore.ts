/**
 * Данные слоя «Авианосцы» карты галактики: чтение `fleet_carriers` через
 * service_role и поиск координат систем, где стоят носители.
 *
 * Права и приватность решает `carrierMapView.ts`; здесь — только загрузка.
 *
 * Координаты системы берутся по порядку:
 *   1. x/y/z из самой строки носителя (журнал с StarPos) — и для соседей по
 *      системе тоже;
 *   2. локальные каталоги: `galaxy_systems` (Spansh), `commerce_systems`,
 *      `colonisation_market_systems`, системы маршрута и хабы;
 *   3. EDSM — пачками по 25, не больше 50 систем за запрос.
 * Найденное держится в памяти процесса (координаты систем не меняются);
 * систему, которую не нашёл и EDSM, не спрашиваем повторно 15 минут — карта
 * опрашивает слой раз в минуту у каждого открытого окна.
 */

import { readAllRows } from './readAllRows.ts';
import { viewerContext } from './fleetCarrierStore';
import { REGISTRY_STALE_MS, searchCarrierRegistry } from './carrierRegistryStore';
import {
  CARRIER_HISTORY_MAX_PER_CARRIER,
  CARRIER_HISTORY_WINDOW_MS,
  carrierSystemKey,
  isMapPoint,
  type CarrierJumpHistoryEntry,
  type MapCarrier,
  type MapCarriersResponse,
  type MapDirectoryInfo,
  type MapPoint,
} from './carrierMap.ts';
import {
  CARRIER_QUERY_MIN,
  CARRIER_SEARCH_LIMIT,
  CARRIER_SEARCH_MAX,
  carrierMatchesQuery,
  carrierQueryTokens,
  normalizeCarrierQuery,
  orderCarrierDirectory,
  type CarrierWatch,
  type CarrierWatchScope,
} from './carrierDirectory.ts';
import {
  DIRECTORY_COLUMNS,
  DIRECTORY_COLUMNS_BASE,
  MAP_CARRIER_COLUMNS,
  coordinateNamesNeeded,
  directoryCoordinateNames,
  isMapCarrierRow,
  rowCoordinates,
  shapeDirectoryCarriers,
  shapeMapCarriers,
} from './carrierMapView.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;
type Row = Record<string, any>;

const IN_CHUNK = 100;
const EDSM_BATCH = 25;
const EDSM_MAX_NAMES = 50;
const EDSM_TIMEOUT_MS = 5000;
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 15 * 60 * 1000;
const CACHE_LIMIT = 5000;
/**
 * Сколько записей реестра EDDN кладём на карту. Реестр растёт без ограничений
 * (каждый прыжок любого носителя), а сцена рисует спрайт на каждую отметку:
 * 1500 самых свежих — это уже «весь трафик за последние дни», а не свалка.
 */
export const MAP_DIRECTORY_LIMIT = 1500;
/** Сколько систем реестра за один раз искать в каталогах (EDSM и так не больше 50). */
const DIRECTORY_COORD_NAMES = 200;
/**
 * Сколько строк истории прыжков читать на один запрос карты.
 *
 * Окно — неделя (`CARRIER_HISTORY_WINDOW_MS`), и читается оно одним проходом по
 * индексу `jumped_at DESC`, а не запросом на каждого носителя: их до полутора
 * тысяч, и столько запросов раз в минуту дороже одного прохода. Лимит — только
 * страховка от лавины: если за неделю в реестре больше строк, чем здесь, у
 * самых старых прыжков линии не будет. Полная история — во вкладке «История».
 */
export const MAP_HISTORY_SCAN = 8000;
/** Сколько систем из истории за один раз искать в каталогах. */
const HISTORY_COORD_NAMES = 600;
const HISTORY_COLUMNS = 'carrier_id, from_system, to_system, jumped_at, source';

const coordinateCache = new Map<string, { point: MapPoint | null; at: number }>();

/** Для тестов: забыть найденные координаты. */
export function resetCarrierMapCache(): void {
  coordinateCache.clear();
}

function remember(key: string, point: MapPoint | null, now: number) {
  coordinateCache.delete(key);
  coordinateCache.set(key, { point, at: now });
  while (coordinateCache.size > CACHE_LIMIT) {
    const oldest = coordinateCache.keys().next().value;
    if (oldest === undefined) break;
    coordinateCache.delete(oldest);
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function pointOf(row: Row | null | undefined): MapPoint | null {
  if (!row) return null;
  const point = { x: Number(row.x), y: Number(row.y), z: Number(row.z) };
  return row.x != null && row.y != null && row.z != null && isMapPoint(point) ? point : null;
}

/** Таблица может отсутствовать на старой установке — тогда источник просто пропускается. */
async function safeRows(query: PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
  try {
    const { data, error } = await query;
    return !error && Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function lookupLocal(svc: Svc, names: string[]): Promise<Map<string, MapPoint>> {
  const found = new Map<string, MapPoint>();
  if (!names.length) return found;
  const keys = Array.from(new Set(names.map(carrierSystemKey)));
  const exact = Array.from(new Set(names));
  const byKey = (column: string, table: string, values: string[]) => Promise.all(
    chunks(values, IN_CHUNK).map((chunk) => safeRows(svc.from(table).select(`${column}, x, y, z`).in(column, chunk))),
  ).then((parts) => parts.flat());

  // Порядок источников — порядок доверия: каталог Spansh, станции, остальное.
  const sources = await Promise.all([
    byKey('name_lc', 'galaxy_systems', keys),
    byKey('name_lc', 'commerce_systems', keys),
    byKey('system_name', 'colonisation_market_systems', exact),
    byKey('system_name', 'route_systems', exact),
    byKey('system_name', 'hubs', exact),
  ]);
  for (const rows of sources) {
    for (const row of rows) {
      const key = carrierSystemKey(row.name_lc ?? row.system_name);
      const point = pointOf(row);
      if (key && point && !found.has(key)) found.set(key, point);
    }
  }
  return found;
}

async function lookupEdsm(names: string[], fetchImpl: typeof fetch): Promise<Map<string, MapPoint>> {
  const found = new Map<string, MapPoint>();
  for (const batch of chunks(names, EDSM_BATCH)) {
    const params = new URLSearchParams();
    params.append('showCoordinates', '1');
    for (const name of batch) params.append('systemName[]', name);
    try {
      const response = await fetchImpl(`https://www.edsm.net/api-v1/systems?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(EDSM_TIMEOUT_MS),
        next: { revalidate: 86400 },
      } as RequestInit);
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of Array.isArray(data) ? data : []) {
        const point = pointOf(item?.coords);
        if (item?.name && point) found.set(carrierSystemKey(item.name), point);
      }
    } catch (error) {
      console.error('[map/carriers] EDSM:', error instanceof Error ? error.message : error);
    }
  }
  return found;
}

export interface ResolveOptions {
  /** Подмена `fetch` (тесты); `null` — EDSM не спрашивать. */
  fetchImpl?: typeof fetch | null;
  nowMs?: number;
  /**
   * Запоминать ли «систему не нашли». Слою реестра это не нужно: там координаты
   * почти всегда есть в самой строке, а промах чужого носителя не должен
   * на 15 минут лишать координат носителя сайта в той же системе.
   */
  rememberMisses?: boolean;
}

/** Координаты систем по `carrierSystemKey` — то, что удалось найти. */
export async function resolveMapCoordinates(svc: Svc, names: readonly string[], options: ResolveOptions = {}): Promise<Map<string, MapPoint>> {
  const nowMs = options.nowMs ?? Date.now();
  const result = new Map<string, MapPoint>();
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = carrierSystemKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cached = coordinateCache.get(key);
    if (cached && nowMs - cached.at < (cached.point ? HIT_TTL_MS : MISS_TTL_MS)) {
      if (cached.point) result.set(key, cached.point);
      continue;
    }
    pending.push(String(name).trim());
  }
  if (!pending.length) return result;

  const local = await lookupLocal(svc, pending);
  const stillMissing: string[] = [];
  for (const name of pending) {
    const key = carrierSystemKey(name);
    const point = local.get(key);
    if (point) {
      result.set(key, point);
      remember(key, point, nowMs);
    } else {
      stillMissing.push(name);
    }
  }

  const fetchImpl = options.fetchImpl === undefined ? (typeof fetch === 'function' ? fetch : null) : options.fetchImpl;
  if (!stillMissing.length || !fetchImpl) return result;
  const asked = stillMissing.slice(0, EDSM_MAX_NAMES);
  const remote = await lookupEdsm(asked, fetchImpl);
  for (const name of asked) {
    const key = carrierSystemKey(name);
    const point = remote.get(key) ?? null;
    if (point) result.set(key, point);
    if (point || options.rememberMisses !== false) remember(key, point, nowMs);
  }
  return result;
}

async function loadOwners(svc: Svc, ownerIds: string[]) {
  const owners = new Map<string, { cmdrName: string | null; privacy: unknown }>();
  const rows = (await Promise.all(chunks(ownerIds, IN_CHUNK).map((chunk) => safeRows(
    svc.from('profiles').select('id, cmdr_name, privacy_settings').in('id', chunk),
  )))).flat();
  for (const row of rows) {
    if (row?.id) owners.set(String(row.id), { cmdrName: row.cmdr_name ?? null, privacy: row.privacy_settings });
  }
  return owners;
}

async function loadSquadrons(svc: Svc, squadronIds: number[]) {
  const squadrons = new Map<number, { name: string | null; tag: string | null }>();
  const rows = (await Promise.all(chunks(squadronIds, IN_CHUNK).map((chunk) => safeRows(
    svc.from('squadrons').select('id, name, tag').in('id', chunk),
  )))).flat();
  for (const row of rows) {
    const id = Number(row?.id);
    if (Number.isFinite(id)) squadrons.set(id, { name: row.name ?? null, tag: row.tag ?? null });
  }
  return squadrons;
}

async function loadSquadronMates(svc: Svc, squadronIds: number[], viewerId: string | null) {
  const mates = new Set<string>();
  if (!squadronIds.length) return mates;
  const rows = await safeRows(svc.from('squadron_members').select('user_id').in('squadron_id', squadronIds));
  for (const row of rows) {
    const id = row?.user_id ? String(row.user_id) : '';
    if (id && id !== viewerId) mates.add(id);
  }
  return mates;
}

export interface LoadMapCarriersOptions extends ResolveOptions {
  now?: Date;
  /**
   * Подмешать реестр EDDN (`carrier_directory`). По умолчанию да: карта
   * показывает все известные носители, а не только подтверждённые сайтом.
   */
  includeDirectory?: boolean;
  /** Сколько записей реестра брать (для тестов и узких экранов). */
  directoryLimit?: number;
}

/* ── История прыжков носителей (след на карте и список в карточке) ───────── */

/**
 * Строки истории прыжков одним проходом по времени.
 *
 * Таблицы может не быть — миграция `20261113120000` не применена; тогда след
 * просто не рисуется, а карта работает как раньше. Ошибку не глотаем молча:
 * слой карты не должен падать из-за необязательного украшения.
 */
export async function loadJumpHistoryRows(
  svc: Svc,
  options: { since?: string; limit?: number } = {},
): Promise<Row[]> {
  try {
    let query = svc.from('carrier_jump_history').select(HISTORY_COLUMNS);
    if (options.since) query = query.gte('jumped_at', options.since);
    const { data, error } = await query
      .order('jumped_at', { ascending: false })
      .limit(Math.max(1, Math.floor(options.limit ?? MAP_HISTORY_SCAN)));
    return !error && Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * История по носителям карты: прыжки за неделю, свежие сверху, с координатами.
 *
 * Окно — `CARRIER_HISTORY_WINDOW_MS`, одинаковое для всех носителей: «пять
 * прыжков» означало бы у активного носителя день, у редкого — месяц. Внутри
 * окна строки не обрезаются (страховка — `CARRIER_HISTORY_MAX_PER_CARRIER`).
 *
 * Читаем окно одним проходом по индексу времени, а не запросом на каждого
 * носителя: на карте их до полутора тысяч, и столько запросов раз в минуту
 * дороже одного прохода. Координаты ищем только в локальных каталогах
 * (`fetchImpl: null`): исторических систем тысячи, EDSM на каждый опрос карты
 * звать нельзя. Систему без координат карточка всё равно покажет текстом —
 * линия просто не нарисуется.
 */
export async function loadCarrierHistory(
  svc: Svc,
  ids: ReadonlySet<string>,
  options: { nowMs?: number; known?: ReadonlyMap<string, MapPoint>; limit?: number } = {},
): Promise<Map<string, CarrierJumpHistoryEntry[]>> {
  const result = new Map<string, CarrierJumpHistoryEntry[]>();
  if (!ids.size) return result;

  const since = new Date((options.nowMs ?? Date.now()) - CARRIER_HISTORY_WINDOW_MS).toISOString();
  const rows = await loadJumpHistoryRows(svc, { since, limit: options.limit ?? MAP_HISTORY_SCAN });
  const byCarrier = new Map<string, Row[]>();
  for (const row of rows) {
    const id = row?.carrier_id == null ? '' : String(row.carrier_id);
    if (!id || !ids.has(id)) continue;
    const from = typeof row.from_system === 'string' ? row.from_system.trim() : '';
    const to = typeof row.to_system === 'string' ? row.to_system.trim() : '';
    if (!from || !to || carrierSystemKey(from) === carrierSystemKey(to)) continue;
    const list = byCarrier.get(id);
    if (!list) byCarrier.set(id, [row]);
    else if (list.length < CARRIER_HISTORY_MAX_PER_CARRIER) list.push(row);
  }
  if (!byCarrier.size) return result;

  const known = options.known ?? new Map<string, MapPoint>();
  const names = new Map<string, string>();
  for (const list of byCarrier.values()) {
    for (const row of list) {
      for (const value of [row.from_system, row.to_system]) {
        const key = carrierSystemKey(value);
        if (key && !known.has(key) && !names.has(key)) names.set(key, String(value).trim());
      }
    }
  }
  const resolved = names.size
    ? await resolveMapCoordinates(svc, Array.from(names.values()).slice(0, HISTORY_COORD_NAMES), {
      fetchImpl: null,
      nowMs: options.nowMs,
      rememberMisses: false,
    })
    : new Map<string, MapPoint>();
  const pointOfName = (name: string): MapPoint | null => {
    const key = carrierSystemKey(name);
    return (key && (known.get(key) ?? resolved.get(key))) || null;
  };

  for (const [id, list] of byCarrier) {
    result.set(id, list.map((row) => {
      const from = String(row.from_system).trim();
      const to = String(row.to_system).trim();
      const at = row.jumped_at == null ? NaN : Date.parse(String(row.jumped_at));
      return {
        from,
        to,
        jumpedAt: Number.isFinite(at) ? new Date(at).toISOString() : '',
        source: row.source === 'eddn' ? 'eddn' as const : 'site' as const,
        fromPosition: pointOfName(from),
        toPosition: pointOfName(to),
      };
    }));
  }
  return result;
}

/**
 * Строки реестра → отметки `MapCarrier` с теми же правилами приватности.
 * Общая часть слоя карты и поиска «Трафик авианосцев»: имена владельцев,
 * эскадрильи и координаты систем считаются один раз и одинаково.
 */
async function shapeCarrierRows(
  svc: Svc,
  rows: Row[],
  viewerId: string | null,
  now: Date,
  options: ResolveOptions = {},
  history: ReadonlyMap<string, readonly CarrierJumpHistoryEntry[]> = new Map(),
) {
  if (!rows.length) return [];
  const ownerIds = Array.from(new Set(rows.map((row) => row.owner_id).filter(Boolean).map(String)));
  const squadronIds = Array.from(new Set(rows
    .map((row) => (row.squadron_id == null ? NaN : Number(row.squadron_id)))
    .filter(Number.isFinite)));

  const [viewer, owners, squadrons] = await Promise.all([
    viewerContext(svc, viewerId),
    loadOwners(svc, ownerIds),
    loadSquadrons(svc, squadronIds),
  ]);
  const squadronMateIds = await loadSquadronMates(svc, viewer.squadronIds, viewerId);

  const known = rowCoordinates(rows, now);
  const resolved = await resolveMapCoordinates(svc, coordinateNamesNeeded(rows, now, known), {
    fetchImpl: options.fetchImpl,
    nowMs: now.getTime(),
  });
  // Координаты из журнала точнее каталогов — они перекрывают найденное.
  const coordinates = new Map<string, MapPoint>([...resolved, ...known]);

  return shapeMapCarriers(rows, {
    viewerId,
    viewerSquadronIds: viewer.squadronIds,
    squadronMateIds,
    owners,
    squadrons,
    coordinates,
    history,
    now,
  });
}

/**
 * Строки реестра EDDN для карты: самые свежие, в пределах срока давности.
 * Таблицы может не быть (старая установка), а колонок `previous_*` — до
 * миграции `20261110090000`: оба случая дают пустой список, а не ошибку слоя.
 */
export async function loadDirectoryRows(svc: Svc, limit: number, since: string): Promise<Row[]> {
  const query = (columns: string) => svc.from('carrier_directory')
    .select(columns)
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    // +1 строка — чтобы честно понять, обрезали ли мы реестр.
    .limit(limit + 1);
  const full = await query(DIRECTORY_COLUMNS);
  if (!full.error) return Array.isArray(full.data) ? full.data : [];
  const base = await query(DIRECTORY_COLUMNS_BASE);
  if (base.error || !Array.isArray(base.data)) return [];
  return base.data;
}

export async function loadMapCarriers(svc: Svc, viewerId: string | null, options: LoadMapCarriersOptions = {}): Promise<MapCarriersResponse> {
  const now = options.now ?? new Date();
  const includeDirectory = options.includeDirectory !== false;
  const directoryLimit = Math.max(1, Math.floor(options.directoryLimit ?? MAP_DIRECTORY_LIMIT));
  const since = new Date(now.getTime() - REGISTRY_STALE_MS).toISOString();

  const [read, directoryRows] = await Promise.all([
    readAllRows<Row>((from, to) => svc
      .from('fleet_carriers')
      .select(MAP_CARRIER_COLUMNS)
      .order('carrier_id', { ascending: true })
      .range(from, to)),
    includeDirectory ? loadDirectoryRows(svc, directoryLimit, since) : Promise.resolve([] as Row[]),
  ]);
  if (read.error) throw new Error(read.error.message);

  const rows = read.data.filter((row) => isMapCarrierRow(row, now));
  const directory = includeDirectory ? directoryRows.slice(0, directoryLimit) : [];
  const truncated = directoryRows.length > directoryLimit;
  const response: MapCarriersResponse = { carriers: [], viewer: { signedIn: Boolean(viewerId) }, generatedAt: now.toISOString() };

  const finish = (carriers: MapCarrier[], shown: number) => {
    response.carriers = carriers;
    if (includeDirectory) {
      const info: MapDirectoryInfo = { shown, truncated, since };
      response.directory = info;
    }
    return response;
  };

  if (!rows.length && !directory.length) return finish([], 0);

  // История прыжков одна на весь ответ: до пяти строк на носителя, с координатами.
  const ids = new Set<string>([
    ...rows.map((row) => String(row.carrier_id)),
    ...directory.map((row) => String(row.carrier_id)),
  ]);
  const history = await loadCarrierHistory(svc, ids, {
    nowMs: now.getTime(),
    known: rowCoordinates(rows, now),
  });

  const carriers = rows.length ? await shapeCarrierRows(svc, rows, viewerId, now, options, history) : [];
  let shown = 0;
  if (directory.length) {
    const known = new Set(carriers.map((carrier) => carrier.id));
    const knownPoints = new Map<string, MapPoint>();
    for (const carrier of carriers) {
      if (carrier.position) knownPoints.set(carrierSystemKey(carrier.system), carrier.position);
    }
    const needed = directoryCoordinateNames(directory, knownPoints).slice(0, DIRECTORY_COORD_NAMES);
    let coordinates = knownPoints;
    if (needed.length) {
      const resolved = await resolveMapCoordinates(svc, needed, {
        fetchImpl: null, // EDSM для реестра не дёргаем: это тысячи систем в минуту
        nowMs: now.getTime(),
        rememberMisses: false,
      });
      coordinates = new Map([...knownPoints, ...resolved]);
    }
    const fromRegistry = shapeDirectoryCarriers(directory, {
      coordinates,
      knownIds: known,
      seenAfter: now.getTime() - REGISTRY_STALE_MS,
      history,
    });
    shown = fromRegistry.length;
    carriers.push(...fromRegistry);
  }
  return finish(carriers, shown);
}

/* ── «Авианосцы перед прыжком» (`/carriers/jumps`) ────────────────────────── */

/** Через сколько после заказанного вылета носитель ещё считается «в прыжке». */
export const JUMP_ROW_LOOKBACK_MS = 30 * 60 * 1000;
/** Сколько заказов отдаём: страница табличная, ей хватает. */
export const JUMP_ROWS_LIMIT = 200;

/** Размер ответа и время отсчёта: в тестах и на узких экранах нужен свой. */
export interface LoadCarrierJumpsOptions extends ResolveOptions {
  now?: Date;
  limit?: number;
}

export interface CarrierJumpsResponse {
  carriers: MapCarrier[];
  viewer: { signedIn: boolean };
  generatedAt: string;
  /** Сколько заказов в базе попало в окно (до обрезки по лимиту). */
  total: number;
  truncated: boolean;
}

/**
 * Носители с заказанным прыжком — то, что видит страница `/carriers/jumps`.
 *
 * Источник один: учёт сайта. EDDN заказ не приносит (`CarrierJumpRequest` в
 * поток не ретранслируется), а реестр `carrier_directory` знает только уже
 * случившиеся прыжки — поэтому реестр сюда не подмешивается.
 *
 * Окно: вылет ещё не наступил или наступил не позже получаса назад — так
 * видно и «готовится», и короткий момент «уже в прыжке, подтверждения нет».
 * Строки без времени вылета тоже берём: заказ есть, время неизвестно.
 */
export async function loadCarrierJumps(
  svc: Svc,
  viewerId: string | null,
  options: LoadCarrierJumpsOptions = {},
): Promise<CarrierJumpsResponse> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - JUMP_ROW_LOOKBACK_MS).toISOString();
  const limit = Math.max(1, Math.floor(options.limit ?? JUMP_ROWS_LIMIT));
  const query = (from: number, to: number) => svc
    .from('fleet_carriers')
    .select(MAP_CARRIER_COLUMNS)
    .not('jump_system_name', 'is', null)
    .gte('jump_departure_at', since)
    .order('jump_departure_at', { ascending: true })
    .range(from, to);
  // Заказы без времени вылета: их немного, но «куда» уже известно.
  const withoutTime = () => svc
    .from('fleet_carriers')
    .select(MAP_CARRIER_COLUMNS)
    .not('jump_system_name', 'is', null)
    .is('jump_departure_at', null)
    .limit(100);

  const [timed, untimed] = await Promise.all([
    readAllRows<Row>((from, to) => query(from, to)),
    safeRows(withoutTime()),
  ]);
  if (timed.error) throw new Error(timed.error.message);

  const byId = new Map<string, Row>();
  for (const row of [...timed.data, ...untimed]) {
    if (row?.carrier_id != null) byId.set(String(row.carrier_id), row);
  }
  const rows = Array.from(byId.values()).filter((row) => isMapCarrierRow(row, now));
  const response: CarrierJumpsResponse = {
    carriers: [],
    viewer: { signedIn: Boolean(viewerId) },
    generatedAt: now.toISOString(),
    total: 0,
    truncated: false,
  };
  if (!rows.length) return response;

  const carriers = await shapeCarrierRows(svc, rows, viewerId, now, options);
  // `buildCarrierView` уже решил, есть ли заказ и не прибыл ли носитель.
  const pending = carriers.filter((carrier) => carrier.jump != null);
  pending.sort((left, right) => {
    const leftMs = left.jump?.departureAt ? Date.parse(left.jump.departureAt) : NaN;
    const rightMs = right.jump?.departureAt ? Date.parse(right.jump.departureAt) : NaN;
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
    if (Number.isFinite(leftMs) !== Number.isFinite(rightMs)) return Number.isFinite(leftMs) ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  response.total = pending.length;
  response.truncated = pending.length > limit;
  response.carriers = pending.slice(0, limit);
  return response;
}

/* ── «Трафик авианосцев»: поиск по реестру ────────────────────────────────── */

export interface CarrierSearchRequest {
  /** Строка поиска: позывной (тег), имя, система или MarketID. */
  query?: string;
  scope?: CarrierWatchScope;
  /** Сколько отдать. */
  limit?: number;
  /**
   * Избранное зрителя. Нужно не для поиска, а для порядка: избранные и записи
   * с комментарием идут первыми (см. `orderCarrierDirectory`).
   */
  watches?: readonly CarrierWatch[];
}

export interface CarrierSearchResult {
  carriers: MapCarrier[];
  /** Сколько совпало до обрезки по `limit`. */
  total: number;
  truncated: boolean;
}

/** Защита от PostgREST-шаблонов: `%` и `_` в запросе — литералы, не wildcard. */
function likePattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

/**
 * «Рыхлый» шаблон для позывного: `%k%7%q%b%q%l%`.
 *
 * Позывные в игре пишут с дефисом («K7Q-BQL»), а пилот набирает слитно —
 * «k7qbql». `ilike '%k7qbql%'` такую строку не найдёт, а схема «эти символы
 * идут по порядку» находит и её, и «K7-QBQL». Окончательный отбор всё равно
 * делает `carrierMatchesQuery` в памяти, поэтому лишние строки не страшны.
 */
function looseCallsignPattern(value: string): string {
  return `%${value.split('').map(escapeLike).join('%')}%`;
}

/**
 * Поиск носителей по реестру сайта (`fleet_carriers`).
 *
 * Почему не один запрос с `or`: PostgREST ломается на запятых и скобках внутри
 * `or=`, а в позывных и именах они встречаются. Делаем отдельные `ilike` по
 * самым важным колонкам и сводим строки по `carrier_id`.
 *
 * Ищем по самому длинному слову запроса: короткое слово («1») вернуло бы
 * половину реестра. Остальные слова проверяет `carrierMatchesQuery` уже в
 * памяти — так «K7Q steel» не выдаёт все носители со словом «steel».
 *
 * `scope = 'favorites'` без `carrierIds` — пустой результат: список избранного
 * знает маршрут, он и передаёт идентификаторы.
 */
export async function searchMapCarriers(
  svc: Svc,
  viewerId: string | null,
  request: CarrierSearchRequest = {},
  options: ResolveOptions = {},
): Promise<CarrierSearchResult> {
  const now = options.nowMs ? new Date(options.nowMs) : new Date();
  const limit = Math.max(1, Math.min(CARRIER_SEARCH_MAX, Number(request.limit) || CARRIER_SEARCH_LIMIT));
  const query = normalizeCarrierQuery(request.query ?? '');
  const tokens = carrierQueryTokens(query);
  const primary = [...tokens].sort((left, right) => right.length - left.length)[0] ?? '';
  if (primary && primary.length < CARRIER_QUERY_MIN) return { carriers: [], total: 0, truncated: false };

  const scanned = new Map<string, Row>();
  const absorb = (rows: Row[] | null | undefined) => {
    for (const row of rows ?? []) {
      if (row?.carrier_id == null) continue;
      scanned.set(String(row.carrier_id), row);
    }
  };

  if (request.scope === 'favorites' && !tokens.length) {
    const ids = Array.from(new Set((request.watches ?? []).filter((watch) => watch.favorite).map((watch) => watch.carrierId)));
    if (!ids.length) return { carriers: [], total: 0, truncated: false };
    for (const chunk of chunks(ids, IN_CHUNK)) {
      absorb(await safeRows(svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).in('carrier_id', chunk).limit(limit * 3)));
    }
  } else if (!tokens.length) {
    // Пустой запрос: показываем реестр, а не пустоту — пилоту нужно с чего-то начать.
    absorb(await safeRows(svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS)
      .order('updated_at', { ascending: false }).limit(limit * 3)));
  } else {
    const pattern = likePattern(primary);
    const perQuery = limit * 3;
    const lookups = [
      svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).ilike('callsign', pattern).limit(perQuery),
      svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).ilike('name', pattern).limit(perQuery),
      svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).ilike('system_name', pattern).limit(perQuery),
    ];
    // MarketID ищут числом: позывной из цифр не бывает, а `ilike` по BIGINT
    // Postgre не примет.
    if (/^\d+$/.test(primary)) {
      lookups.push(svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).eq('carrier_id', primary).limit(1));
    }
    for (const rows of await Promise.all(lookups.map((lookup) => safeRows(lookup)))) absorb(rows);

    // Слитный позывной: буквы идут по порядку, дефисы в базе не мешают.
    const compact = primary.replace(/[^a-z0-9]/g, '');
    if (scanned.size === 0 && tokens.length === 1 && compact.length >= 3) {
      absorb(await safeRows(svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS)
        .ilike('callsign', looseCallsignPattern(compact)).limit(perQuery)));
    }
  }

  const rows = Array.from(scanned.values()).filter((row) => isMapCarrierRow(row, now));
  const carriers = await shapeCarrierRows(svc, rows, viewerId, now, options);

  // Реестр EDDN (`carrier_directory`) — вторая половина поиска: там носители,
  // которых сайт сам не учитывал (чужой прыжок видел пилот в живом потоке).
  // Слияние по MarketID: запись сайта главнее, реестр лишь дополняет.
  const registryIds = request.scope === 'favorites' && !tokens.length
    ? Array.from(new Set((request.watches ?? []).filter((watch) => watch.favorite).map((watch) => watch.carrierId)))
    : undefined;
  let directory: Map<string, Awaited<ReturnType<typeof searchCarrierRegistry>>['rows'][number]> = new Map();
  try {
    const found = await searchCarrierRegistry(svc, tokens, limit * 3, {
      ...(registryIds ? { ids: registryIds } : {}),
      nowMs: now.getTime(),
    });
    directory = new Map(found.rows.map((entry) => [entry.id, entry]));
  } catch {
    // Реестр вторичен: если таблицы ещё нет или она недоступна, поиск по
    // учёту сайта продолжает работать.
    directory = new Map();
  }

  const enriched = carriers.map((carrier) => {
    const entry = directory.get(carrier.id);
    if (!entry) return carrier;
    directory.delete(carrier.id);
    const next = { ...carrier };
    if (!next.callsign && entry.callsign) next.callsign = entry.callsign;
    if (!next.name && entry.name) next.name = entry.name;
    if (!next.system && entry.system) next.system = entry.system;
    if (!next.position && entry.position) next.position = entry.position;
    return next;
  });

  // Носители, известные только реестру: владельца и эскадрильи у них нет —
  // врать «свой» или подставлять чужой ник мы не будем.
  const onlyRegistry: MapCarrier[] = Array.from(directory.values()).map((entry) => ({
    id: entry.id,
    type: 'FleetCarrier',
    callsign: entry.callsign,
    name: entry.name,
    relation: 'other',
    owner: null,
    ownerHidden: false,
    squadron: null,
    system: entry.system,
    body: null,
    position: entry.position,
    locationAt: entry.updatedAt || null,
    estimated: false,
    previousSystem: null,
    jump: null,
    docking: null,
    notorious: null,
    services: entry.services,
    decommission: false,
    origin: 'eddn',
  }));

  const matched = [...enriched, ...onlyRegistry].filter((carrier) => carrierMatchesQuery({
    id: carrier.id,
    callsign: carrier.callsign,
    name: carrier.name,
    owner: carrier.owner,
    system: carrier.system,
  }, query));
  const ordered = orderCarrierDirectory(matched, request.watches ?? []);
  return {
    carriers: ordered.slice(0, limit),
    total: ordered.length,
    truncated: ordered.length > limit,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Носители в одной системе — для карточки системы. Права и приватность те же,
 * что у слоя «Авианосцы» карты (`shapeMapCarriers`): чужой личный носитель
 * виден без имени владельца, если тот его скрыл, груза здесь нет вовсе.
 */
export async function loadSystemCarriers(
  svc: Svc,
  viewerId: string | null,
  systemName: string,
  options: { point?: MapPoint | null; now?: Date } = {},
): Promise<MapCarriersResponse['carriers']> {
  const now = options.now ?? new Date();
  const key = carrierSystemKey(systemName);
  if (!key) return [];
  // Носитель «в системе» — как на карте: стоит в ней или уже прилетел по
  // расписанному прыжку (место считает `buildCarrierView`), поэтому берём обе
  // колонки, а отбираем по вычисленной системе ниже.
  const pattern = escapeLike(systemName.trim());
  const [here, arriving] = await Promise.all([
    svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).ilike('system_name', pattern).limit(200),
    svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).ilike('jump_system_name', pattern).limit(200),
  ]);
  if (here.error) throw new Error(here.error.message);
  const byId = new Map<string, Row>();
  for (const row of [...(Array.isArray(here.data) ? here.data : []), ...(arriving.error || !Array.isArray(arriving.data) ? [] : arriving.data)]) {
    if (row?.carrier_id != null) byId.set(String(row.carrier_id), row);
  }
  const rows = Array.from(byId.values()).filter((row) => isMapCarrierRow(row, now));
  if (!rows.length) return [];

  const ownerIds = Array.from(new Set(rows.map((row: Row) => row.owner_id).filter(Boolean).map(String))) as string[];
  const squadronIds = Array.from(new Set(rows
    .map((row: Row) => (row.squadron_id == null ? NaN : Number(row.squadron_id)))
    .filter(Number.isFinite))) as number[];
  const [viewer, owners, squadrons] = await Promise.all([
    viewerContext(svc, viewerId),
    loadOwners(svc, ownerIds),
    loadSquadrons(svc, squadronIds),
  ]);
  const squadronMateIds = await loadSquadronMates(svc, viewer.squadronIds, viewerId);
  const coordinates = new Map<string, MapPoint>(rowCoordinates(rows, now));
  if (options.point && isMapPoint(options.point) && !coordinates.has(key)) coordinates.set(key, options.point);
  return shapeMapCarriers(rows, {
    viewerId,
    viewerSquadronIds: viewer.squadronIds,
    squadronMateIds,
    owners,
    squadrons,
    coordinates,
    now,
  }).filter((carrier) => carrierSystemKey(carrier.system) === key);
}
