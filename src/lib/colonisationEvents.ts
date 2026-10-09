/**
 * Единственная точка записи состояний стройплощадок в `colonisation_sites`.
 *
 * Таблица хранит ТЕКУЩЕЕ состояние каждой площадки (ключ — MarketID), а не
 * журнал событий. Читает её одно место — обогащение Raven Colonial, и ему нужна
 * только последняя известная картина площадки. Раньше все четыре пути записи
 * (браузерный загрузчик, Colonial Helper, страница журнала, CAPI) клали строку
 * на каждое событие `ColonisationConstructionDepot` и на каждого командира
 * отдельно, с полным `ResourcesRequired` (с `Payment` и `Name_Localised`) и
 * служебными полями. Отсюда 12+ ГБ при ~3 ГБ логов. См. COLONISATION-SITES-REWORK.md.
 *
 * Запись идёт через RPC `colonisation_sites_write` (миграция
 * 20261009010000_colonisation_sites.sql): в базе побеждает состояние с более
 * новой меткой времени журнала, поэтому повторная загрузка того же журнала и
 * параллельные пачки Helper'а не плодят строк. Список ресурсов сжимается уже
 * здесь (`compactResources`) и ещё раз на сервере — старые клиенты присылают
 * полный `ResourcesRequired`, и таблица остаётся лёгкой и при них.
 *
 * Модуль импортируется клиентским кодом (браузерный парсер берёт
 * `journalTelemetry.ts`), поэтому здесь нет node-модулей и обращений к окружению.
 */

/** Ресурс стройки в компактном виде — ровно то, что хранится и читается. */
export interface CompactResource {
  Name: string;
  Name_Localised?: string;
  RequiredAmount: number;
  ProvidedAmount: number;
}

/**
 * Строка `colonisation_sites`. `market_id` — текст: MarketID 64-битный, а
 * JSON-число может потерять точность. `construction_progress` — проценты.
 */
export interface ColonisationSiteRow {
  market_id: string;
  system_name: string;
  construction_id: string | null;
  construction_name: string | null;
  construction_progress: number | null;
  resources_total: CompactResource[];
  event_timestamp: string;
  user_id: string;
}

export interface DepotEventLike {
  timestamp?: string | null;
  systemName?: string | null;
  marketId?: string | number | null;
  constructionName?: string | null;
  constructionId?: string | number | null;
  /** Уже в процентах: так отдаёт `parseColonisationEvents`. */
  constructionProgress?: number | null;
  constructionComplete?: boolean;
  resourcesRequired?: unknown;
}

type DbError = { code?: string; message?: string };
type RpcResult = { data?: unknown; error?: DbError | null };
/** Минимум от клиента Supabase: нужен только `rpc`. */
type SiteWriter = { rpc: (fn: string, args: Record<string, unknown>) => any };

/** Пачка для одного RPC: тот же порядок, что у прежней записи журнала. */
export const SITE_WRITE_BATCH = 100;


/* ─────────────────────────── разбор значений ─────────────────────────── */

export function asText(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/**
 * 64-битные идентификаторы журнала (MarketID, ConstructionID) приходят и
 * строкой, и числом: строка из сырой строки журнала точна всегда, а число
 * может быть уже округлено JSON'ом. Оба варианта приводим к одному виду,
 * иначе один и тот же MarketID из разных клиентов не совпадёт.
 */
export function asId(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(value) : String(Math.trunc(value));
  }
  const text = String(value).trim();
  const match = text.match(/-?\d+/);
  return match ? match[0] : '';
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Строгое число для списка ресурсов: `null`, пустая строка и текст не дают 0.
 * Та же проверка стоит в SQL-функции `colonisation_compact_resources`.
 */
function strictNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Прогресс: журнал отдаёт долю (0.42), старые интеграции — проценты (42). */
export function progressPercent(value: unknown, complete = false): number | null {
  if (complete) return 100;
  const raw = asNumber(value);
  if (raw == null || raw < 0) return null;
  return Math.min(100, raw <= 1 ? raw * 100 : raw);
}

/** Прогресс в колонке NUMERIC(5,2): разницу мельче сотой база всё равно не сохранит. */
function roundProgress(percent: number): number {
  return Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100;
}

function progressKey(value: unknown): string {
  const percent = asNumber(value);
  if (percent == null || percent < 0) return '';
  return roundProgress(percent).toFixed(2);
}

/**
 * Компактный список ресурсов: `Name`, `Name_Localised` (если есть),
 * `RequiredAmount`, `ProvidedAmount`. `Payment` и прочие поля журнала не
 * хранятся. Элементы без имени или без числовых сумм отбрасываются. Список
 * сортируется по имени, чтобы один и тот же набор в другом порядке не выглядел
 * как изменение. Принимает и PascalCase журнала, и camelCase парсера сайта.
 */
export function compactResources(resources: unknown): CompactResource[] {
  if (!Array.isArray(resources)) return [];
  const out: CompactResource[] = [];
  for (const item of resources) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const nameValue = record.Name ?? record.name;
    const name = nameValue == null ? '' : String(nameValue);
    const required = strictNumber(record.RequiredAmount ?? record.requiredAmount);
    const provided = strictNumber(record.ProvidedAmount ?? record.providedAmount);
    if (!name || required == null || provided == null) continue;
    const localised = asText(record.Name_Localised ?? record.nameLocalised);
    out.push({
      Name: name,
      ...(localised ? { Name_Localised: localised } : {}),
      RequiredAmount: Math.max(0, required),
      ProvidedAmount: Math.max(0, provided),
    });
  }
  return out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
}

