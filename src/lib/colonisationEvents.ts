/**
 * Единственная точка записи строк в `colonisation_events`.
 *
 * Таблицу кормят три клиента с разными форматами: браузерный загрузчик
 * (`/api/logs/import`, парсер `journalParser.ts` + `journalTelemetry.ts`),
 * десктопный Colonial Helper (`/api/logs/upload`) и синхронизация CAPI
 * (`/api/capi/sync`, `/api/cron/capi-sync`). Раньше каждый путь строил строки
 * сам и вставлял их своим способом, поэтому одинаковые события журнала
 * попадали в базу по несколько раз:
 *
 * * уникальный ключ схемы (`user_id, event_timestamp, system_name,
 *   construction_id`) не работает, когда `construction_id` пуст — в PostgreSQL
 *   NULL не равен NULL, и строка проходит мимо ограничения (так вели себя
 *   все `ColonisationContribution` и события без `ConstructionID`);
 * * повторная отправка того же состояния стройки с новой меткой времени
 *   (живой watcher Helper'а пишет такое каждые 5 секунд) не является
 *   дубликатом по этому ключу и оседала в таблице отдельной строкой;
 * * голый `insert()` без проверки ошибки (CAPI) молча терял всю пачку на
 *   первом же конфликте либо добавлял строки с пустым именем системы.
 *
 * Здесь для каждой строки считается `source_hash` — устойчивый ключ
 * состояния стройки (для остальных событий — ключ самого события). Запись
 * идёт upsert'ом по `(user_id, source_hash)`; до тех пор, пока миграция и
 * частичный уникальный индекс не приехали на прод, работает тот же путь, что
 * и раньше (см. `persistColonisationEvents`).
 *
 * Модуль импортируется и клиентским кодом (браузерный парсер берёт
 * `journalTelemetry.ts`), поэтому здесь нет ни `node:crypto`, ни обращений к
 * окружению: отпечаток считается той же чистой JS-функцией, что и
 * `source_hash` доставок в `journalParser.ts`.
 */

export type ColonisationEventRow = {
  user_id: string;
  journal_import_id?: number | null;
  event_timestamp: string;
  system_name: string;
  market_id: string | null;
  construction_name: string | null;
  construction_id: string | null;
  construction_progress: number | null;
  resources_total: unknown[];
  raw_event: Record<string, unknown>;
  source_hash: string;
};

/**
 * Версия правил отпечатка. Меняется вместе с содержимым ключа: старые строки
 * остаются со своими ключами, новые события получают новые — поэтому правку
 * формулы видно по тем же диагностическим запросам, что и обычные повторы.
 */
export const COLONISATION_HASH_VERSION = 'colony-v1';

/** Ключ состояния стройки: меняется только когда меняется сама стройка. */
const DEPOT_EVENT = 'ColonisationConstructionDepot';

export interface ColonisationStateInput {
  eventKind: string;
  systemName: string;
  marketId?: string | number | null;
  constructionId?: string | number | null;
  constructionName?: string | null;
  /** Прогресс в процентах (0..100) — журнал пишет долю, парсеры домножают. */
  progress?: number | string | null;
  resources?: unknown;
  eventTimestamp?: string | null;
}

type DbError = { code?: string; message?: string };
type DbResult = { data?: unknown; error?: DbError | null };
type DbLike = { from: (table: string) => any };

/** FNV-1a по двум регистрам — тот же приём, что у `fingerprint()` парсера. */
function fingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

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

/** Прогресс: журнал отдаёт долю (0.42), старые интеграции — проценты (42). */
export function progressPercent(value: unknown, complete = false): number | null {
  if (complete) return 100;
  const raw = asNumber(value);
  if (raw == null || raw < 0) return null;
  return Math.min(100, raw <= 1 ? raw * 100 : raw);
}

function progressKey(value: unknown): string {
  const percent = asNumber(value);
  if (percent == null || percent < 0) return '';
  // Колонка — NUMERIC(5,2): разницу мельче второго знака база всё равно не
  // сохранит, а отдельной строкой она была бы мусором.
  return Math.min(100, percent).toFixed(2);
}

