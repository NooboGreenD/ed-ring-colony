/**
 * Имена тел системы: нормализация и сопоставление между источниками.
 *
 * Зачем это нужно. Тела в каталог приходят из `system_scans`/EDSM/Spansh с
 * полным именем (`Hyades Sector AB-C d1-2 A 1`), а сторонние сервисы называют
 * то же тело как им удобно:
 *
 *   * Raven Colonial отдаёт короткое обозначение — `A 1`, иногда `1 a`;
 *   * у части проектов тела нет вовсе (орбитальный порт без привязки),
 *     зато известен `bodyNum` — номер тела в системе;
 *   * `/api/systems/progress` для старых записей собирает имя как
 *     `<система> <bodyNum>` — «Sol 3» вместо «Earth»;
 *   * EDSM пишет имя кольца (`… A 3 A Ring`), а не самого тела;
 *   * встречаются лишние пробелы, другой регистр и неразрывные пробелы.
 *
 * Из-за этого «применить факт к плану» добавляло записи с именем тела, которого
 * нет в списке, и в интерфейсе они просто не отображались: карточки тел
 * фильтруются строгим сравнением `site.bodyName === body.name`. Модуль решает
 * это одной честной функцией `resolveBodyName`, которая либо находит тело и
 * возвращает его каноническое имя, либо прямо говорит, что не нашла.
 *
 * Модуль чистый: ни сети, ни React — проверяется тестами
 * (`scripts/tests/architect-body-names.test.mjs`).
 */

import type { ArchitectBody } from './types.ts';

/** Как именно нашлось тело — показывается в интерфейсе и в тестах. */
export type BodyMatchKind =
  | 'exact'     // полное имя совпало
  | 'short'     // совпало обозначение без имени системы («A 1»)
  | 'compact'   // совпало без пробелов/дефисов («A1», «ab c1»)
  | 'id'        // совпало по номеру тела (bodyId / bodyNum)
  | 'ring'      // имя кольца/пояса → родительское тело
  | 'none';     // не нашли

export interface BodyMatch {
  /** Каноническое имя тела из каталога; пустая строка — не нашли. */
  name: string;
  kind: BodyMatchKind;
  body: ArchitectBody | null;
}

const NO_MATCH: BodyMatch = { name: '', kind: 'none', body: null };

/**
 * Нормализация имени: неразрывные пробелы → обычные, схлопывание пробелов,
 * нижний регистр, отсечение хвостовой пунктуации. Именно этот ключ
 * используется для сравнения имён тел во всём «Архитекторе».
 */
export function normalizeBodyKey(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u00a0\u202f\u2007]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .toLowerCase();
}

/** Ключ без пробелов и дефисов: «A 1» и «A1» — одно и то же тело. */
export function compactBodyKey(value: unknown): string {
  return normalizeBodyKey(value).replace(/[\s_-]+/g, '');
}

/**
 * Обозначение тела без имени системы: `Hyades Sector AB-C d1-2 A 1` → `a 1`.
 * Если имя системы не совпадает с началом, возвращается нормализованное имя
 * целиком — тела вроде «Earth» короткого обозначения не имеют.
 */
export function shortBodyKey(value: unknown, systemName: unknown): string {
  const name = normalizeBodyKey(value);
  const system = normalizeBodyKey(systemName);
  if (system && name.startsWith(`${system} `)) return name.slice(system.length + 1).trim();
  return name;
}

/** Имя кольца/пояса → имя тела: `… A 3 A Ring` → `… A 3`. */
export function stripRingSuffix(value: unknown): string {
  return normalizeBodyKey(value)
    .replace(/\s+(?:[a-z]\s+)?(?:ring|belt(?:\s+cluster(?:\s+\d+)?)?)$/i, '')
    .trim();
}

/** Индекс тел системы: по нему ищет `resolveBodyName`. */
export interface BodyIndex {
  systemName: string;
  byExact: Map<string, ArchitectBody>;
  byShort: Map<string, ArchitectBody>;
  byCompact: Map<string, ArchitectBody>;
  byId: Map<number, ArchitectBody>;
  bodies: ArchitectBody[];
}

/**
 * Построить индекс имён тел. Ключи, которые оказались неоднозначными
 * (два тела дают один короткий ключ), из «мягких» индексов убираются —
 * лучше не сопоставить вовсе, чем приписать постройку чужому телу.
 */
