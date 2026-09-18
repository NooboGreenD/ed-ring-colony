/**
 * Вторые «полезные ископаемые» журнала, кроме доставок.
 *
 * Uploader (Colonial Helper) из тех же строк `Journal.*.log` вытасвывает не
 * только доставки: snapshots строек (`ColonisationConstructionDepot`), сканы тел
 * (`Scan`) и сводную статистику пилота (`LoadGame`/`Rank`/`Statistics`). Сайт
 * обязан принимать тот же набор — иначе досье пилота, которое заполняет
 * браузерный загрузчик, остается «половинчатым».
 *
 * Формы объектов сознательно совпадают с payload'ом Uploader'а
 * (`uploader/journal_parser.py`, `colonial_helper._queue_scan_for_upload`),
 * чтобы серверная часть обрабатывала оба источника одним кодом.
 */

export interface ConstructionResourceRow {
  Name?: string;
  Name_Localised?: string;
  RequiredAmount?: number;
  ProvidedAmount?: number;
  Payment?: number;
}

/** snapshot стройплощадки — то же, что отправляет `ConstructionSnapshotCollector`. */
export interface ConstructionSnapshotEvent {
  timestamp: string;
  system_name: string;
  market_id: string | null;
  construction_name: string | null;
  construction_id: string | null;
  construction_progress: number | null;
  resources_total: ConstructionResourceRow[];
  raw_event: Record<string, unknown>;
}

export interface SystemScanRow {
  system_name: string;
  body_name: string;
  body_id: number | null;
  /** «Star» / «Planet» — по типу события, т.к. журнал не пишет body_type. */
  body_type: string | null;
  sub_type: string | null;
  distance_ls: number | null;
  /** Большая полуось в световых секундах (SemiMajorAxis в Scan). */
  semi_major_axis_ls: number | null;
  radius_m: number | null;
  gravity: number | null;
  earth_masses: number | null;
  surface_pressure: number | null;
  volcanism: string | null;
  atmosphere_composition: unknown[];
  surface_temp_k: number | null;
  atmosphere: string | null;
  is_landable: boolean;
  parents: unknown[];
  rings: unknown[];
  bio_signals_count: number;
  bio_genuses: string[];
  first_discovered_by: string | null;
  first_mapped_by: string | null;
}

export interface PilotStats {
  credits?: number;
  mercenary_rank?: number;
  exobiologist_rank?: number;
  first_discoveries_count?: number;
  first_mapped_count?: number;
  first_footfalls_count?: number;
  bio_samples_count?: number;
  bio_species_count?: number;
  bio_value_cr?: number;
  mercenary_coins?: number;
}

export interface JournalTelemetryStats {
  eventsParsed: number;
  constructionSnapshots: number;
  constructionDuplicates: number;
  scans: number;
  bioSignals: number;
}

export interface JournalTelemetry {
  cmdrName: string | null;
  currentSystem: string | null;
  constructionEvents: ConstructionSnapshotEvent[];
  scans: SystemScanRow[];
  pilotStats: PilotStats;
  stats: JournalTelemetryStats;
}

export interface TelemetryState {
  cmdrName: string | null;
  currentSystem: string | null;
  /**
   * Подписи всех принятых snapshot'ов стройки — дубли журнала режут шум.
   * Именно множество, а не «последняя подпись»: игрок возит ресурсы между
   * несколькими площадками, и журнал пишет их вперемешку (A,B,A,B). Сравнение
   * только с предыдущим snapshot'ом пропускало каждый второй как «новый».
   */
  constructionSignatures: Set<string>;
  /** Один scan на тело за разбор: журнал пишет `Scan` по нескольку раз. */
  scanByKey: Map<string, SystemScanRow>;
  pilotStats: PilotStats;
  seenOrganicSpecies: Set<string>;
  seenSamples: Set<string>;
  stats: JournalTelemetryStats;
}

