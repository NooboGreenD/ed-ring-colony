/**
 * Сверка тел системы между базой проекта (`system_scans`) и EDSM.
 *
 * До этого модуля «Архитектор» показывал тела из базы проекта, а к EDSM
 * обращался только когда база пустая (см. `/api/atlas/system-bodies`).
 * Проблема: база могла быть старой или неполной (например, тело найдено
 * в EDSM позже, чем в неё в последний раз что-то писал Colonial Helper), а
 * EDSM — вообще без сигналов и без данных, кто открыл тело. Раньше «более
 * старый» источник побеждал просто потому, что оказался первым.
 *
 * Здесь оба источника запрашиваются вместе, для каждого тела считается
 * «счёт точности» (полнота полей + признаки реального сканирования +
 * свежесть записи), и побеждает более точный источник — при этом пустые
 * поля победителя достраиваются из второго источника, а не отбрасываются.
 *
 * Модуль без сети и без React: его можно гонять в тестах напрямую.
 */

export type BodyRecordSource = 'database' | 'edsm' | 'spansh' | 'merged';

/** Источник данных о телах, участвующий в сверке. */
export type BodySourceId = 'database' | 'edsm' | 'spansh';

/** Строка в форме таблицы `system_scans` (или её EDSM-эквивалент). */
export type BodyRow = Record<string, unknown>;

export interface CompareOptions {
  /** Текущее время в мс — для расчёта свежести записи. По умолчанию `Date.now()`. */
  now?: number;
}

export interface BodyComparison {
  /** Итоговая запись: лучший источник, дополненный полями из второго. */
  record: BodyRow;
  source: BodyRecordSource;
  dbScore: number | null;
  edsmScore: number | null;
  /** Какие поля дополнительно взяты не из основного источника — для UI/логов. */
  filledFrom: string[];
}

export interface CompareSummary {
  bodies: BodyRow[];
  stats: { database: number; edsm: number; spansh: number; merged: number; total: number };
  /**
   * Записи, которые стоит записать в базу проекта: EDSM дала данные, которых
   * там не было, либо слияние что-то уточнило. Уже в форме для upsert
   * (`system_name`, `body_name`, без `id`).
   */
  toUpsert: BodyRow[];
}

/**
 * Поля, по которым 0/пусто считается «неизвестно», а не настоящим значением —
 * поэтому их можно достроить из второго источника, не боясь затереть верные
 * данные значением-заглушкой.
 */
const FILLABLE_FIELDS = [
  // Описательные поля: без класса тела «Архитектор» показывал «Неизвестно»
  // и не мог судить о слотах, хотя соседний источник класс знал.
  'sub_type',
  'body_type',
  'body_id',
  'distance_ls',
  'parents',
  'is_terraformable',
  'semi_major_axis_ls',
  'radius_m',
  'gravity',
  'earth_masses',
  'surface_temp_k',
  'surface_pressure',
  'volcanism',
  'atmosphere',
  'atmosphere_type',
  'atmosphere_composition',
  'solid_composition',
  'materials',
  'rings',
  'bio_genuses',
  'first_discovered_by',
  'first_mapped_by',
  'first_footfall_by',
  'scanned_by_cmdr',
  'bio_signals_count',
  'geo_signals_count',
  'human_signals_count',
  'thargoid_signals_count',
  'guardian_signals_count',
  'other_signals_count',
  'signals',
] as const;

/** Сигналы тела отдаёт только собственная база (реальный сканер игрока). */
const SIGNAL_COUNT_FIELDS = [
  'bio_signals_count',
  'geo_signals_count',
  'human_signals_count',
  'thargoid_signals_count',
  'guardian_signals_count',
  'other_signals_count',
];

const CREDIT_FIELDS = ['first_discovered_by', 'first_mapped_by', 'first_footfall_by', 'scanned_by_cmdr'];

function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function toTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Возраст записи в днях: `updated_at`/`created_at` для базы проекта,
 * `discovery.date` внутри `raw_data` для тел, нормализованных из EDSM.
 * Неизвестно — `null`, тогда свежесть не учитывается (не штрафуем и не хвалим).
 */
