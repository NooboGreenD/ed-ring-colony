/**
 * Быстрый выбор в поиске станций: формат подсказок и их отбор по вводу.
 *
 * Списки собирает сервер (`stationSearchCatalog.ts` → `/api/stations/search/options`):
 * товары, модули и корабли — из EDCD/FDevIDs, услуги и инженеры — из
 * справочников проекта. Здесь только то, что нужно и браузеру, и серверу:
 * нормализация ввода, ранжирование и опознание «ввели ровно это название».
 *
 * Подсказка выбирается по `id`. Сервер по нему ищет точное совпадение
 * (символ Frontier + английское название), поэтому «Water» не находит
 * «Water Purifiers», а «Щит» — призматический.
 */

import type { StationSearchKind } from './stationSearch';

export interface StationSearchOption {
  /** Устойчивый ключ: `market:Steel`, `module:frame-shift-drive-sco`, `ship:python`, `service:techbroker`, `engineer:farseer`. */
  id: string;
  /** Что видит пилот и что встаёт в поле после выбора. */
  label: string;
  /** Вторая строка: название на другом языке, категория, система инженера. */
  hint?: string;
  /** Заголовок группы в списке. */
  group: string;
  /** Другие точные названия (английское, русское, символ): ввели одно из них — то же, что выбрали. */
  names?: string[];
  /** Дополнительные слова для поиска по вводу (сокращения, основа символа, категория). */
  terms?: string;
  /** Короткая отметка: «стройка», «редкий». */
  badge?: string;
  /** Чем меньше, тем выше при равном совпадении (строительные материалы — первыми). */
  rank?: number;
  /** Показывать в списке ещё до ввода (у товаров — строительные материалы). */
  featured?: boolean;
}

export interface StationPickRef {
  id: string;
  label: string;
}

/** Префиксы `id`, допустимые для вкладки. */
export const STATION_PICK_PREFIXES: Record<StationSearchKind, string[]> = {
  market: ['market'],
  outfitting: ['module'],
  shipyard: ['ship'],
  services: ['service', 'engineer'],
};

export function pickMatchesKind(kind: StationSearchKind, id: string | null | undefined): boolean {
  if (!id) return false;
  const prefix = id.slice(0, id.indexOf(':'));
  return id.indexOf(':') > 0 && STATION_PICK_PREFIXES[kind].includes(prefix);
}

/** Слова для сравнения: регистр, «ё», знаки препинания не важны. */
export function optionWords(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-z0-9а-я]+/g, ' ')
    .trim();
}

/** Слитное написание: «low temp» находит «Low Temperature Diamonds», «h.e.» — «H.E. Suits». */
export function optionKey(value: string | null | undefined): string {
  return optionWords(value).replace(/ /g, '');
}

interface Indexed {
  option: StationSearchOption;
  label: string;
  /** Слова названия и подсказки — то, что пилот видит в строке списка. */
  visibleWords: string[];
  /** Слова всего, по чему ищем (ещё другие названия и термины). */
  words: string[];
  keys: string[];
  exact: Set<string>;
}

const indexCache = new WeakMap<StationSearchOption[], Indexed[]>();
const splitWords = (texts: Array<string | undefined>) => texts.flatMap((text) => optionWords(text).split(' ')).filter(Boolean);

function indexOptions(options: StationSearchOption[]): Indexed[] {
  const cached = indexCache.get(options);
  if (cached) return cached;
  const indexed = options.map((option) => {
    const texts = [option.label, option.hint, ...(option.names ?? []), option.terms];
    return {
      option,
      label: optionKey(option.label),
      visibleWords: splitWords([option.label, option.hint]),
      words: splitWords(texts),
      keys: texts.map(optionKey).filter(Boolean),
      exact: new Set([option.label, ...(option.names ?? [])].map(optionKey).filter(Boolean)),
    };
  });
  indexCache.set(options, indexed);
  return indexed;
}

const everyWordStarts = (query: string[], words: string[]) =>
  query.every((word) => words.some((candidate) => candidate.startsWith(word)));

/**
 * Подсказки под ввод: точное название → начало названия → начало слова в
 * видимой строке → начало другого названия → начало любого слова → вхождение.
 * Пустой ввод — избранное справочника (у товаров — строительные материалы), а
 * если избранного нет — весь список в порядке сервера.
 */
export function filterStationOptions(
  options: StationSearchOption[],
  query: string,
  limit = 60,
): StationSearchOption[] {
  const key = optionKey(query);
  if (!key) {
    const featured = options.filter((option) => option.featured);
    return (featured.length ? featured : options).slice(0, limit);
  }
  const words = optionWords(query).split(' ').filter(Boolean);
  const scored: Array<{ option: StationSearchOption; score: number; index: number }> = [];
  indexOptions(options).forEach((entry, index) => {
    let score = -1;
    if (entry.exact.has(key)) score = 0;
    else if (entry.label.startsWith(key)) score = 1;
    else if (everyWordStarts(words, entry.visibleWords)) score = 2;
    else if (entry.keys.some((text) => text.startsWith(key))) score = 3;
    else if (everyWordStarts(words, entry.words)) score = 4;
    else if (entry.keys.some((text) => text.includes(key))) score = 5;
    if (score >= 0) scored.push({ option: entry.option, score, index });
  });
  scored.sort((a, b) => a.score - b.score
    || (a.option.rank ?? 0) - (b.option.rank ?? 0)
    || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.option);
}

/** Пилот ввёл название целиком (на любом языке или символом) — это та же подсказка. */
export function exactStationOption(options: StationSearchOption[], query: string): StationSearchOption | null {
  const key = optionKey(query);
  if (!key) return null;
  return indexOptions(options).find((entry) => entry.exact.has(key))?.option ?? null;
}

/** Русское множественное число: 1 станция, 2 станции, 5 станций. */
export function ruPlural(count: number, forms: [string, string, string]): string {
  const n = Math.abs(Math.trunc(count)) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}
