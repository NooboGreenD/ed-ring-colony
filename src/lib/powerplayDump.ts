/**
 * Разбор ночного дампа EDSM `powerPlay.json.gz` (https://www.edsm.net/en/nightly-dumps).
 *
 * Формат: JSON-массив, по одной ЗАПИСИ на строку —
 *   [
 *    {"power":"Edmund Mahon","powerState":"Exploited","id":12031,"id64":58141509045160,
 *     "name":"Wadjabangai","coords":{"x":-24.53125,"y":-33.78125,"z":108.8125},
 *     "allegiance":"Independent","government":"Communism","state":"None",
 *     "date":"2026-09-17 01:49:46"},
 *    …
 *   ]
 *
 * ГЛАВНОЕ: запись — это не «система и её держава», а «система и одна из
 * держав в ней». EDSM (EDSM-NET/EDDN-Events, `System/PowerPlay.php`) берёт из
 * события журнала массив `Powers` — все державы, чьи зоны влияния накрывают
 * систему, — и пишет по строке на каждую, с одним и тем же `PowerplayState`
 * и датой события. Поле `ControllingPower` (владелец) EDSM не хранит вовсе.
 * Дамп (`Process/Dump/PowerPlay.php`) выгружает эту таблицу, отсортировав по
 * номеру державы в EDSM, затем по дате.
 *
 * До web 2.23.0 разбор оставлял у системы одну запись: свежую, а при равных
 * датах — последнюю в файле. Даты у записей одной системы всегда равны, и
 * система доставалась державе с самым большим номером в EDSM: Nakato Kaine
 * (13) забирала всё пограничье, Aisling Duval (3) и Edmund Mahon (1) его
 * теряли. Отсюда «Nakato 3144 системы против 1819 в игре».
 *
 * Теперь записи одной системы собираются в одну строку со списком держав:
 *   * держава в списке одна — она и владелец (`power`);
 *   * держав несколько — владелец среди них, но дамп не знает какой:
 *     `power = null`, список — в `powers`. Владельца скажут журналы пилотов
 *     или EDDN (`ControllingPower`), а база сохранит его и для следующих
 *     дампов, пока он остаётся в списке (`powerplay_apply_batch`).
 *
 * Что отбрасывается:
 *   * `Unoccupied` — системой никто не управляет (у неё EDSM перечисляет
 *     претендентов на захват);
 *   * неизвестные состояния (наследие PowerPlay 1.0 и т. п.);
 *   * записи без имени, координат или id64;
 *   * запись системы с другой датой, чем у остальных её записей: осталась от
 *     более старого события — побеждает свежее.
 *
 * В дампе только системы, чьи данные PowerPlay обновлялись за последние
 * ~30 дней (EDSM получает их из журналов пилотов через EDDN), поэтому полный
 * набор пересобирается каждую ночь, а не дописывается.
 *
 * id64 читается из текста строки, а не из `JSON.parse`: адрес системы бывает
 * шире 2^53 и в number терял бы младшие разряды.
 */

import { normalizePowerName, normalizePowerplayState, type PowerplayState } from './powerplay.ts';

/**
 * Версия разбора. Хранится в `powerplay_sync_state.stats.parser`: импорт,
 * записанный старым разбором, считается устаревшим, и следующая загрузка
 * идёт без условного запроса (ETag), даже если EDSM не менял файл.
 */
export const POWERPLAY_PARSER_VERSION = 2;

/** Одна запись дампа: система и ОДНА из держав в ней. */
export interface PowerplayDumpRecord {
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  power: string;
  state: PowerplayState;
  allegiance: string | null;
  government: string | null;
  /** Когда EDSM видел систему в этом состоянии (ISO, UTC). */
  observedAt: string | null;
}

/** Система после сборки записей. */
export interface PowerplayDumpRow {
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Владелец, если EDSM перечислил у системы ровно одну державу; иначе null. */
  power: string | null;
  /** Все державы, которые EDSM перечислил у системы, по алфавиту. */
  powers: string[];
  state: PowerplayState;
  allegiance: string | null;
  government: string | null;
  observedAt: string | null;
}