function timestampKey(value: unknown): string {
  const text = asText(value);
  if (!text) return '';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

/**
 * Слепок списка ресурсов. Локальные названия (`Name_Localised`) в него не
 * входят: журнал переводится на язык клиента, и один и тот же ресурс в русской
 * и английской версиях дал бы разные ключи — то есть «дубликаты» строки на
 * ровном месте. Порядок ресурсов тоже не важен: сортируем.
 */
function resourcesFingerprint(resources: unknown): string {
  if (!Array.isArray(resources)) return '';
  const rows = resources
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const name = asText(item.Name ?? item.name).toLowerCase();
      const required = asNumber(item.RequiredAmount ?? item.requiredAmount) ?? 0;
      const provided = asNumber(item.ProvidedAmount ?? item.providedAmount) ?? 0;
      const payment = asNumber(item.Payment ?? item.payment) ?? 0;
      return `${name}:${required}:${provided}:${payment}`;
    })
    .sort();
  return rows.join('~');
}

/**
 * Устойчивый ключ состояния для `source_hash`.
 *
 * Для `ColonisationConstructionDepot` метка времени в ключ **не** входит:
 * журнал пишет это событие каждые несколько секунд, пока игрок стоит у
 * площадки, а состояние при этом не меняется. Именно такие строки и
 * заполняли таблицу: одинаковое состояние, разные `timestamp`.
 *
 * Для остальных событий (например, `ColonisationContribution`) метка времени
 * входит в ключ: там каждая запись — отдельный факт, а не снимок состояния.
 */
export function colonisationStateKey(input: ColonisationStateInput): string {
  const kind = asText(input.eventKind);
  const isDepot = kind === DEPOT_EVENT;
  return [
    kind,
    asText(input.systemName).toLowerCase(),
    asId(input.marketId),
    asId(input.constructionId),
    asText(input.constructionName).toLowerCase(),
    progressKey(input.progress),
    resourcesFingerprint(input.resources),
    isDepot ? '' : timestampKey(input.eventTimestamp),
  ].join('\u0000');
}

export function colonisationSourceHash(input: ColonisationStateInput): string {
  return `${COLONISATION_HASH_VERSION}-${fingerprint(colonisationStateKey(input))}`;
}

/* ─────────────────────────── построение строк ─────────────────────────── */

export interface DepotEventLike {
  timestamp?: string | null;
  systemName?: string | null;
  marketId?: string | number | null;
  constructionName?: string | null;
  constructionId?: string | number | null;
  constructionProgress?: number | null;
  constructionComplete?: boolean;
  resourcesRequired?: unknown;
}

export interface ContributionEventLike {
  timestamp?: string | null;
  systemName?: string | null;
  marketId?: string | number | null;
  commodity?: string | null;
  amount?: number | null;
}

/**
 * Строка `ColonisationConstructionDepot` из парсера сайта или CAPI.
 *
 * Возвращает `null`, если в событии нет системы или метки времени: такая
 * строка бесполезна (карта и Raven ищут её по MarketID), а подстановка
 * `now()` вместо отсутствующей метки делала из одной и той же записи новую
 * строку при каждом повторе загрузки.
 */
export function depotEventRow(
  userId: string,
  event: DepotEventLike,
  journalImportId?: number | null,
): ColonisationEventRow | null {
  const systemName = asText(event.systemName).slice(0, 250);
  const timestamp = asText(event.timestamp);
  if (!systemName || !timestamp) return null;

  const marketId = asId(event.marketId);
  const constructionId = asId(event.constructionId);
  const constructionName = asText(event.constructionName).slice(0, 500) || null;
  const progress = event.constructionComplete === true
    ? 100
    : (event.constructionProgress == null ? null : asNumber(event.constructionProgress));
  const resources = Array.isArray(event.resourcesRequired) ? event.resourcesRequired : [];
  const rawEvent = event as unknown as Record<string, unknown>;

  return {
    user_id: userId,
    journal_import_id: journalImportId ?? null,
    event_timestamp: timestamp,
    system_name: systemName,
    market_id: marketId || null,
    construction_name: constructionName,
    construction_id: constructionId || null,
    construction_progress: progress == null ? null : Math.min(100, Math.max(0, progress)),
    resources_total: resources,
    raw_event: rawEvent,
    source_hash: colonisationSourceHash({
      eventKind: asText((rawEvent as Record<string, unknown>).event) || DEPOT_EVENT,
      systemName,
      marketId,
      constructionId,
      constructionName,
      progress,
      resources,
      eventTimestamp: timestamp,
    }),
  };
}