export function createTelemetryState(): TelemetryState {
  return {
    cmdrName: null,
    currentSystem: null,
    constructionSignatures: new Set(),
    scanByKey: new Map(),
    pilotStats: {},
    seenOrganicSpecies: new Set(),
    seenSamples: new Set(),
    stats: { eventsParsed: 0, constructionSnapshots: 0, constructionDuplicates: 0, scans: 0, bioSignals: 0 },
  };
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 64-битные ID вытаскиваем из строки до JSON.parse — иначе Float64 их округлит. */
function rawInteger(line: string, field: string): string | null {
  const marker = `"${field}"`;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const match = line.slice(start + marker.length).match(/^\s*:\s*(?:"(-?\d+)"|(-?\d+))/);
  const value = match?.[1] ?? match?.[2];
  return value && /^-?\d+$/.test(value) ? value : null;
}

function constructionSignature(event: ConstructionSnapshotEvent): string {
  const resources = (event.resources_total ?? [])
    .map((row) => `${str(row.Name)}:${row.ProvidedAmount ?? 0}/${row.RequiredAmount ?? 0}`)
    .join('|');
  return [
    event.system_name, event.market_id ?? '', event.construction_id ?? '',
    event.construction_name ?? '', event.construction_progress ?? '', resources,
  ].join('\u0000');
}

/**
 * Коллектор телеметрии: одно прохождение по событиям — все разделы.
 *
 * Разбор журнала дорог (сотни файлов истории), поэтому `parseJournal` на сайте
 * скарывает collector'у события тем же циклом, которым считает доставки, —
 * второго прохода по тексту нет.
 */
export class TelemetryCollector {
  private readonly state: TelemetryState;
  private readonly constructionEvents: ConstructionSnapshotEvent[] = [];

  constructor(state: TelemetryState = createTelemetryState()) {
    this.state = state;
  }

  get currentSystem(): string | null {
    return this.state.currentSystem;
  }

  /** Один журнал: одна строка → одно событие. Исключения глотаем: карта не должна ронять импорт. */
  feed(line: string, event: Record<string, unknown>): void {
    try {
      this.handle(line, event);
    } catch {
      // событие с необычным наполнением — просто пропускаем
    }
  }

  private handle(line: string, event: Record<string, unknown>): void {
    const state = this.state;
    state.stats.eventsParsed += 1;
    const name = typeof event.event === 'string' ? event.event : '';

    if (name === 'Commander' && str(event.Name)) {
      state.cmdrName = str(event.Name);
      return;
    }
    if (name === 'LoadGame') {
      if (!state.cmdrName && str(event.Commander)) state.cmdrName = str(event.Commander);
      const credits = num(event.Credits);
      if (credits != null) state.pilotStats.credits = credits;
      if (str(event.StarSystem)) state.currentSystem = str(event.StarSystem);
      return;
    }
    if (name === 'Location' || name === 'FSDJump' || name === 'Docked' || name === 'CarrierJump') {
      if (str(event.StarSystem)) state.currentSystem = str(event.StarSystem);
      return;
    }

    if (name === 'ColonisationConstructionDepot') {
      const system = str(event.StarSystem) || state.currentSystem || '';
      if (!system) return;
      const resources = Array.isArray(event.ResourcesRequired)
        ? (event.ResourcesRequired as ConstructionResourceRow[])
        : [];
      const snapshot: ConstructionSnapshotEvent = {
        timestamp: str(event.timestamp),
        system_name: system,
        market_id: rawInteger(line, 'MarketID'),
        construction_name: str(event.ConstructionName) || str(event.Name) || null,
        construction_id: rawInteger(line, 'ConstructionID'),
        construction_progress: num(event.ConstructionProgress ?? event.Progress),
        resources_total: resources,
        raw_event: event,
      };
      // Журнал пишет это событие каждые несколько секунд, пока игрок стоит у
      // площадки: в наборе остаётся только реально изменившееся состояние.
      const signature = constructionSignature(snapshot);
      if (state.constructionSignatures.has(signature)) {
        state.stats.constructionDuplicates += 1;
        return;
      }
      state.constructionSignatures.add(signature);
      state.stats.constructionSnapshots += 1;
      this.constructionEvents.push(snapshot);
      return;
    }

    if (name === 'Scan') {
      const system = str(event.StarSystem) || state.currentSystem || '';
      const bodyName = str(event.BodyName) || str(event.Body);
      if (!system || !bodyName) return;
      const key = scanKey(system, bodyName);
      const previous = state.scanByKey.get(key);
      if (!previous) state.stats.scans += 1;
      state.scanByKey.set(key, {
        system_name: system,
        body_name: bodyName,
        body_id: num(event.BodyID),
        body_type: event.StarType ? 'Star' : 'Planet',
        sub_type: str(event.PlanetClass) || str(event.StarType) || null,
        distance_ls: num(event.DistanceFromArrivalLS),
        semi_major_axis_ls: num(event.SemiMajorAxis),
        radius_m: num(event.Radius),
        gravity: num(event.SurfaceGravity),
        earth_masses: num(event.EarthMasses),
        surface_pressure: num(event.Pressure),
        volcanism: volcanismName(event.Volcanism),
        atmosphere_composition: Array.isArray(event.AtmosphereComposition)
          ? (event.AtmosphereComposition as unknown[])
          : [],
        surface_temp_k: num(event.SurfaceTemperature),
        atmosphere: str(event.Atmosphere) || str(event.AtmosphereType) || null,
        is_landable: Boolean(event.Landable),
        parents: Array.isArray(event.Parents) ? (event.Parents as unknown[]) : [],
        rings: Array.isArray(event.Rings) ? (event.Rings as unknown[]) : [],
        bio_signals_count: previous?.bio_signals_count ?? 0,
        bio_genuses: previous?.bio_genuses ?? [],
        // «WasDiscovered: false» — тело открыто впервые, то есть нами.
        first_discovered_by: event.WasDiscovered === false ? 'Вы' : (previous?.first_discovered_by ?? null),
        first_mapped_by: event.WasMapped === false ? 'Вы' : (previous?.first_mapped_by ?? null),
      });
      return;
    }

    if (name === 'FSSBodySignals' || name === 'SAASignalsFound') {
      const system = str(event.StarSystem) || state.currentSystem || '';
      const bodyName = str(event.BodyName) || str(event.Body);
      if (!system || !bodyName) return;
      const signals = Array.isArray(event.Signals) ? (event.Signals as Record<string, unknown>[]) : [];
      let bio = 0;
      for (const signal of signals) {
        const type = `${str(signal.Type)} ${str(signal.Type_Localised)}`.toLowerCase();
        if (type.includes('biological') || type.includes('biolog') || type.includes('биолог')) {
          bio += num(signal.Count) ?? 0;
        }
      }
      const genuses = Array.isArray(event.Genuses) ? (event.Genuses as Record<string, unknown>[]) : [];
      const generaList = genuses
        .map((genus) => str(genus.Genus_Localised) || str(genus.Genus))
        .filter(Boolean);
      const key = scanKey(system, bodyName);
      const previous = state.scanByKey.get(key);
      state.stats.bioSignals += bio;
      state.scanByKey.set(key, {
        ...(previous ?? emptyScanRow(system, bodyName, num(event.BodyID))),
        bio_signals_count: Math.max(previous?.bio_signals_count ?? 0, bio),
        bio_genuses: Array.from(new Set([...(previous?.bio_genuses ?? []), ...generaList])),
      });
      return;
    }

    if (name === 'SAAScanComplete') {
      const system = str(event.StarSystem) || state.currentSystem || '';
      const bodyName = str(event.BodyName) || str(event.Body);
      if (!system || !bodyName) return;
      const key = scanKey(system, bodyName);
      const previous = state.scanByKey.get(key);
      if (previous) {
        state.scanByKey.set(key, { ...previous, first_mapped_by: previous.first_mapped_by || 'Вы' });
      } else {
        state.stats.scans += 1;
        state.scanByKey.set(key, { ...emptyScanRow(system, bodyName, num(event.BodyID)), first_mapped_by: 'Вы' });
      }
      return;
    }

    if (name === 'Rank') {
      const soldier = num(event.Soldier);
      if (soldier != null) state.pilotStats.mercenary_rank = soldier;
      const exobiologist = num(event.Exobiologist);
      if (exobiologist != null) state.pilotStats.exobiologist_rank = exobiologist;
      return;
    }

    if (name === 'Statistics') {
      const bank = (event.Bank_Account ?? {}) as Record<string, unknown>;
      const exploration = (event.Exploration ?? {}) as Record<string, unknown>;
      const exo = (event.Exobiology ?? {}) as Record<string, unknown>;
      const combat = (event.Combat ?? {}) as Record<string, unknown>;
      // Имена полей `Statistics` менялись между патчами игры (и у EDMC есть
      // свои синонимы), поэтому для каждого счётчика — список кандидатов.
      const assign = (target: keyof PilotStats, source: Record<string, unknown>, keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          const value = num(source[key]);
          if (value != null) {
            state.pilotStats[target] = value;
            return;
          }
        }
      };
      assign('credits', bank, ['Current_Wealth', 'General_funds']);
      assign('first_discoveries_count', exploration, ['Planets_Scanned_To_Level_2', 'First_Discoveries']);
      assign('first_mapped_count', exploration, ['Planets_Scanned_To_Level_3', 'Pr_Scanned_To_Level_3']);
      assign('first_footfalls_count', exploration, 'First_Footfalls');
      assign('bio_samples_count', exo, ['Organic_Data_Count', 'Organic_Data_Collected']);
      assign('bio_species_count', exo, ['Organic_Species_Encountered', 'Total_Species_Encountered']);
      assign('bio_value_cr', exo, ['Organic_Data_Profits', 'Total_Profits']);
      assign('mercenary_coins', combat, ['Combat_Bond_Profits', 'Bonds_Performance']);
      return;
    }

    if (name === 'ScanOrganic') {
      // Счётчики образцов: `Statistics` приходит не всегда, а «вид встретился»
      // видно по каждому событию генетического сэмплера.
      const species = str(event.Species_Localised) || str(event.Species);
      if (!species) return;
      const stage = str(event.ScanType) || str(event.Type);
      const dedupeKey = `${species.toLowerCase()}\u0000${stage.toLowerCase()}\u0000${str(event.timestamp)}`;
      if (state.seenSamples.has(dedupeKey)) return;
      state.seenSamples.add(dedupeKey);
      state.seenOrganicSpecies.add(species.toLowerCase());
      if (stage.toLowerCase() === 'sample') {
        state.pilotStats.bio_samples_count = (state.pilotStats.bio_samples_count ?? 0) + 1;
      }
      state.pilotStats.bio_species_count = Math.max(
        state.pilotStats.bio_species_count ?? 0,
        state.seenOrganicSpecies.size,
      );
    }
  }

  finish(): JournalTelemetry {
    return {
      cmdrName: this.state.cmdrName,
      currentSystem: this.state.currentSystem,
      constructionEvents: this.constructionEvents,
      scans: Array.from(this.state.scanByKey.values()),
      pilotStats: this.state.pilotStats,
      stats: this.state.stats,
    };
  }
}

