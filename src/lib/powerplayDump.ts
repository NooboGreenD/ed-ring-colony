/**
 * Разбор ночного дампа EDSM `powerPlay.json.gz` (https://www.edsm.net/en/nightly-dumps).
 *
 * Формат: JSON-массив, по одной системе на строку —
 *   [
 *    {"power":"Edmund Mahon","powerState":"Exploited","id":12031,"id64":58141509045160,
 *     "name":"Wadjabangai","coords":{"x":-24.53125,"y":-33.78125,"z":108.8125},
 *     "allegiance":"Independent","government":"Communism","state":"None",
 *     "date":"2026-09-17 01:49:46"},
 *    …
 *   ]
 * Строки идут по державам, внутри — по дате. В дампе только системы, чьи
 * данные PowerPlay обновлялись за последние ~30 дней (EDSM получает их из
 * журналов пилотов через EDDN), поэтому полный набор пересобирается каждую
 * ночь, а не дописывается.
 *
 * Что отбрасывается:
 *   * `Unoccupied` — системой никто не управляет. EDSM хранит у неё одну
 *     державу из нескольких претендентов, то есть «чья она» здесь неизвестно;
 *   * неизвестные состояния (наследие PowerPlay 1.0 и т. п.);
 *   * записи без имени, координат или id64;
 *   * повторы одной системы — остаётся самое свежее наблюдение.
 *
 * id64 читается из текста строки, а не из `JSON.parse`: адрес системы бывает
 * шире 2^53 и в number терял бы младшие разряды.
 */

import { normalizePowerName, normalizePowerplayState, type PowerplayState } from './powerplay.ts';

export interface PowerplayDumpRow {
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

export type PowerplaySkipReason = 'unoccupied' | 'unknown_state' | 'invalid' | 'duplicate';

export interface PowerplayDumpStats {
  /** Записей в дампе (включая отброшенные). */
  records: number;
  /** Систем под контролем после отбора. */
  kept: number;
  skipped: Record<PowerplaySkipReason, number>;
  states: Record<PowerplayState, number>;
  powers: Record<string, number>;
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

/** Одна запись дампа → строка таблицы или причина, по которой её нет. */
export function edsmRecordToRow(
  record: unknown,
  line: string | null = null,
): { row: PowerplayDumpRow } | { skip: PowerplaySkipReason } {
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
    records: 0,
    kept: 0,
    skipped: { unoccupied: 0, unknown_state: 0, invalid: 0, duplicate: 0 },
    states: { Stronghold: 0, Fortified: 0, Exploited: 0 },
    powers: {},
    oldestObservation: null,
    newestObservation: null,
  };
}

function observedMs(row: PowerplayDumpRow): number {
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

/**
 * Весь дамп → системы под контролем держав и статистика отбора.
 * Бросает ошибку, если текст вообще не похож на дамп (тогда таблицу трогать нельзя).
 */
export function parseEdsmPowerplayDump(text: string): PowerplayDumpResult {
  // Дамп — всегда массив; объект с ошибкой или HTML-страница прокси — не дамп.
  const items = text.trimStart().startsWith('[') ? records(text) : null;
  if (!items) throw new Error('Дамп PowerPlay не похож на JSON-массив систем');

  const stats = emptyStats();
  const byId = new Map<string, PowerplayDumpRow>();
  for (const { record, line } of items) {
    stats.records += 1;
    const result = edsmRecordToRow(record, line);
    if ('skip' in result) {
      stats.skipped[result.skip] += 1;
      continue;
    }
    const current = byId.get(result.row.id64);
    if (current) {
      stats.skipped.duplicate += 1;
      // Свежее наблюдение побеждает; при равных датах — более поздняя строка.
      if (observedMs(result.row) < observedMs(current)) continue;
    }
    byId.set(result.row.id64, result.row);
  }

  const rows = Array.from(byId.values());
  let oldest = Infinity;
  let newest = -Infinity;
  for (const row of rows) {
    stats.states[row.state] += 1;
    stats.powers[row.power] = (stats.powers[row.power] ?? 0) + 1;
    const ms = observedMs(row);
    if (ms !== -Infinity) {
      if (ms < oldest) oldest = ms;
      if (ms > newest) newest = ms;
    }
  }
  stats.kept = rows.length;
  stats.oldestObservation = Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
  stats.newestObservation = Number.isFinite(newest) ? new Date(newest).toISOString() : null;
  return { rows, stats };
}