/** Строка `ColonisationContribution` из парсера сайта (страница журнала). */
export function contributionEventRow(
  userId: string,
  event: ContributionEventLike,
  journalImportId?: number | null,
): ColonisationEventRow | null {
  const systemName = asText(event.systemName).slice(0, 250);
  const timestamp = asText(event.timestamp);
  if (!systemName || !timestamp) return null;

  const marketId = asId(event.marketId);
  const commodity = asText(event.commodity);
  const amount = asNumber(event.amount) ?? 0;
  const resources = [{
    name: commodity,
    requiredAmount: 0,
    providedAmount: amount,
    payment: 0,
  }];
  const rawEvent = event as unknown as Record<string, unknown>;

  return {
    user_id: userId,
    journal_import_id: journalImportId ?? null,
    event_timestamp: timestamp,
    system_name: systemName,
    market_id: marketId || null,
    construction_name: null,
    construction_id: null,
    construction_progress: null,
    resources_total: resources,
    raw_event: rawEvent,
    source_hash: colonisationSourceHash({
      eventKind: 'ColonisationContribution',
      systemName,
      marketId,
      constructionId: '',
      constructionName: '',
      progress: null,
      resources,
      eventTimestamp: timestamp,
    }),
  };
}

/**
 * Строка телеметрии — формат, который присылают браузерный загрузчик и
 * Colonial Helper (`constructionEvents`/`construction_events`).
 */
export function telemetryConstructionRow(
  userId: string,
  event: Record<string, unknown>,
): ColonisationEventRow | null {
  const systemName = asText(event.system_name ?? event.systemName).slice(0, 250);
  const timestamp = asText(event.timestamp);
  if (!systemName || !timestamp) return null;

  const marketId = asId(event.market_id);
  const constructionId = asId(event.construction_id);
  const constructionName = asText(event.construction_name).slice(0, 500) || null;
  const progress = progressPercent(
    event.construction_progress ?? event.ConstructionProgress ?? event.Progress,
    event.construction_complete === true || event.ConstructionComplete === true,
  );
  const resources = Array.isArray(event.resources_total) ? event.resources_total : [];
  const rawEvent = event.raw_event && typeof event.raw_event === 'object'
    ? event.raw_event as Record<string, unknown>
    : event;

  return {
    user_id: userId,
    journal_import_id: null,
    event_timestamp: timestamp,
    system_name: systemName,
    market_id: marketId || null,
    construction_name: constructionName,
    construction_id: constructionId || null,
    construction_progress: progress,
    resources_total: resources,
    raw_event: rawEvent,
    source_hash: colonisationSourceHash({
      eventKind: asText(rawEvent.event) || DEPOT_EVENT,
      systemName,
      marketId,
      constructionId,
      constructionName,
      progress,
      resources,
      eventTimestamp: timestamp,
    }),
  };
}

/** Отпечаток состояния площадки без системы и ID — для проверки «не изменилось». */
export function depotStateFingerprint(progress: unknown, resources: unknown): string {
  return `${progressKey(progress)}\u0000${resourcesFingerprint(resources)}`;
}

/**
 * Последнее состояние каждой стройки из набора событий.
 *
 * Нужно там, где по событиям обновляют прогресс проекта
 * (`updateProjectProgress`): окно CAPI на каждом синке отдаёт одни и те же
 * события, а запись прогресса на каждое из них плодит снимки и обновления
 * `commodity_needs` по кругу.
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

/* ──────────────────────────── запись в базу ──────────────────────────── */

export interface ColonisationWriteOutcome {
  inserted: number;
  duplicates: number;
  /**
   * Отпечатки строк, которые действительно записались. По ним вызывающий код
   * понимает, для каких событий стоит писать снимок прогресса: повторно
   * присланное состояние стройки не должно попадать ещё и в
   * `construction_depot_snapshots`.
   */
  insertedHashes: Set<string>;
  warnings: string[];
}

const WRITE_BATCH = 100;
const HASH_LOOKUP_CHUNK = 100;

type SourceHashMode = 'unknown' | 'unique-index' | 'no-column' | 'column-without-index';

/**
 * Режим записи запоминается на процесс: колонка `source_hash` появляется
 * миграцией, а API может уехать на прод раньше неё. Тогда пишем как раньше —
 * по ключу схемы, — и загрузка журнала не падает целиком.
 */
let sourceHashMode: SourceHashMode = 'unknown';

/** Только для тестов: сбросить запомненный режим записи. */
export function resetColonisationWriteMode(): void {
  sourceHashMode = 'unknown';
}