/** Журнал отдаёт Volcanism как объект {Type, ...} — в БД храним имя типа. */
function volcanismName(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = str(record.Type) || str(record.type) || str(record.VolcanismType);
    if (name) return name;
    // «MajorMoflows» — опечатка Frontier в журнале, но именно так поле и
    // приходит; гейзеры у звёзд лежат в Major/MinorGeysers.
    const flows = record.MajorMoflows ?? record.MinorMoflows ?? record.MajorMinflows;
    if (Array.isArray(flows) && flows.length > 0) return 'Magma Flows';
    const geysers = record.MajorGeysers ?? record.MinorGeysers;
    if (Array.isArray(geysers) && geysers.length > 0) return 'Geysers';
  }
  return null;
}

function scanKey(system: string, body: string): string {
  return `${system.toLowerCase()}\u0000${body.toLowerCase()}`;
}

function emptyScanRow(system: string, bodyName: string, bodyId: number | null): SystemScanRow {
  return {
    system_name: system,
    body_name: bodyName,
    body_id: bodyId,
    body_type: null,
    sub_type: null,
    distance_ls: null,
    semi_major_axis_ls: null,
    radius_m: null,
    gravity: null,
    earth_masses: null,
    surface_pressure: null,
    volcanism: null,
    atmosphere_composition: [],
    surface_temp_k: null,
    atmosphere: null,
    is_landable: false,
    parents: [],
    rings: [],
    bio_signals_count: 0,
    bio_genuses: [],
    first_discovered_by: null,
    first_mapped_by: null,
  };
}

