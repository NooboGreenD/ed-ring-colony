/**
 * Серверный справочник поиска станций: подсказки быстрого выбора, перевод
 * выбранной подсказки в точные ключи и подписи найденного.
 *
 * Источники (ничего не придумываем):
 *  * товары, модули, корабли — EDCD/FDevIDs (`stationSearchItems.json`, его
 *    собирает `scripts/build-station-search-items.mjs`): символ Frontier и
 *    английское название «как в игре»;
 *  * русские названия — строительные материалы (`COMMODITY_LABELS_RU`, как в
 *    «Проектах систем») и группы модулей (`GROUP_NAMES`, как в верфи); у
 *    остального русского названия нет, и подсказка честно показывает
 *    английское;
 *  * производитель и площадка корабля — справочник верфи (`outfitting.json`);
 *  * услуги и инженеры — `SERVICE_OPTIONS` и `ENGINEERS`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMODITY_LABELS_RU } from '@/lib/architect/catalogue';
import { BUILD_COMMODITIES, commodityKey } from '@/lib/commodities';
import { ENGINEERS } from '@/lib/engineers/data';
import { moduleSymbol, parseSymbol, shipFdName, shipCoriolisId } from '@/lib/outfitting/fdnames';
import { groupName } from '@/lib/outfitting/i18n';
import type { OutfittingData } from '@/lib/outfitting/types';
import {
  SERVICE_OPTIONS, searchKey, serviceAliases, serviceLabel, stationItemKey,
  type StationSearchItem, type StationSearchKind, type StationSearchResult,
} from '@/lib/stationSearch';
import { optionKey, pickMatchesKind, type StationSearchOption } from '@/lib/stationSearchOptions';
import items from './stationSearchItems.json' with { type: 'json' };

let catalog: OutfittingData | undefined;
function data() {
  if (!catalog) catalog = JSON.parse(readFileSync(join(process.cwd(), 'public/data/outfitting.json'), 'utf8')) as OutfittingData;
  return catalog;
}

const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => !!value && value.trim() !== ''))];

/** Категории товаров FDevIDs → подписи групп списка. */
const COMMODITY_CATEGORY_RU: Record<string, string> = {
  Chemicals: 'Химикаты', 'Consumer Items': 'Потребительские товары', Foods: 'Продукты питания',
  'Industrial Materials': 'Промышленные материалы', 'Legal Drugs': 'Легальные наркотики', Machinery: 'Оборудование',
  Medicines: 'Медикаменты', Metals: 'Металлы', Minerals: 'Минералы', NonMarketable: 'Не для рынка',
  Salvage: 'Трофеи и находки', Slavery: 'Рабы', Technology: 'Технологии', Textiles: 'Текстиль',
  Waste: 'Отходы', Weapons: 'Оружие',
};
const BUILD_GROUP = 'Строительные материалы';

const MODULE_CATEGORY_RU: Record<string, string> = {
  standard: 'Основные модули', internal: 'Внутренние модули', utility: 'Вспомогательные модули',
  hardpoint: 'Орудия', mercgear: 'MercGear',
};
const MODULE_CATEGORY_ORDER = ['standard', 'internal', 'utility', 'hardpoint', 'mercgear'];
const MOUNT_RU: Record<string, string> = { Fixed: 'фикс.', Gimballed: 'наводящееся', Turreted: 'турель' };
/** Как пилоты пишут группы в чате. */
const GROUP_TERMS: Record<string, string> = {
  fsd: 'фсд прыжок', sg: 'щит', bsg: 'щит', psg: 'щит', fs: 'scoop скуп', am: 'afmu', ss: 'dss',
  scb: 'scb', hr: 'hrp', mrp: 'mrp', dc: 'стыковка',
};
/** Символы, которых не разбирает `parseSymbol`, но у группы есть русское имя. */
const SYMBOL_GROUP: Record<string, string> = { intdockingcomputerstandard: 'dc' };
const PAD_SIZE: Record<number, string> = { 1: 'S', 2: 'M', 3: 'L' };

/* ── Товары ── */