function isStatementTimeout(error: DbError): boolean {
  if (error.code === '57014') return true;
  return /canceling statement due to statement timeout|statement timeout/i.test(error.message || '');
}

function isMissingSourceHash(error: DbError): boolean {
  return (
    error.code === '42703'
    || error.code === 'PGRST204'
    || /source_hash.*(?:does not exist|could not find)|could not find.*source_hash/i.test(error.message || '')
  );
}

function isMissingConflictTarget(error: DbError): boolean {
  return error.code === '42P10'
    || /no unique or exclusion constraint|there is no unique or exclusion constraint/i.test(error.message || '');
}

/** Схлопнуть повторы внутри одной пачки — до обращения к базе. */
export function collapseRowsByHash(rows: ColonisationEventRow[]): {
  rows: ColonisationEventRow[];
  duplicates: number;
} {
  const unique = new Map<string, ColonisationEventRow>();
  let duplicates = 0;
  for (const row of rows) {
    if (unique.has(row.source_hash)) {
      duplicates += 1;
      continue;
    }
    unique.set(row.source_hash, row);
  }
  return { rows: Array.from(unique.values()), duplicates };
}

async function writeBatch(
  svc: DbLike,
  rows: ColonisationEventRow[],
  mode: SourceHashMode,
): Promise<{ written: Array<Record<string, unknown>>; error: DbError | null }> {
  const table = svc.from('colonisation_events');

  if (mode === 'no-column') {
    // Колонки на сервере ещё нет: пишем прежним ключом схемы. Из полезной
    // нагрузки `source_hash` убираем — иначе PostgREST отвергнет все строки.
    const payload = rows.map(({ source_hash: _sourceHash, ...rest }) => rest);
    const result: DbResult = await table
      .upsert(payload, {
        onConflict: 'user_id,event_timestamp,system_name,construction_id',
        ignoreDuplicates: true,
      })
      .select('id');
    return { written: (result.data as Array<Record<string, unknown>>) ?? [], error: result.error ?? null };
  }

  if (mode === 'column-without-index') {
    // Уникального индекса ещё нет, поэтому `ON CONFLICT (user_id,
    // source_hash)` базе незнаком: пишем обычной вставкой то, чего в таблице
    // нет (сверку делает `fetchExistingHashes`).
    const result: DbResult = await table.insert(rows).select('id, source_hash');
    return { written: (result.data as Array<Record<string, unknown>>) ?? [], error: result.error ?? null };
  }

  const result: DbResult = await table
    .upsert(rows, { onConflict: 'user_id,source_hash', ignoreDuplicates: true })
    .select('id, source_hash');
  return { written: (result.data as Array<Record<string, unknown>>) ?? [], error: result.error ?? null };
}

/**
 * Записать пачку, при `statement_timeout` деля её пополам: тот же приём, что
 * для сканов тел (`upsertWithinStatementTimeout`), — большая пачка с тяжёлым
 * JSON не успевает за отведённое PostgREST время.
 */
async function writeBatchWithSplit(
  svc: DbLike,
  rows: ColonisationEventRow[],
  mode: SourceHashMode,
): Promise<{ written: Array<Record<string, unknown>>; error: DbError | null }> {
  const result = await writeBatch(svc, rows, mode);
  if (!result.error) return result;
  if (!isStatementTimeout(result.error) || rows.length <= 1) return { written: [], error: result.error };
  const middle = Math.floor(rows.length / 2);
  const left = await writeBatchWithSplit(svc, rows.slice(0, middle), mode);
  const right = await writeBatchWithSplit(svc, rows.slice(middle), mode);
  return { written: [...left.written, ...right.written], error: right.error ?? left.error ?? null };
}

/** Есть ли уже такие отпечатки в базе (путь без уникального индекса). */
async function fetchExistingHashes(
  svc: DbLike,
  userId: string,
  hashes: string[],
): Promise<Set<string>> {
  const known = new Set<string>();
  for (let index = 0; index < hashes.length; index += HASH_LOOKUP_CHUNK) {
    const chunk = hashes.slice(index, index + HASH_LOOKUP_CHUNK);
    // `IS NOT NULL` не косметика: индекс частичный (`WHERE source_hash IS NOT
    // NULL`), и планировщик применит его, только если предикат выводится из
    // запроса (та же тонкость, что у `deliveries`).
    const { data, error } = await svc
      .from('colonisation_events')
      .select('source_hash')
      .eq('user_id', userId)
      .not('source_hash', 'is', null)
      .in('source_hash', chunk);
    if (error) throw Object.assign(new Error(error.message || 'select source_hash failed'), { code: error.code });
    for (const row of (data as Array<{ source_hash?: string | null }> | null) ?? []) {
      if (row?.source_hash) known.add(row.source_hash);
    }
  }
  return known;
}