function recordAgeDays(row: BodyRow, now: number): number | null {
  const rawUpdated = row.updated_at ?? row.created_at;
  let ts = toTimestamp(rawUpdated);
  if (ts == null) {
    const raw = row.raw_data as Record<string, unknown> | undefined;
    const discovery = raw && typeof raw === 'object' ? (raw as any).discovery : null;
    ts = toTimestamp(discovery?.date);
  }
  if (ts == null) return null;
  return Math.max(0, (now - ts) / 86_400_000);
}

/**
 * Счёт точности записи: полнота физических полей (по 1 очку за поле),
 * +6 за реальные сигналы тела (их отдаёт только сканер игрока, EDSM — никогда),
 * +3 за отметку об открытии/картографировании/сканировании командиром,
 * бонус за свежесть (запись моложе — точнее, если это не единственный критерий).
 */
export function scoreBodyRecord(row: BodyRow, opts: CompareOptions = {}): number {
  const now = opts.now ?? Date.now();
  let score = 0;

  const physicalFields = [
    'radius_m', 'gravity', 'earth_masses', 'surface_temp_k', 'surface_pressure',
    'volcanism', 'atmosphere', 'atmosphere_type', 'atmosphere_composition',
    'solid_composition', 'materials', 'rings',
  ];
  for (const field of physicalFields) {
    if (!isEmptyValue(row[field])) score += 1;
  }

  const hasSignals = SIGNAL_COUNT_FIELDS.some((field) => Number(row[field] ?? 0) > 0);
  if (hasSignals) score += 6;

  const hasCredit = CREDIT_FIELDS.some((field) => !isEmptyValue(row[field]));
  if (hasCredit) score += 3;

  const ageDays = recordAgeDays(row, now);
  if (ageDays != null) {
    if (ageDays <= 1) score += 3;
    else if (ageDays <= 7) score += 2;
    else if (ageDays <= 30) score += 1;
    // старше месяца — без бонуса, но и без штрафа: физические параметры тела
    // в игре не «протухают», в отличие от рыночных цен.
  }

  return score;
}

/**
 * Сравнивает запись базы и запись EDSM для одного и того же тела: выбирает
 * более точный источник по `scoreBodyRecord`, дополняет его пустые поля из
 * второго источника и честно помечает, какие поля позаимствованы.
 */
export function compareBodyRecords(
  dbRow: BodyRow | null,
  edsmRow: BodyRow | null,
  opts: CompareOptions = {},
): BodyComparison | null {
  if (!dbRow && !edsmRow) return null;
  if (dbRow && !edsmRow) {
    return { record: dbRow, source: 'database', dbScore: scoreBodyRecord(dbRow, opts), edsmScore: null, filledFrom: [] };
  }
  if (!dbRow && edsmRow) {
    return { record: edsmRow, source: 'edsm', dbScore: null, edsmScore: scoreBodyRecord(edsmRow, opts), filledFrom: [] };
  }

  const dbScore = scoreBodyRecord(dbRow as BodyRow, opts);
  const edsmScore = scoreBodyRecord(edsmRow as BodyRow, opts);
  const dbWins = dbScore >= edsmScore;
  const primary = dbWins ? (dbRow as BodyRow) : (edsmRow as BodyRow);
  const secondary = dbWins ? (edsmRow as BodyRow) : (dbRow as BodyRow);

  const merged: BodyRow = { ...primary };
  const filledFrom: string[] = [];
  for (const field of FILLABLE_FIELDS) {
    if (isEmptyValue(merged[field]) && !isEmptyValue(secondary[field])) {
      merged[field] = secondary[field];
      filledFrom.push(field);
    }
  }

  return {
    record: merged,
    source: filledFrom.length > 0 ? 'merged' : (dbWins ? 'database' : 'edsm'),
    dbScore,
    edsmScore,
    filledFrom,
  };
}