/**
 * Отпечаток состояния стройки — для «ничего не изменилось». Учитывает прогресс
 * и суммы по именам; локализация и `Payment` в него не входят: смена языка
 * журнала или цены не означает нового состояния площадки.
 */
export function depotStateFingerprint(progress: unknown, resources: unknown): string {
  const state = compactResources(resources)
    .map((row) => `${row.Name.toLowerCase()}:${row.RequiredAmount}:${row.ProvidedAmount}`)
    .sort()
    .join('~');
  return `${progressKey(progress)}\u0000${state}`;
}

/* ─────────────────────────── построение строк ─────────────────────────── */

/** ISO-метка времени журнала или `null`, если её нельзя разобрать. */
function journalTimestamp(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Строка площадки из события `ColonisationConstructionDepot` парсера сайта или
 * CAPI (страница журнала, синхронизация). `null`, если нет системы, метки
 * времени или MarketID: такая строка бесполезна — Raven ищет площадку по
 * MarketID, а подставленное «сейчас» вместо журнального времени превращало бы
 * повтор загрузки в «новое» состояние.
 */
export function siteRowFromDepot(userId: string, event: DepotEventLike): ColonisationSiteRow | null {
  const systemName = asText(event.systemName).slice(0, 250);
  const timestamp = journalTimestamp(event.timestamp);
  const marketId = asId(event.marketId);
  if (!systemName || !timestamp || !marketId || marketId === '0') return null;

  const progress = event.constructionComplete === true
    ? 100
    : asNumber(event.constructionProgress);

  return {
    market_id: marketId,
    system_name: systemName,
    construction_id: asId(event.constructionId) || null,
    construction_name: asText(event.constructionName).slice(0, 500) || null,
    construction_progress: progress == null ? null : roundProgress(progress),
    resources_total: compactResources(event.resourcesRequired),
    event_timestamp: timestamp,
    user_id: userId,
  };
}

/**
 * Строка площадки из телеметрии — формат, который присылают браузерный
 * загрузчик и Colonial Helper (`constructionEvents` / `construction_events`).
 * Прогресс там — доля журнала, её переводим в проценты.
 */
export function siteRowFromTelemetry(userId: string, event: Record<string, unknown>): ColonisationSiteRow | null {
  const systemName = asText(event.system_name ?? event.systemName).slice(0, 250);
  const timestamp = journalTimestamp(event.timestamp);
  const marketId = asId(event.market_id ?? event.marketId);
  if (!systemName || !timestamp || !marketId || marketId === '0') return null;

  const progress = progressPercent(
    event.construction_progress ?? event.ConstructionProgress ?? event.Progress,
    event.construction_complete === true || event.ConstructionComplete === true,
  );

  return {
    market_id: marketId,
    system_name: systemName,
    construction_id: asId(event.construction_id ?? event.constructionId) || null,
    construction_name: asText(event.construction_name ?? event.constructionName).slice(0, 500) || null,
    construction_progress: progress == null ? null : roundProgress(progress),
    resources_total: compactResources(event.resources_total ?? event.resourcesRequired),
    event_timestamp: timestamp,
    user_id: userId,
  };
}

/**
 * Последнее состояние каждой стройки из набора событий.
 *
 * Нужно там, где по событиям обновляют прогресс проекта (`updateProjectProgress`):
 * окно CAPI на каждом синке отдаёт одни и те же события, а запись прогресса на
 * каждое из них плодит снимки и обновления `commodity_needs` по кругу.
 */
export function latestDepotEvents<
  T extends { timestamp?: string | null; systemName?: string | null; constructionId?: string | number | null },
>(events: T[]): T[] {
  const latest = new Map<string, T>();
  for (const event of events) {
    const key = `${asText(event.systemName).toLowerCase()}\u0000${asId(event.constructionId)}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(asText(event.timestamp)) > Date.parse(asText(previous.timestamp))) {
      latest.set(key, event);
    }
  }
  return Array.from(latest.values());
}

/* ──────────────────────────── снимки прогресса ──────────────────────────── */

export interface DepotSnapshotRow {
  system_name: string;
  construction_id: string | null;
  construction_name: string | null;
  progress: number | null;
  resources_total: CompactResource[];
  snapshot_at: string;
  source: 'journal';
}

/**
 * Снимки для `construction_depot_snapshots`: по одному на стройку и только по
 * тем площадкам, у которых состояние действительно изменилось (`changedMarkets`
 * из `persistColonisationSites`). Повтор уже сохранённого состояния в историю
 * прогресса не попадает. Из нескольких строк одной стройки берётся самая
 * поздняя; при равной метке — последняя в пачке, как и в базе.
 */
export function snapshotRowsForChangedSites(
  rows: ColonisationSiteRow[],
  changedMarkets: ReadonlySet<string>,
): DepotSnapshotRow[] {
  const latest = new Map<string, ColonisationSiteRow>();
  for (const row of rows) {
    if (!changedMarkets.has(row.market_id)) continue;
    const key = `${row.system_name.toLowerCase()}\u0000${row.construction_id ?? row.construction_name ?? ''}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(row.event_timestamp) >= Date.parse(previous.event_timestamp)) {
      latest.set(key, row);
    }
  }
  return Array.from(latest.values()).map((row) => ({
    system_name: row.system_name,
    construction_id: row.construction_id,
    construction_name: row.construction_name,
    progress: row.construction_progress,
    resources_total: row.resources_total,
    snapshot_at: row.event_timestamp,
    source: 'journal' as const,
  }));
}

