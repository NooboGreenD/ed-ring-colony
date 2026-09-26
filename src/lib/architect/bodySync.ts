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

export type BodyRecordSource = 'database' | 'edsm' | 'merged';

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
  stats: { database: number; edsm: number; merged: number; total: number };
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

function bodyKey(row: BodyRow): string {
  const name = String(row.body_name ?? row.name ?? '').trim().toLowerCase();
  return name;
}

/**
 * Сверяет весь список тел системы: строит объединение по имени тела и для
 * каждого выбирает/дополняет запись через `compareBodyRecords`. Порядок
 * результата — по `distance_ls` (как раньше отдавала база), тела без
 * известного расстояния уходят в конец.
 */
export function compareSystemBodies(
  dbRows: BodyRow[],
  edsmRows: BodyRow[],
  opts: CompareOptions = {},
): CompareSummary {
  const dbByKey = new Map<string, BodyRow>();
  for (const row of dbRows) {
    const key = bodyKey(row);
    if (key) dbByKey.set(key, row);
  }
  const edsmByKey = new Map<string, BodyRow>();
  for (const row of edsmRows) {
    const key = bodyKey(row);
    if (key) edsmByKey.set(key, row);
  }

  const keys = new Set<string>([...dbByKey.keys(), ...edsmByKey.keys()]);
  const stats = { database: 0, edsm: 0, merged: 0, total: 0 };
  const bodies: BodyRow[] = [];
  const toUpsert: BodyRow[] = [];

  for (const key of keys) {
    const comparison = compareBodyRecords(dbByKey.get(key) ?? null, edsmByKey.get(key) ?? null, opts);
    if (!comparison) continue;
    stats.total += 1;
    stats[comparison.source] += 1;
    bodies.push(comparison.record);

    // В базу стоит дозаписать всё, где источник не «чистая база без изменений»:
    // сама EDSM-запись, либо запись с дополненными из EDSM полями.
    if (comparison.source !== 'database') {
      const { id, ...rest } = comparison.record as Record<string, unknown> & { id?: unknown };
      toUpsert.push({ ...rest, updated_at: new Date(opts.now ?? Date.now()).toISOString() });
    }
  }

  bodies.sort((a, b) => {
    const da = typeof a.distance_ls === 'number' ? a.distance_ls : Number.POSITIVE_INFINITY;
    const db = typeof b.distance_ls === 'number' ? b.distance_ls : Number.POSITIVE_INFINITY;
    return da - db;
  });

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