/**
 * `duplicate` — та же держава у той же системы второй раз (в настоящем дампе
 * не встречается); `stale` — запись системы от более старого события.
 */
export type PowerplaySkipReason = 'unoccupied' | 'unknown_state' | 'invalid' | 'duplicate' | 'stale';

export interface PowerplayDumpStats {
  /** Версия разбора (`POWERPLAY_PARSER_VERSION`). */
  parser: number;
  /** Записей в дампе (включая отброшенные). */
  records: number;
  /** Систем под контролем после сборки записей. */
  kept: number;
  /** Из них держава в списке одна — владелец известен. */
  sole: number;
  /** Из них держав несколько — владелец по дампу не определён. */
  contested: number;
  /** Записей «ещё одна держава той же системы» (раньше считались повторами). */
  listings: number;
  skipped: Record<PowerplaySkipReason, number>;
  states: Record<PowerplayState, number>;
  /** Системы, где держава — единственная, то есть точно владелец. */
  powers: Record<string, number>;
  /** Системы, где держава присутствует (владелец или сосед). */
  presence: Record<string, number>;
  oldestObservation: string | null;
  newestObservation: string | null;
}

export interface PowerplayDumpResult {
  rows: PowerplayDumpRow[];
  stats: PowerplayDumpStats;
}

const MAX_ID64 = BigInt('9223372036854775807');
const COORD_LIMIT = 100_000;
const ID64_IN_LINE = /"id64"\s*:\s*"?(\d{1,20})"?/;
const EDSM_DATE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) return null;
  return text;
}

function coordinate(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= COORD_LIMIT ? n : null;
}

function id64From(raw: unknown, line: string | null): string | null {
  let digits: string | null = null;
  const fromLine = line ? ID64_IN_LINE.exec(line) : null;
  if (fromLine) digits = fromLine[1];
  else if (typeof raw === 'string' && /^\d{1,20}$/.test(raw.trim())) digits = raw.trim();
  else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) digits = String(raw);
  if (!digits) return null;
  const value = BigInt(digits);
  if (value <= BigInt(0) || value > MAX_ID64) return null;
  return value.toString(10);
}

/** «2026-09-17 01:49:46» (UTC в дампах EDSM) или ISO → ISO-строка UTC. */
export function edsmDateToIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = EDSM_DATE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${zone ? (zone === 'Z' ? 'Z' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone) : 'Z'}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Одна запись дампа (система + одна из держав в ней) или причина, по которой её нет. */
export function edsmRecordToRow(
  record: unknown,
  line: string | null = null,
): { row: PowerplayDumpRecord } | { skip: PowerplaySkipReason } {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { skip: 'invalid' };
  const item = record as Record<string, unknown>;
  const rawState = typeof item.powerState === 'string' ? item.powerState.trim().toLowerCase() : '';
  const state = normalizePowerplayState(item.powerState);
  if (!state) return { skip: rawState === 'unoccupied' ? 'unoccupied' : rawState ? 'unknown_state' : 'invalid' };

  const name = cleanText(item.name, 120);
  const power = normalizePowerName(item.power);
  const coords = (item.coords && typeof item.coords === 'object' ? item.coords : {}) as Record<string, unknown>;
  const x = coordinate(coords.x);
  const y = coordinate(coords.y);
  const z = coordinate(coords.z);
  const id64 = id64From(item.id64, line);
  if (!name || !power || x == null || y == null || z == null || !id64) return { skip: 'invalid' };

  return {
    row: {
      id64,
      name,
      x,
      y,
      z,
      power,
      state,
      allegiance: cleanText(item.allegiance, 40),
      government: cleanText(item.government, 40),
      observedAt: edsmDateToIso(item.date),
    },
  };
}

function emptyStats(): PowerplayDumpStats {
  return {
    parser: POWERPLAY_PARSER_VERSION,
    records: 0,
    kept: 0,
    sole: 0,
    contested: 0,
    listings: 0,
    skipped: { unoccupied: 0, unknown_state: 0, invalid: 0, duplicate: 0, stale: 0 },
    states: { Stronghold: 0, Fortified: 0, Exploited: 0 },
    powers: {},
    presence: {},
    oldestObservation: null,
    newestObservation: null,
  };
}