/**
 * Разобрать один текст журнала целиком. Состояние передаётся между файлами:
 * snapshot стройки и скан тела часто переходят через границу ротации
 * `Journal.*.log`.
 */
export function parseJournalTelemetry(
  text: string,
  state: TelemetryState = createTelemetryState(),
): JournalTelemetry {
  const collector = new TelemetryCollector(state);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== '{') continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    collector.feed(line, event);
  }
  return collector.finish();
}

/* ─────────────────────────── серверная часть ─────────────────────────── */

export interface JournalTelemetryPayload {
  constructionEvents?: unknown;
  systemScans?: unknown;
  scans?: unknown;
  pilotStats?: unknown;
}

export interface JournalTelemetryOutcome {
  constructionInserted: number;
  snapshotInserted: number;
  /** Сколько снимков не записано, потому что они уже есть в базе. */
  snapshotDuplicates: number;
  systemScansInserted: number;
  pilotStatsUpdated: boolean;
  warnings: string[];
}

type DbClient = {
  from: (table: string) => any;
};

const CONSTRUCTION_BATCH = 100;
const SCAN_BATCH = 200;

/**
 * Postgres отменил statement по `statement_timeout` (SQLSTATE 57014).
 *
 * Supabase обрывает запросы PostgREST через несколько секунд. Пачка сканов
 * несёт тяжёлый JSON (`atmosphere_composition`, `parents`, `rings`), поэтому
 * именно она чаще всего не успевает. Сбой временный: тот же объём меньшей
 * пачкой проходит.
 */