/**
 * Ключ тела для сверки: имя без учёта регистра, лишних и неразрывных
 * пробелов. Раньше ключ был «как пришло, в нижнем регистре», поэтому
 * `Colonia  2` и `Colonia 2` считались разными телами и попадали в список
 * дважды.
 */
function bodyKey(row: BodyRow): string {
  return String(row.body_name ?? row.name ?? '')
    .replace(/[\u00a0\u202f\u2007]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Сложить строки одного источника в индекс по имени тела. Дубли внутри
 * источника (одно тело двумя строками) не отбрасываются вслепую: остаётся
 * запись с большим счётом точности, а её пустые поля достраиваются из
 * второй — иначе терялись бы сигналы из более старой записи.
 */
function indexSource(rows: BodyRow[], opts: CompareOptions): { index: Map<string, BodyRow>; duplicates: number } {
  const index = new Map<string, BodyRow>();
  let duplicates = 0;
  for (const row of rows) {
    const key = bodyKey(row);
    if (!key) continue;
    const known = index.get(key);
    if (!known) {
      index.set(key, row);
      continue;
    }
    duplicates += 1;
    const merged = compareBodyRecords(known, row, opts);
    index.set(key, merged?.record ?? known);
  }
  return { index, duplicates };
}

/**
 * Сверка тел по нескольким источникам сразу (база проекта, EDSM, Spansh).
 *
 * Для каждого тела выбирается запись с наибольшим счётом точности, а её
 * пустые поля достраиваются из остальных источников по убыванию счёта.
 * Это обобщение `compareSystemBodies` на N источников: Spansh (тот же
 * источник, из которого импортирует Raven Colonial) отдаёт сигналы тел и
 * терраформирование, которых нет в EDSM, но может отставать от свежего
 * скана игрока — поэтому «кто точнее» решает счёт, а не порядок аргументов.
 */
export function compareBodySources(
  sources: Partial<Record<BodySourceId, BodyRow[]>>,
  opts: CompareOptions = {},
): CompareSummary & { duplicates: Partial<Record<BodySourceId, number>> } {
  const order: BodySourceId[] = ['database', 'edsm', 'spansh'];
  const indexes = new Map<BodySourceId, Map<string, BodyRow>>();
  const duplicates: Partial<Record<BodySourceId, number>> = {};

  for (const id of order) {
    const rows = sources[id];
    if (!rows || rows.length === 0) continue;
    const { index, duplicates: count } = indexSource(rows, opts);
    indexes.set(id, index);
    if (count > 0) duplicates[id] = count;
  }

  const keys = new Set<string>();
  for (const index of indexes.values()) for (const key of index.keys()) keys.add(key);

  const stats = { database: 0, edsm: 0, spansh: 0, merged: 0, total: 0 };
  const bodies: BodyRow[] = [];
  const toUpsert: BodyRow[] = [];

  for (const key of keys) {
    const candidates = order
      .map((id) => ({ id, row: indexes.get(id)?.get(key) ?? null }))
      .filter((entry): entry is { id: BodySourceId; row: BodyRow } => entry.row != null)
      .map((entry) => ({ ...entry, score: scoreBodyRecord(entry.row, opts) }))
      // При равном счёте выигрывает более ранний источник: база → EDSM → Spansh.
      .sort((left, right) => right.score - left.score || order.indexOf(left.id) - order.indexOf(right.id));

    if (candidates.length === 0) continue;
    const winner = candidates[0];
    const merged: BodyRow = { ...winner.row };
    const filledFrom: string[] = [];
    for (const other of candidates.slice(1)) {
      for (const field of FILLABLE_FIELDS) {
        if (isEmptyValue(merged[field]) && !isEmptyValue(other.row[field])) {
          merged[field] = other.row[field];
          filledFrom.push(field);
        }
      }
    }

    const source: BodyRecordSource = filledFrom.length > 0 ? 'merged' : winner.id;
    stats.total += 1;
    stats[source] += 1;
    bodies.push(merged);

    // В базу дозаписываем всё, что пришло не из неё или было уточнено.
    if (source !== 'database') {
      const { id, ...rest } = merged as Record<string, unknown> & { id?: unknown };
      toUpsert.push({ ...rest, updated_at: new Date(opts.now ?? Date.now()).toISOString() });
    }
  }

  bodies.sort(compareByDistance);

  return { bodies, stats, toUpsert, duplicates };
}

/** Сортировка тел: по расстоянию, затем по номеру тела и имени — стабильно. */
function compareByDistance(a: BodyRow, b: BodyRow): number {
  const da = typeof a.distance_ls === 'number' ? a.distance_ls : Number.POSITIVE_INFINITY;
  const db = typeof b.distance_ls === 'number' ? b.distance_ls : Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  const ia = typeof a.body_id === 'number' ? a.body_id : Number.MAX_SAFE_INTEGER;
  const ib = typeof b.body_id === 'number' ? b.body_id : Number.MAX_SAFE_INTEGER;
  if (ia !== ib) return ia - ib;
  return String(a.body_name ?? '').localeCompare(String(b.body_name ?? ''), 'ru');
}

/**
 * Сверяет тела базы проекта и EDSM. Обёртка над `compareBodySources`,
 * оставленная ради совместимости: ею пользуется обычный режим маршрута и
 * существующие тесты.
 */
export function compareSystemBodies(
  dbRows: BodyRow[],
  edsmRows: BodyRow[],
  opts: CompareOptions = {},
): CompareSummary {
  const { bodies, stats, toUpsert } = compareBodySources({ database: dbRows, edsm: edsmRows }, opts);
  return { bodies, stats, toUpsert };
}

/**
 * Приводит одно тело из ответа EDSM (`api-system-v1/bodies`) к форме строки
 * `system_scans`. Вынесено из `/api/atlas/system-bodies`, чтобы одной и той
 * же функцией пользовались и старый режим (EDSM только при пустой базе), и
 * сверка «Архитектора».
 */
export function normalizeEdsmBody(systemName: string, b: Record<string, unknown>): BodyRow {
  const anyB = b as any;
  return {
    system_name: systemName,
    body_name: anyB.name || `${systemName} Body`,
    body_id: anyB.bodyId ?? null,
    body_type: anyB.type || (String(anyB.subType || '').toLowerCase().includes('star') ? 'Star' : 'Planet'),
    sub_type: anyB.subType || null,
    distance_ls: typeof anyB.distanceToArrival === 'number' ? anyB.distanceToArrival : 0,
    parents: Array.isArray(anyB.parents) ? anyB.parents : [],
    radius_m: typeof anyB.radius === 'number' ? anyB.radius * 1000 : (typeof anyB.solarRadius === 'number' ? anyB.solarRadius * 6.957e8 : 0),
    gravity: typeof anyB.gravity === 'number' ? anyB.gravity : 0,
    earth_masses: typeof anyB.earthMasses === 'number' ? anyB.earthMasses : (typeof anyB.solarMasses === 'number' ? anyB.solarMasses * 333000 : 0),
    surface_temp_k: typeof anyB.surfaceTemperature === 'number' ? anyB.surfaceTemperature : 0,
    surface_pressure: typeof anyB.surfacePressure === 'number' ? anyB.surfacePressure : 0,
    volcanism: anyB.volcanismType || null,
    atmosphere: anyB.atmosphereType || null,
    atmosphere_type: anyB.atmosphereType || null,
    atmosphere_composition: Array.isArray(anyB.atmosphereComposition) ? anyB.atmosphereComposition : [],
    solid_composition: anyB.solidComposition && typeof anyB.solidComposition === 'object' ? anyB.solidComposition : {},
    materials: anyB.materials && typeof anyB.materials === 'object' ? anyB.materials : {},
    rings: Array.isArray(anyB.rings) ? anyB.rings : [],
    is_landable: !!anyB.isLandable,
    // EDSM сигналы тел не отдаёт: они появляются только из журнала игрока
    // (FSSBodySignals/SAASignalsFound), поэтому здесь честные нули — сверка
    // всегда предпочтёт им сигналы из базы проекта, если они там есть.
    bio_signals_count: 0,
    geo_signals_count: 0,
    human_signals_count: 0,
    thargoid_signals_count: 0,
    guardian_signals_count: 0,
    other_signals_count: 0,
    signals: [],
    bio_genuses: [],
    first_discovered_by: anyB.discovery?.commander || null,
    first_mapped_by: null,
    first_footfall_by: null,
    scanned_by_cmdr: null,
    source: 'edsm',
    raw_data: b,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Приводит одно тело из дампа Spansh (`api/dump/{id64}` → `system.bodies[]`)
 * к форме строки `system_scans`.
 *
 * Spansh — тот же источник, из которого тянет тела Raven Colonial, и он
 * заметно богаче EDSM: отдаёт сигналы тел (`signals.signals`), признак
 * терраформирования и кольца в готовом виде. Ради этого он и добавлен в
 * сверку третьим источником.
 */
export function normalizeSpanshBody(systemName: string, b: Record<string, unknown>): BodyRow {
  const anyB = b as any;
  const signalMap: Record<string, unknown> = anyB.signals?.signals && typeof anyB.signals.signals === 'object'
    ? anyB.signals.signals
    : {};
  const genuses: string[] = Array.isArray(anyB.signals?.genuses) ? anyB.signals.genuses : [];

  // Spansh хранит сигналы словарём вида {"$SAA_SignalType_Biological;": 3}.
  const signalCount = (needle: string): number => {
    let total = 0;
    for (const [key, value] of Object.entries(signalMap)) {
      if (!key.toLowerCase().includes(needle)) continue;
      if (typeof value === 'number') total += value;
    }
    return total;
  };

  const isStar = String(anyB.type ?? '').toLowerCase() === 'star';
  const radiusM = typeof anyB.radius === 'number'
    ? anyB.radius * 1000
    : typeof anyB.solarRadius === 'number' ? anyB.solarRadius * 6.957e8 : 0;

  return {
    system_name: systemName,
    body_name: anyB.name || `${systemName} Body`,
    body_id: typeof anyB.bodyId === 'number' ? anyB.bodyId : null,
    body_type: anyB.type || (isStar ? 'Star' : 'Planet'),
    sub_type: anyB.subType || null,
    distance_ls: typeof anyB.distanceToArrival === 'number' ? anyB.distanceToArrival : 0,
    parents: Array.isArray(anyB.parents) ? anyB.parents : [],
    radius_m: radiusM,
    gravity: typeof anyB.gravity === 'number' ? anyB.gravity : 0,
    earth_masses: typeof anyB.earthMasses === 'number'
      ? anyB.earthMasses
      : typeof anyB.solarMasses === 'number' ? anyB.solarMasses * 333_000 : 0,
    surface_temp_k: typeof anyB.surfaceTemperature === 'number' ? anyB.surfaceTemperature : 0,
    surface_pressure: typeof anyB.surfacePressure === 'number' ? anyB.surfacePressure : 0,
    volcanism: anyB.volcanismType || null,
    atmosphere: anyB.atmosphereType || null,
    atmosphere_type: anyB.atmosphereType || null,
    atmosphere_composition: anyB.atmosphereComposition && typeof anyB.atmosphereComposition === 'object'
      ? anyB.atmosphereComposition
      : [],
    solid_composition: anyB.solidComposition && typeof anyB.solidComposition === 'object' ? anyB.solidComposition : {},
    materials: anyB.materials && typeof anyB.materials === 'object' ? anyB.materials : {},
    rings: Array.isArray(anyB.rings) ? anyB.rings : [],
    is_landable: !!anyB.isLandable,
    is_terraformable: anyB.terraformingState === 'Candidate for terraforming'
      || anyB.terraformingState === 'Terraformable'
      || !!anyB.isTerraformable,
    bio_signals_count: signalCount('biological'),
    geo_signals_count: signalCount('geological'),
    human_signals_count: signalCount('human'),
    thargoid_signals_count: signalCount('thargoid'),
    guardian_signals_count: signalCount('guardian'),
    other_signals_count: signalCount('other'),
    signals: Object.entries(signalMap).map(([type, count]) => ({ type, count })),
    bio_genuses: genuses,
    first_discovered_by: null,
    first_mapped_by: null,
    first_footfall_by: null,
    scanned_by_cmdr: null,
    source: 'spansh',
    raw_data: b,
    updated_at: typeof anyB.updateTime === 'string'
      ? new Date(anyB.updateTime.replace(' ', 'T') + (anyB.updateTime.endsWith('Z') ? '' : 'Z')).toISOString()
      : new Date().toISOString(),
  };
}

/** Состояние одного источника данных для панели синхронизации. */
export type SyncStatus = 'ok' | 'empty' | 'unavailable' | 'skipped';

export interface SyncSourceState {
  id: string;
  label: string;
  status: SyncStatus;
  /** Сколько строк пришло от источника. */
  count: number;
  /** Самая свежая отметка времени у строк источника, ISO или null. */
  updatedAt: string | null;
  /** Причина отказа/пропуска — коротким текстом. */
  note: string | null;
}

export interface SystemSyncReport {
  sources: SyncSourceState[];
  /** Сколько тел «Архитектор» дозаписал в базу проекта после сверки. */
  cached: number;
  /** Дубли внутри одного источника (одно тело двумя строками). */
  duplicates: Record<string, number>;
  /** Кто выиграл сверку: сколько тел от какого источника. */
  winners: { database: number; edsm: number; spansh: number; merged: number; total: number };
}

const SOURCE_LABELS: Record<string, string> = {
  database: 'База проекта',
  edsm: 'EDSM',
  spansh: 'Spansh',
  raven: 'Raven Colonial',
  progress: 'Прогресс строек',
};

const SYNC_STATUSES: SyncStatus[] = ['ok', 'empty', 'unavailable', 'skipped'];

function toSyncStatus(value: unknown): SyncStatus {
  const text = String(value ?? '').toLowerCase();
  return (SYNC_STATUSES as string[]).includes(text) ? (text as SyncStatus) : 'unavailable';
}

/**
 * Разбирает поле `sync` из ответа `/api/atlas/system-bodies?compare=1` в
 * форму, удобную панели синхронизации. Отдельная чистая функция, потому что
 * ответ приходит из сети в виде `any`, а тесты должны проверять разбор без
 * рендера компонента.
 */
export function parseSyncReport(payload: unknown): SystemSyncReport {
  const raw = (payload ?? {}) as Record<string, any>;
  const sync = (raw.sync ?? {}) as Record<string, any>;
  const stats = (raw.sources ?? {}) as Record<string, any>;

  const sources: SyncSourceState[] = ['database', 'edsm', 'spansh']
    .filter((id) => sync[id])
    .map((id) => {
      const entry = sync[id] as Record<string, any>;
      return {
        id,
        label: SOURCE_LABELS[id] ?? id,
        status: toSyncStatus(entry.status),
        count: Number.isFinite(entry.count) ? Number(entry.count) : 0,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
        note: entry.note ? String(entry.note) : null,
      };
    });

  const duplicates: Record<string, number> = {};
  const rawDuplicates = (sync.duplicates ?? {}) as Record<string, any>;
  for (const [id, count] of Object.entries(rawDuplicates)) {
    if (Number.isFinite(count) && Number(count) > 0) duplicates[id] = Number(count);
  }

  return {
    sources,
    cached: Number.isFinite(sync.cached) ? Number(sync.cached) : 0,
    duplicates,
    winners: {
      database: Number(stats.database ?? 0),
      edsm: Number(stats.edsm ?? 0),
      spansh: Number(stats.spansh ?? 0),
      merged: Number(stats.merged ?? 0),
      total: Number(stats.total ?? 0),
    },
  };
}