function observedMs(row: { observedAt: string | null }): number {
  const ms = row.observedAt ? Date.parse(row.observedAt) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** Записи дампа: построчно, а если файл не построчный — целиком как JSON-массив. */
function records(text: string): Array<{ record: unknown; line: string | null }> | null {
  const out: Array<{ record: unknown; line: string | null }> = [];
  let broken = 0;
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    // Скобки массива стоят на первой/последней строке — отдельно или вплотную к записи.
    if (line.startsWith('[')) line = line.slice(1).trim();
    if (line.endsWith(']')) line = line.slice(0, -1).trim();
    if (line.endsWith(',')) line = line.slice(0, -1).trim();
    if (!line) continue;
    if (!line.startsWith('{')) {
      broken += 1;
      continue;
    }
    try {
      out.push({ record: JSON.parse(line), line });
    } catch {
      broken += 1;
      out.push({ record: null, line: null });
    }
  }
  if (out.length > 0 && broken < out.length) return out;
  // Не построчный JSON (весь массив в одной строке и т. п.).
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    // Без исходной строки id64 берётся из числа — допустимо только в пределах 2^53.
    return parsed.map((record) => ({ record, line: null }));
  } catch {
    return out.length > 0 ? out : null;
  }
}

interface SystemGroup {
  first: PowerplayDumpRecord;
  observed: number;
  powers: Set<string>;
}

/**
 * Весь дамп → системы под контролем держав (по одной строке на систему, со
 * списком держав в ней) и статистика отбора. Бросает ошибку, если текст
 * вообще не похож на дамп (тогда таблицу трогать нельзя).
 */
export function parseEdsmPowerplayDump(text: string): PowerplayDumpResult {
  // Дамп — всегда массив; объект с ошибкой или HTML-страница прокси — не дамп.
  const items = text.trimStart().startsWith('[') ? records(text) : null;
  if (!items) throw new Error('Дамп PowerPlay не похож на JSON-массив систем');

  const stats = emptyStats();
  const groups = new Map<string, SystemGroup>();
  for (const { record, line } of items) {
    stats.records += 1;
    const result = edsmRecordToRow(record, line);
    if ('skip' in result) {
      stats.skipped[result.skip] += 1;
      continue;
    }
    const row = result.row;
    const observed = observedMs(row);
    const group = groups.get(row.id64);
    if (!group) {
      groups.set(row.id64, { first: row, observed, powers: new Set([row.power]) });
      continue;
    }
    if (observed > group.observed) {
      // Записи одного события пишутся разом; более свежее событие заменяет старое целиком.
      stats.skipped.stale += group.powers.size;
      groups.set(row.id64, { first: row, observed, powers: new Set([row.power]) });
      continue;
    }
    if (observed < group.observed) {
      stats.skipped.stale += 1;
      continue;
    }
    if (group.powers.has(row.power)) {
      stats.skipped.duplicate += 1;
      continue;
    }
    group.powers.add(row.power);
    stats.listings += 1;
  }

  const rows: PowerplayDumpRow[] = [];
  let oldest = Infinity;
  let newest = -Infinity;
  for (const { first, observed, powers } of groups.values()) {
    const list = Array.from(powers).sort((a, b) => a.localeCompare(b, 'en'));
    const owner = list.length === 1 ? list[0] : null;
    rows.push({
      id64: first.id64,
      name: first.name,
      x: first.x,
      y: first.y,
      z: first.z,
      power: owner,
      powers: list,
      state: first.state,
      allegiance: first.allegiance,
      government: first.government,
      observedAt: first.observedAt,
    });
    stats.states[first.state] += 1;
    if (owner) {
      stats.sole += 1;
      stats.powers[owner] = (stats.powers[owner] ?? 0) + 1;
    } else {
      stats.contested += 1;
    }
    for (const power of list) stats.presence[power] = (stats.presence[power] ?? 0) + 1;
    if (observed !== -Infinity) {
      if (observed < oldest) oldest = observed;
      if (observed > newest) newest = observed;
    }
  }
  stats.kept = rows.length;
  stats.oldestObservation = Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
  stats.newestObservation = Number.isFinite(newest) ? new Date(newest).toISOString() : null;
  return { rows, stats };
}