function isStatementTimeout(error: { code?: string; message?: string }): boolean {
  if (error.code === '57014') return true;
  return /canceling statement due to statement timeout|statement timeout/i.test(error.message || '');
}

/**
 * Записать пачку, при таймауте деля её пополам.
 *
 * Без этого одна не успевшая пачка в 200 сканов терялась целиком: ошибка
 * попадала в `warnings`, и карта с «первооткрытиями» оставалась пустой, хотя
 * загрузка журнала считалась успешной.
 */
async function upsertWithinStatementTimeout(
  svc: DbClient,
  table: 'system_scans' | 'colonisation_events',
  rows: Array<Record<string, unknown>>,
  onConflict: string,
  ignoreDuplicates: boolean,
): Promise<number> {
  try {
    const { error } = await svc.from(table).upsert(rows, { onConflict, ignoreDuplicates });
    if (error) throw error as { code?: string; message?: string };
    return rows.length;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    if (!isStatementTimeout(failure) || rows.length <= 1) throw failure;
    const middle = Math.floor(rows.length / 2);
    const left = await upsertWithinStatementTimeout(
      svc, table, rows.slice(0, middle), onConflict, ignoreDuplicates);
    const right = await upsertWithinStatementTimeout(
      svc, table, rows.slice(middle), onConflict, ignoreDuplicates);
    return left + right;
  }
}

function batches<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

function progressPercent(event: Record<string, unknown>): number | null {
  const complete = event.ConstructionComplete === true || event.construction_complete === true;
  if (complete) return 100;
  const raw = Number(event.construction_progress ?? event.ConstructionProgress ?? event.Progress);
  if (!Number.isFinite(raw) || raw < 0) return null;
  // Журнал пишет 0.2224, старые интеграции — уже 22.24.
  return Math.min(100, raw <= 1 ? raw * 100 : raw);
}

/**
 * Сохранить «остальное» из журнала: snapshots строек, сканы тел и сводную
 * статистику пилота.
 *
 * Один и тот же код обслуживает и браузерный загрузчик (`/api/logs/import`,
 * сессия Supabase), и Colonial Helper (`/api/logs/upload`, API-токен) — данные
 * у них идентичны, поэтому и запись должна быть одной и той же, а не двумя
 * версиями «на одно и то же». Ошибки сети/БД не должны ронять загрузку
 * доставок: они собираются в `warnings`.
 */