interface CommodityEntry { symbol: string; name: string; category: string; rare: boolean; build: boolean; ru?: string }
let commodityIndex: { list: CommodityEntry[]; byKey: Map<string, CommodityEntry>; bySymbol: Map<string, CommodityEntry> } | undefined;

function commodities() {
  if (commodityIndex) return commodityIndex;
  const build = new Set(BUILD_COMMODITIES.map(commodityKey));
  const list: CommodityEntry[] = [
    ...items.commodities.map((entry) => ({ ...entry, rare: false })),
    ...items.rare.map((entry) => ({ ...entry, rare: true })),
  ].map((entry) => {
    const keys = [commodityKey(entry.symbol), commodityKey(entry.name)];
    return {
      ...entry,
      build: keys.some((key) => build.has(key)),
      ru: COMMODITY_LABELS_RU[keys[0]] ?? COMMODITY_LABELS_RU[keys[1]],
    };
  });
  const byKey = new Map<string, CommodityEntry>();
  const bySymbol = new Map<string, CommodityEntry>();
  for (const entry of list) {
    bySymbol.set(entry.symbol.toLowerCase(), entry);
    for (const key of [commodityKey(entry.symbol), commodityKey(entry.name)]) if (key && !byKey.has(key)) byKey.set(key, entry);
  }
  commodityIndex = { list, byKey, bySymbol };
  return commodityIndex;
}

function findCommodity(item: Partial<StationSearchItem>): CommodityEntry | undefined {
  const { byKey } = commodities();
  for (const value of [item.symbol, item.name, item.id]) {
    const entry = byKey.get(stationItemKey(value));
    if (entry) return entry;
  }
  return undefined;
}

/* ── Модули ── */

type ModuleItem = [symbol: string, size: number, rating: string, mount: string];
interface ModuleEntry {
  id: string; name: string; category: string; group: string | null; base: boolean;
  items: ModuleItem[]; label: string; hint?: string; stems: string[];
}
interface ModuleSymbol { module: ModuleEntry; size: number; rating: string; mount: string }
let moduleIndex: { list: ModuleEntry[]; byId: Map<string, ModuleEntry>; bySymbol: Map<string, ModuleSymbol> } | undefined;

function symbolGroup(symbol: string): string | null {
  return SYMBOL_GROUP[stationItemKey(symbol)] ?? parseSymbol(symbol)?.group ?? null;
}

function symbolStem(symbol: string): string {
  return symbol
    .replace(/^(int|hpt)_/i, '')
    .replace(/_size\d+_class\d+.*$/i, '')
    .replace(/_(fixed|gimbal|turret)_(tiny|small|medium|large|huge).*$/i, '')
    .replace(/_size\d+$/i, '')
    .replace(/_/g, ' ');
}