export function buildBodyIndex(bodies: ArchitectBody[], systemName = ''): BodyIndex {
  const byExact = new Map<string, ArchitectBody>();
  const byShort = new Map<string, ArchitectBody>();
  const byCompact = new Map<string, ArchitectBody>();
  const byId = new Map<number, ArchitectBody>();
  const ambiguousShort = new Set<string>();
  const ambiguousCompact = new Set<string>();
  const ambiguousId = new Set<number>();

  const system = systemName || guessSystemName(bodies);

  for (const body of bodies) {
    const exact = normalizeBodyKey(body.name);
    if (!exact) continue;
    if (!byExact.has(exact)) byExact.set(exact, body);

    const short = shortBodyKey(body.name, system);
    if (short) {
      if (byShort.has(short) && byShort.get(short) !== body) ambiguousShort.add(short);
      else byShort.set(short, body);
    }

    for (const compact of new Set([compactBodyKey(body.name), compactBodyKey(short)])) {
      if (!compact) continue;
      if (byCompact.has(compact) && byCompact.get(compact) !== body) ambiguousCompact.add(compact);
      else byCompact.set(compact, body);
    }

    if (body.bodyId != null && Number.isFinite(body.bodyId)) {
      if (byId.has(body.bodyId) && byId.get(body.bodyId) !== body) ambiguousId.add(body.bodyId);
      else byId.set(body.bodyId, body);
    }
  }

  for (const key of ambiguousShort) byShort.delete(key);
  for (const key of ambiguousCompact) byCompact.delete(key);
  for (const key of ambiguousId) byId.delete(key);

  return { systemName: system, byExact, byShort, byCompact, byId, bodies };
}

/**
 * Имя системы по списку тел: берётся самый длинный общий префикс имён —
 * нужен, когда вызывающий код имя системы не передал.
 */
function guessSystemName(bodies: ArchitectBody[]): string {
  const names = bodies.map((body) => body.name).filter(Boolean);
  if (names.length === 0) return '';
  // Главная звезда обычно называется как система (или «<система> A»).
  const shortest = names.reduce((left, right) => (right.length < left.length ? right : left), names[0]);
  return shortest.replace(/\s+[A-Z]$/, '').trim();
}

export interface ResolveOptions {
  /** Номер тела из источника (`bodyNum`, `bodyId`) — последний шанс сопоставления. */
  bodyId?: number | null;
  /** Разрешить сопоставление кольца/пояса с родительским телом (по умолчанию да). */
  rings?: boolean;
}

/**
 * Найти тело системы по имени из стороннего источника.
 *
 * Порядок проверок — от самого надёжного к самому рискованному; на первом
 * совпадении поиск останавливается. Ничего не «угадывается» по похожести:
 * если тело не нашлось, возвращается `kind: 'none'`, и вызывающий код
 * показывает постройку отдельно, а не прячет её.
 */
export function resolveBodyName(
  raw: unknown,
  index: BodyIndex,
  options: ResolveOptions = {},
): BodyMatch {
  const name = normalizeBodyKey(raw);

  if (name) {
    const exact = index.byExact.get(name);
    if (exact) return { name: exact.name, kind: 'exact', body: exact };

    const short = index.byShort.get(shortBodyKey(name, index.systemName));
    if (short) return { name: short.name, kind: 'short', body: short };

    const compact = index.byCompact.get(compactBodyKey(name))
      ?? index.byCompact.get(compactBodyKey(shortBodyKey(name, index.systemName)));
    if (compact) return { name: compact.name, kind: 'compact', body: compact };

    if (options.rings !== false) {
      const stripped = stripRingSuffix(name);
      if (stripped && stripped !== name) {
        const parent = index.byExact.get(stripped)
          ?? index.byShort.get(shortBodyKey(stripped, index.systemName))
          ?? index.byCompact.get(compactBodyKey(stripped));
        if (parent) return { name: parent.name, kind: 'ring', body: parent };
      }
    }
  }

  // `<система> 3` — так `/api/systems/progress` собирает имя из bodyNum.
  const numeric = numericSuffix(name, index.systemName) ?? toNumber(options.bodyId);
  if (numeric != null) {
    const byId = index.byId.get(numeric);
    if (byId) return { name: byId.name, kind: 'id', body: byId };
  }

  return NO_MATCH;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** `hyades sector ab-c d1-2 3` → 3; всё остальное → null. */
function numericSuffix(name: string, systemName: string): number | null {
  const short = shortBodyKey(name, systemName);
  return /^\d{1,3}$/.test(short) ? Number(short) : null;
}

/**
 * Сопоставить имя тела и вернуть готовое к записи значение.
 * Не нашли — возвращаем исходное (очищенное) имя: план не должен молча терять
 * постройку, но и придумывать тело нельзя.
 */
export function canonicalBodyName(raw: unknown, index: BodyIndex, options: ResolveOptions = {}): string {
  const match = resolveBodyName(raw, index, options);
  if (match.name) return match.name;
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Одно ли это тело? Сравнивает имена так же терпимо, как их ищет
 * `resolveBodyName`: точное имя, обозначение без имени системы и «склеенная»
 * форма без пробелов. Нужна там, где индекса каталога под рукой нет —
 * например, в проверке слотов (`placementCheck`).
 */
export function sameBodyName(left: unknown, right: unknown, systemName: unknown = ''): boolean {
  const a = normalizeBodyKey(left);
  const b = normalizeBodyKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shortA = shortBodyKey(a, systemName);
  const shortB = shortBodyKey(b, systemName);
  if (shortA && shortA === shortB) return true;
  return compactBodyKey(shortA) === compactBodyKey(shortB);
}