/* ──────────────────────────── запись в базу ──────────────────────────── */

export interface ColonisationSiteWriteOutcome {
  /** Новых или изменившихся состояний площадок (новая площадка тоже сюда). */
  changed: number;
  /** Состояние прежнее: обновились разве что метка времени и командир. */
  unchanged: number;
  /** Строк не понадобилось: старше сохранённого состояния или повтор внутри пачки. */
  stale: number;
  /** Строк, которые не записались из-за ошибки базы. */
  failed: number;
  /** MarketID площадок, у которых изменилось состояние — по ним снимки прогресса. */
  changedMarkets: Set<string>;
  warnings: string[];
}

function isStatementTimeout(error: DbError): boolean {
  if (error.code === '57014') return true;
  return /canceling statement due to statement timeout|statement timeout/i.test(error.message || '');
}

/**
 * Записать пачку; при таймауте базы делить её пополам — тот же приём, что для
 * сканов тел: большая пачка с тяжёлым JSON не успевает за отведённое время.
 */
async function writeSiteBatch(
  svc: SiteWriter,
  rows: ColonisationSiteRow[],
): Promise<{ data: Array<{ market_id: string; changed: boolean }>; error: DbError | null }> {
  const result = (await svc.rpc('colonisation_sites_write', { p_rows: rows })) as RpcResult;
  if (!result.error) {
    const data = Array.isArray(result.data) ? result.data as Array<{ market_id: string; changed: boolean }> : [];
    return { data, error: null };
  }
  if (!isStatementTimeout(result.error) || rows.length <= 1) {
    return { data: [], error: result.error };
  }
  const middle = Math.floor(rows.length / 2);
  const left = await writeSiteBatch(svc, rows.slice(0, middle));
  const right = await writeSiteBatch(svc, rows.slice(middle));
  return { data: [...left.data, ...right.data], error: right.error ?? left.error ?? null };
}

/**
 * Записать состояния площадок, не создавая повторов.
 *
 * Возвращает число новых/изменившихся состояний, повторы, устаревшие строки и
 * площадки, у которых состояние изменилось (для снимков прогресса).
 * Ошибки базы не бросаются наружу: загрузчик журнала собирает их в `warnings`,
 * и потеря телеметрии не должна рушить импорт доставок.
 */
export async function persistColonisationSites(
  svc: SiteWriter,
  rows: ColonisationSiteRow[],
  options: { batchSize?: number } = {},
): Promise<ColonisationSiteWriteOutcome> {
  const outcome: ColonisationSiteWriteOutcome = {
    changed: 0,
    unchanged: 0,
    stale: 0,
    failed: 0,
    changedMarkets: new Set<string>(),
    warnings: [],
  };
  if (rows.length === 0) return outcome;

  const batchSize = Math.max(1, options.batchSize ?? SITE_WRITE_BATCH);
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const { data, error } = await writeSiteBatch(svc, batch);
    for (const item of data) {
      if (item.changed) {
        outcome.changed += 1;
        outcome.changedMarkets.add(String(item.market_id));
      } else {
        outcome.unchanged += 1;
      }
    }
    const rest = batch.length - data.length;
    if (error) {
      outcome.failed += rest;
      outcome.warnings.push(`colonisation sites: ${error.message || 'write failed'}`);
    } else {
      outcome.stale += rest;
    }
  }
  return outcome;
}