function modules() {
  if (moduleIndex) return moduleIndex;
  const list: ModuleEntry[] = (items.modules as Array<{ name: string; category: string; items: ModuleItem[] }>).map((module) => {
    const counts = new Map<string, number>();
    for (const [symbol] of module.items) {
      const group = symbolGroup(symbol);
      if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const group = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const slug = module.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return {
      id: `module:${slug}`, name: module.name, category: module.category, group, base: false,
      items: module.items, label: module.name, stems: unique(module.items.map(([symbol]) => symbolStem(symbol))),
    };
  });
  // Основное семейство группы (у кого больше всего вариантов) получает русское
  // имя группы из верфи; остальные — английское название с группой в подсказке.
  const bases = new Map<string, ModuleEntry>();
  for (const module of list) {
    if (!module.group) continue;
    const current = bases.get(module.group);
    if (!current || module.items.length > current.items.length
      || (module.items.length === current.items.length && module.name.length < current.name.length)) bases.set(module.group, module);
  }
  for (const module of list) {
    const groupRu = module.group ? groupName('ru', module.group) : null;
    module.base = !!module.group && bases.get(module.group) === module;
    module.label = module.base && groupRu ? groupRu : module.name;
    module.hint = module.base ? module.name : groupRu ?? undefined;
  }
  const byId = new Map(list.map((module) => [module.id, module]));
  const bySymbol = new Map<string, ModuleSymbol>();
  for (const module of list) {
    for (const [symbol, size, rating, mount] of module.items) {
      const key = stationItemKey(symbol);
      if (!bySymbol.has(key)) bySymbol.set(key, { module, size, rating, mount });
    }
  }
  moduleIndex = { list, byId, bySymbol };
  return moduleIndex;
}

/* ── Корабли ── */

interface ShipEntry { symbol: string; name: string; coriolisName?: string; manufacturer?: string; pad?: string }
let shipIndex: { list: ShipEntry[]; byKey: Map<string, ShipEntry> } | undefined;

function ships() {
  if (shipIndex) return shipIndex;
  const d = data();
  const list: ShipEntry[] = items.ships.map((ship) => {
    const properties = d.ships[shipCoriolisId(ship.symbol)]?.properties;
    return {
      ...ship,
      coriolisName: properties?.name,
      manufacturer: properties?.manufacturer,
      pad: properties ? PAD_SIZE[Number(properties.class)] : undefined,
    };
  });
  const byKey = new Map<string, ShipEntry>();
  for (const ship of list) {
    for (const value of [ship.symbol, ship.name, ship.coriolisName]) {
      const key = stationItemKey(value);
      if (key && !byKey.has(key)) byKey.set(key, ship);
    }
  }
  shipIndex = { list, byKey };
  return shipIndex;
}

/* ── Подсказки ── */

function marketOptions(): StationSearchOption[] {
  return commodities().list.map((entry): StationSearchOption => {
    const category = COMMODITY_CATEGORY_RU[entry.category] ?? entry.category;
    const rank = entry.build ? 0 : entry.rare ? 2 : entry.category === 'Salvage' || entry.category === 'NonMarketable' ? 3 : 1;
    return {
      id: `market:${entry.symbol}`,
      label: entry.ru ?? entry.name,
      hint: entry.ru ? `${entry.name} · ${category}` : category,
      group: entry.build ? BUILD_GROUP : category,
      names: unique([entry.name, entry.symbol, entry.ru]),
      terms: entry.category,
      ...(entry.rare ? { badge: 'редкий' } : entry.build ? { badge: 'стройка' } : {}),
      rank,
      ...(entry.build ? { featured: true } : {}),
    };
  }).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.group.localeCompare(b.group, 'ru') || a.label.localeCompare(b.label, 'ru'));
}

function outfittingOptions(): StationSearchOption[] {
  return modules().list.map((module): StationSearchOption => ({
    id: module.id,
    label: module.label,
    ...(module.hint ? { hint: module.hint } : {}),
    group: MODULE_CATEGORY_RU[module.category] ?? module.category,
    names: unique([module.name, module.label]),
    terms: unique([
      module.group ? groupName('en', module.group) : null,
      module.group && !module.base ? groupName('ru', module.group) : null,
      module.group ? GROUP_TERMS[module.group] : null,
      ...module.stems,
    ]).join(' '),
    rank: module.base ? 0 : 1,
  })).sort((a, b) => {
    const category = (option: StationSearchOption) => MODULE_CATEGORY_ORDER.indexOf(
      Object.keys(MODULE_CATEGORY_RU).find((key) => MODULE_CATEGORY_RU[key] === option.group) ?? '');
    return category(a) - category(b) || (a.rank ?? 0) - (b.rank ?? 0) || a.label.localeCompare(b.label, 'ru');
  });
}