export async function persistJournalTelemetry(
  svc: DbClient,
  userId: string,
  payload: JournalTelemetryPayload,
  cmdrName?: string | null,
): Promise<JournalTelemetryOutcome> {
  const warnings: string[] = [];
  const outcome: JournalTelemetryOutcome = {
    constructionInserted: 0,
    snapshotInserted: 0,
    snapshotDuplicates: 0,
    systemScansInserted: 0,
    pilotStatsUpdated: false,
    warnings,
  };

  const events = (Array.isArray(payload.constructionEvents) ? payload.constructionEvents : [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');

  if (events.length > 0) {
    const rows = events
      .map((event) => {
        const timestamp = typeof event.timestamp === 'string' && event.timestamp ? event.timestamp : new Date().toISOString();
        const systemName = String(event.system_name ?? event.systemName ?? '').trim().slice(0, 250);
        if (!systemName) return null;
        return {
          user_id: userId,
          event_timestamp: timestamp,
          system_name: systemName,
          market_id: event.market_id == null ? null : String(event.market_id),
          construction_name: event.construction_name == null ? null : String(event.construction_name).slice(0, 500),
          construction_id: event.construction_id == null ? null : String(event.construction_id),
          construction_progress: progressPercent(event),
          resources_total: Array.isArray(event.resources_total) ? event.resources_total : [],
          raw_event: event.raw_event && typeof event.raw_event === 'object' ? event.raw_event : event,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    for (const batch of batches(rows, CONSTRUCTION_BATCH)) {
      try {
        const { error } = await svc.from('colonisation_events').upsert(batch, {
          onConflict: 'user_id,event_timestamp,system_name,construction_id',
          ignoreDuplicates: true,
        });
        if (error) throw new Error(error.message);
        outcome.constructionInserted += batch.length;
      } catch (error) {
        warnings.push(`construction events: ${(error as Error).message}`);
      }
    }

    // Отдельный снимок состояния стройки — источник прогресса для карты и
    // страницы системы. Держим по одному на конструкцию в этом запросе.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.system_name.toLowerCase()}\u0000${row.construction_id ?? row.construction_name ?? ''}`;
      const previous = latest.get(key);
      if (!previous || Date.parse(String(row.event_timestamp)) > Date.parse(String(previous.event_timestamp))) {
        latest.set(key, row);
      }
    }
    const snapshots = Array.from(latest.values()).map((row) => ({
      system_name: row.system_name,
      construction_id: row.construction_id,
      construction_name: row.construction_name,
      progress: row.construction_progress,
      resources_total: row.resources_total,
      snapshot_at: row.event_timestamp,
      source: 'journal',
    }));
    // Повторный импорт того же журнала не должен удваивать историю.
    // Уникального ограничения в схеме нет (только `id SERIAL PRIMARY KEY`),
    // поэтому сверяемся с уже записанными снимками сами: ключ — конструкция и
    // момент снимка. Один SELECT на запрос дешевле, чем тысячи лишних строк,
    // которые потом приходится разгребать графикам прогресса.
    const snapshotKey = (id: unknown, name: unknown, at: unknown): string => {
      const parsed = Date.parse(String(at ?? ''));
      const stamp = Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(at ?? '');
      return `${id ?? name ?? ''}\u0000${stamp}`;
    };

    let freshSnapshots = snapshots;
    if (snapshots.length > 0) {
      const systemNames = Array.from(new Set(snapshots.map((row) => row.system_name)));
      const constructionIds = Array.from(
        new Set(snapshots.map((row) => row.construction_id).filter((id) => id != null)),
      );
      try {
        let query = svc
          .from('construction_depot_snapshots')
          .select('construction_id, construction_name, snapshot_at')
          .in('system_name', systemNames);
        if (constructionIds.length > 0) query = query.in('construction_id', constructionIds);
        const { data: existing, error } = await query;
        if (error) throw new Error(error.message);
        const seen = new Set(
          (existing ?? []).map((row: Record<string, unknown>) =>
            snapshotKey(row.construction_id, row.construction_name, row.snapshot_at)),
        );
        freshSnapshots = snapshots.filter(
          (row) => !seen.has(snapshotKey(row.construction_id, row.construction_name, row.snapshot_at)),
        );
        outcome.snapshotDuplicates += snapshots.length - freshSnapshots.length;
      } catch (error) {
        // Сверка не удалась — пишем как раньше: лучше возможный повтор, чем
        // потерянный снимок прогресса.
        warnings.push(`depot snapshot dedup: ${(error as Error).message}`);
      }
    }

    for (const batch of batches(freshSnapshots, CONSTRUCTION_BATCH)) {
      try {
        const { error } = await svc.from('construction_depot_snapshots').insert(batch);
        if (error) throw new Error(error.message);
        outcome.snapshotInserted += batch.length;
      } catch (error) {
        warnings.push(`depot snapshots: ${(error as Error).message}`);
      }
    }
  }

  const scans = (Array.isArray(payload.systemScans) ? payload.systemScans : (Array.isArray(payload.scans) ? payload.scans : []))
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  if (scans.length > 0) {
    const rows = scans
      .map((scan) => {
        const systemName = String(scan.system_name ?? scan.system ?? '').trim().slice(0, 250);
        const bodyName = String(scan.body_name ?? scan.name ?? '').trim().slice(0, 250);
        if (!systemName || !bodyName) return null;
        const number = (value: unknown): number | null => {
          const parsed = typeof value === 'number' ? value : Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        return {
          system_name: systemName,
          body_name: bodyName,
          body_id: number(scan.body_id),
          body_type: scan.body_type ? String(scan.body_type).slice(0, 60) : null,
          sub_type: scan.sub_type ? String(scan.sub_type).slice(0, 120) : null,
          distance_ls: number(scan.distance_ls) ?? 0,
          semi_major_axis_ls: number(scan.semi_major_axis_ls) ?? 0,
          radius_m: number(scan.radius_m) ?? 0,
          gravity: number(scan.gravity) ?? 0,
          earth_masses: number(scan.earth_masses) ?? 0,
          surface_pressure: number(scan.surface_pressure) ?? 0,
          volcanism: scan.volcanism ? String(scan.volcanism).slice(0, 120) : null,
          atmosphere_composition: Array.isArray(scan.atmosphere_composition) ? scan.atmosphere_composition : [],
          surface_temp_k: number(scan.surface_temp_k) ?? 0,
          atmosphere: scan.atmosphere ? String(scan.atmosphere).slice(0, 160) : null,
          atmosphere_type: scan.atmosphere_type ? String(scan.atmosphere_type).slice(0, 160) : null,
          is_landable: Boolean(scan.is_landable ?? scan.landable),
          parents: Array.isArray(scan.parents) ? scan.parents : [],
          rings: Array.isArray(scan.rings) ? scan.rings : [],
          bio_signals_count: number(scan.bio_signals_count) ?? 0,
          bio_genuses: Array.isArray(scan.bio_genuses) ? scan.bio_genuses : [],
          first_discovered_by: scan.first_discovered_by ? String(scan.first_discovered_by).slice(0, 250) : null,
          first_mapped_by: scan.first_mapped_by ? String(scan.first_mapped_by).slice(0, 250) : null,
          scanned_by_cmdr: cmdrName || null,
          user_id: userId,
          source: 'journal',
          updated_at: new Date().toISOString(),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    for (const batch of batches(rows, SCAN_BATCH)) {
      try {
        outcome.systemScansInserted += await upsertWithinStatementTimeout(
          svc, 'system_scans', batch as Array<Record<string, unknown>>, 'system_name,body_name', false);
      } catch (error) {
        warnings.push(`system scans: ${(error as Error).message}`);
      }
    }
  }

  const stats = payload.pilotStats;
  if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
    const source = stats as Record<string, unknown>;
    const row: Record<string, unknown> = {
      user_id: userId,
      cmdr_name: cmdrName || null,
      last_updated: new Date().toISOString(),
    };
    const numericKeys = [
      'credits', 'arx', 'mercenary_coins', 'mercenary_rank', 'exobiologist_rank',
      'first_discoveries_count', 'first_mapped_count', 'first_footfalls_count',
      'bio_samples_count', 'bio_species_count', 'bio_value_cr',
    ] as const;
    for (const key of numericKeys) {
      const value = typeof source[key] === 'number' ? source[key] : Number(source[key]);
      if (Number.isFinite(value as number)) row[key] = Math.max(0, Math.trunc(value as number));
    }
    if (source.exploration_stats && typeof source.exploration_stats === 'object') {
      row.exploration_stats = source.exploration_stats;
    }
    if (Object.keys(row).length > 3) {
      try {
        await svc.from('pilot_stats').upsert(row, { onConflict: 'user_id' });
        outcome.pilotStatsUpdated = true;
      } catch (error) {
        warnings.push(`pilot stats: ${(error as Error).message}`);
      }
    }
  }

  return outcome;
}