/**
 * Записать события стройки, не создавая повторов.
 *
 * Возвращает число реально записанных строк (а не отправленных), количество
 * отброшенных повторов и предупреждения. Ошибки базы не бросаются наружу:
 * загрузчик журнала собирает их в `warnings`, как и раньше, — потеря
 * телеметрии не должна рушить импорт доставок.
 */
export async function persistColonisationEvents(
  svc: DbLike,
  incoming: ColonisationEventRow[],
  options: { batchSize?: number } = {},
): Promise<ColonisationWriteOutcome> {
  const outcome: ColonisationWriteOutcome = {
    inserted: 0,
    duplicates: 0,
    insertedHashes: new Set<string>(),
    warnings: [],
  };

  const collapsed = collapseRowsByHash(incoming);
  outcome.duplicates += collapsed.duplicates;
  const rows = collapsed.rows;
  if (rows.length === 0) return outcome;

  const batchSize = Math.max(1, options.batchSize ?? WRITE_BATCH);
  let mode: SourceHashMode = sourceHashMode === 'unknown' ? 'unique-index' : sourceHashMode;
  let degraded = false;
  let index = 0;

  while (index < rows.length) {
    const batch = rows.slice(index, index + batchSize);

    // Колонка есть, уникального индекса ещё нет: сверяемся с записанным и
    // добавляем только отсутствующее. Каждый запрос ограничен пачкой, поэтому
    // путь безопасен и на больших журналах.
    if (mode === 'column-without-index') {
      index += batch.length;
      try {
        const existing = await fetchExistingHashes(svc, batch[0].user_id, batch.map((row) => row.source_hash));
        outcome.duplicates += existing.size;
        const missing = batch.filter((row) => !existing.has(row.source_hash));
        if (missing.length === 0) continue;
        const write = await writeBatchWithSplit(svc, missing, mode);
        if (write.error) {
          outcome.warnings.push(`colonisation events: ${write.error.message || 'write failed'}`);
          continue;
        }
        outcome.inserted += write.written.length;
        for (const row of write.written) {
          if (typeof row?.source_hash === 'string') outcome.insertedHashes.add(row.source_hash);
        }
      } catch (error) {
        outcome.warnings.push(`colonisation events: ${(error as Error).message}`);
      }
      continue;
    }

    const result = await writeBatchWithSplit(svc, batch, mode);

    if (result.error && mode === 'unique-index') {
      // Первая же пачка показывает, что именно недоступно на этом сервере:
      // колонки нет вовсе (падает сам insert) или нет уникального индекса
      // (конфликтный ключ неизвестен базе). Пачка при этом не записалась —
      // повторяем её тем путём, который здесь работает.
      if (isMissingSourceHash(result.error)) {
        mode = 'no-column';
      } else if (isMissingConflictTarget(result.error)) {
        mode = 'column-without-index';
      } else {
        outcome.warnings.push(`colonisation events: ${result.error.message || 'write failed'}`);
        index += batch.length;
        continue;
      }
      sourceHashMode = mode;
      degraded = true;
      continue;
    }

    if (result.error) {
      outcome.warnings.push(`colonisation events: ${result.error.message || 'write failed'}`);
      index += batch.length;
      continue;
    }

    outcome.inserted += result.written.length;
    outcome.duplicates += Math.max(0, batch.length - result.written.length);
    if (mode === 'no-column') {
      // Схема без `source_hash`: ответ приходит без отпечатков, поэтому
      // считаем записанными все строки пачки — иначе по ним не построятся
      // снимки прогресса. Различать вставленные и отброшенные строки здесь
      // нечем, но и повторов этот путь не создаёт: ключ схемы остался прежним.
      for (const row of batch) outcome.insertedHashes.add(row.source_hash);
    } else {
      for (const row of result.written) {
        if (typeof row?.source_hash === 'string') outcome.insertedHashes.add(row.source_hash);
      }
    }
    index += batch.length;
  }

  if (degraded) {
    outcome.warnings.push(
      'colonisation events: запись идёт без source_hash — примените миграцию и уникальный индекс',
    );
  }

  return outcome;
}