function shipyardOptions(): StationSearchOption[] {
  return ships().list.map((ship): StationSearchOption => {
    const alternative = ship.coriolisName && optionKey(ship.coriolisName) !== optionKey(ship.name) ? ship.coriolisName : null;
    return {
      id: `ship:${ship.symbol.toLowerCase()}`,
      label: ship.name,
      hint: unique([ship.manufacturer, ship.pad ? `площадка ${ship.pad}` : null, alternative]).join(' · ') || 'Корабль',
      group: 'Корабли',
      names: unique([ship.name, ship.symbol, ship.coriolisName]),
      terms: shipCoriolisId(ship.symbol).replace(/_/g, ' '),
    };
  }).sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

function serviceOptions(): StationSearchOption[] {
  const services = SERVICE_OPTIONS.map((option): StationSearchOption => ({
    id: `service:${option.value}`,
    label: option.label,
    group: 'Услуги станции',
    names: unique([option.label, option.value]),
    terms: option.aliases.join(' '),
  }));
  const engineers = [...ENGINEERS]
    .sort((a, b) => Number(a.branch !== 'ship') - Number(b.branch !== 'ship') || a.name.localeCompare(b.name, 'en'))
    .map((engineer): StationSearchOption => ({
      id: `engineer:${engineer.id}`,
      label: engineer.name,
      hint: `${engineer.system} · ${engineer.station}`,
      group: engineer.branch === 'ship' ? 'Инженеры кораблей' : 'Инженеры Odyssey',
      names: unique([engineer.name, ...(engineer.aliases ?? [])]),
      terms: `инженер engineer ${engineer.system} ${engineer.station}`,
    }));
  return [...services, ...engineers];
}

const optionsCache = new Map<StationSearchKind, StationSearchOption[]>();

/** Список быстрого выбора для вкладки (порядок — для пустого ввода). */
export function stationSearchOptions(kind: StationSearchKind): StationSearchOption[] {
  let options = optionsCache.get(kind);
  if (!options) {
    options = kind === 'market' ? marketOptions()
      : kind === 'outfitting' ? outfittingOptions()
        : kind === 'shipyard' ? shipyardOptions() : serviceOptions();
    optionsCache.set(kind, options);
  }
  return options;
}

export const STATION_ITEMS_SOURCE = { source: items.source, ref: items.ref, retrieved: items.retrieved };

/* ── Выбранная подсказка → условия поиска ── */

export interface StationPick {
  id: string;
  label: string;
  /** Вхождения для прежней функции поиска (запасной путь). */
  needles: string[];
  /** Ключи точного совпадения (`station_item_key`); пусто — ищем по вхождению. */
  exactKeys: string[];
}

export function resolveStationPick(kind: StationSearchKind, id: string | null | undefined): StationPick | null {
  if (!id || !pickMatchesKind(kind, id)) return null;
  const separator = id.indexOf(':');
  const prefix = id.slice(0, separator);
  const value = id.slice(separator + 1);
  if (prefix === 'market') {
    const entry = commodities().bySymbol.get(value.toLowerCase());
    if (!entry) return null;
    return {
      id: `market:${entry.symbol}`, label: entry.ru ?? entry.name,
      needles: unique([entry.name, entry.symbol]),
      exactKeys: unique([stationItemKey(entry.name), stationItemKey(entry.symbol)]),
    };
  }
  if (prefix === 'module') {
    const module = modules().byId.get(id);
    if (!module) return null;
    const symbols = module.items.map(([symbol]) => symbol);
    return { id, label: module.label, needles: symbols.slice(0, 100), exactKeys: unique(symbols.map(stationItemKey)) };
  }
  if (prefix === 'ship') {
    const ship = ships().list.find((entry) => entry.symbol.toLowerCase() === value.toLowerCase());
    if (!ship) return null;
    const names = unique([ship.name, ship.symbol, ship.coriolisName]);
    return { id: `ship:${ship.symbol.toLowerCase()}`, label: ship.name, needles: names, exactKeys: unique(names.map(stationItemKey)) };
  }
  if (prefix === 'service') {
    const option = SERVICE_OPTIONS.find((entry) => entry.value === value);
    return option ? { id, label: option.label, needles: option.aliases, exactKeys: [] } : null;
  }
  const engineer = ENGINEERS.find((entry) => entry.id === value);
  return engineer ? { id, label: engineer.name, needles: unique([engineer.name, ...(engineer.aliases ?? [])]), exactKeys: [] } : null;
}

/* ── Свободный ввод ── */

/**
 * Свободный ввод → вхождения для поиска: русские и английские названия,
 * символы Frontier. Наличие на станции не выдумывается — ищутся только
 * названия, а не «где это обычно продают».
 */
export function stationQueryAliases(kind: StationSearchKind, query: string): string[] {
  if (kind === 'services') return serviceAliases(query);
  const aliases = new Set([query]);
  if (kind === 'market') {
    const key = optionKey(query);
    if (key.length >= 2) {
      for (const entry of commodities().list) {
        if (![entry.name, entry.symbol, entry.ru].some((name) => name && optionKey(name).includes(key))) continue;
        aliases.add(entry.name);
        aliases.add(entry.symbol);
      }
    }
    return [...aliases].slice(0, 100);
  }
  const key = searchKey(query);
  const d = data();
  if (kind === 'outfitting') {
    for (const [group, groupModules] of Object.entries(d.modules)) {
      for (const module of groupModules) {
        const descriptions = [module.name || '', groupName('ru', group), groupName('en', group)];
        if (!descriptions.some((description) => searchKey(description).includes(key))) continue;
        const symbol = moduleSymbol(module);
        if (symbol) aliases.add(/_(fast|strong)$/i.test(symbol) ? symbol : symbol.replace(/_size\d+_class\d+/i, ''));
        if (module.name) aliases.add(module.name);
      }
    }
  } else {
    for (const [id, ship] of Object.entries(d.ships)) {
      if ([id, ship.properties.name].some((name) => searchKey(name).includes(key))) {
        aliases.add(shipFdName(id)); aliases.add(ship.properties.name);
      }
    }
    for (const ship of ships().list) {
      if ([ship.name, ship.symbol].some((name) => searchKey(name).includes(key))) {
        aliases.add(ship.symbol); aliases.add(ship.name);
      }
    }
  }
  return [...aliases].slice(0, 100);
}

/* ── Подписи найденного ── */

/** Подпись позиции в раскрытой строке: русское название, где оно есть, класс и рейтинг модуля. */
export function stationItemDisplay(kind: StationSearchKind, item: StationSearchResult['item']): { display: string; hint?: string } {
  if (kind === 'market') {
    const entry = findCommodity(item);
    if (!entry) return { display: item.name };
    return entry.ru ? { display: entry.ru, hint: entry.name } : { display: entry.name };
  }
  if (kind === 'outfitting') {
    const { bySymbol } = modules();
    const known = bySymbol.get(stationItemKey(item.symbol)) ?? bySymbol.get(stationItemKey(item.name)) ?? bySymbol.get(stationItemKey(item.id));
    if (known) {
      const mount = MOUNT_RU[known.mount];
      return {
        display: `${known.size}${known.rating} ${known.module.label}${mount ? ` (${mount})` : ''}`.trim(),
        ...(known.module.hint ? { hint: known.module.hint } : {}),
      };
    }
    const parsed = parseSymbol(item.symbol || item.name);
    if (parsed) return { display: `${parsed.class}${parsed.rating} ${groupName('ru', parsed.group)}` };
    return { display: `${item.class ?? ''}${item.rating ?? ''} ${item.name}`.trim() };
  }
  if (kind === 'shipyard') {
    const { byKey } = ships();
    const ship = byKey.get(stationItemKey(item.symbol)) ?? byKey.get(stationItemKey(item.name));
    if (ship) return { display: ship.name };
    const coriolis = data().ships[shipCoriolisId(item.symbol || item.name)];
    return { display: coriolis?.properties.name || item.name };
  }
  const engineer = /^engineer:\s*(.+)$/i.exec(item.name);
  if (engineer) return { display: `Инженер ${engineer[1].trim()}` };
  const label = serviceLabel(item.name);
  // Английское название от EDSM/Spansh («Technology Broker») полезно рядом с
  // русским; служебный ключ журнала (`techBroker`) — нет.
  return label !== item.name && /\s/.test(item.name.trim()) ? { display: label, hint: item.name } : { display: label };
}

export function stationItemLabel(kind: StationSearchKind, item: StationSearchResult['item']): string {
  return stationItemDisplay(kind, item).display;
}
