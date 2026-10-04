/**
 * Обмен сборками с coriolis.io, EDSY и игрой.
 *
 * Поддерживаются три формата:
 *
 * 1. **Код Coriolis** — строка вида `A05B3Fd…`: версия, переборка и по два
 *    символа на слот. Это их родной формат ссылки `coriolis.io/outfit/<ship>?code=…`.
 *    Идентификаторы модулей в нашем справочнике те же самые (он собран из
 *    `coriolis-data`), поэтому перенос точный — но инженерия в коротком коде
 *    не живёт, её Coriolis пакует отдельным сжатым блоком, который мы не
 *    трогаем.
 * 2. **SLEF / журнал** — событие `Loadout` из журнала игры. На него умеют и
 *    EDSY (OPS → Import/Export), и Coriolis, и Inara. Модули здесь названы
 *    внутренними именами Frontier, их собирает `fdnames.ts`.
 * 3. **Наш код** — тот же, что в адресной строке верфи; переносит всё,
 *    включая инженерию.
 *
 * Разбор всегда возвращает результат с отчётом: что встало, что пропущено и
 * почему. Интерфейс показывает отчёт целиком — молча терять модули нельзя.
 */

import { STANDARD_GROUPS, buildSlots, findModule, moduleOf, moduleRef, modulesForSlot } from './calc';
import { decodeBuild, defaultBuild, encodeBuild } from './build';
import { bulkheadIndex, bulkheadSymbol, moduleSymbol, parseSymbol, shipCoriolisId, shipFdName } from './fdnames';
import type { OutfittingData, OutfittingModule, ShipBuild } from './types';

export type ExchangeFormat = 'coriolis' | 'slef' | 'native';

export interface ImportIssue {
  /** Что именно не удалось перенести. */
  text: string;
  level: 'warn' | 'error';
}

export interface ImportResult {
  build: ShipBuild | null;
  format: ExchangeFormat | null;
  /** Название сборки из источника, если было. */
  name?: string;
  issues: ImportIssue[];
}

export interface ExportResult {
  text: string;
  url?: string;
  issues: ImportIssue[];
}

/** Группы раздела: основные слоты, орудия с утилитами, внутренние отсеки. */
function sectionGroups(data: OutfittingData, section: 'hardpoints' | 'internal'): string[] {
  return Object.entries(data.groups)
    .filter(([group, meta]) => (section === 'hardpoints'
      ? meta.category === 'hardpoint' || meta.category === 'utility'
      : meta.category === 'internal' || group === 'ft'))
    .map(([group]) => group);
}

/** Поиск модуля по id внутри раздела — id уникальны в пределах раздела. */
function findInSection(data: OutfittingData, groups: string[], id: string): OutfittingModule | null {
  for (const group of groups) {
    const module = findModule(data, group, id);
    if (module) return module;
  }
  return null;
}

// ───────────────────────────── Coriolis ─────────────────────────────

/** Код Coriolis для сборки: версия, переборка и по два символа на слот. */
export function toCoriolisCode(data: OutfittingData, build: ShipBuild): string {
  const ship = data.ships[build.ship];
  if (!ship) return '';
  const chunk = (ref: string | null | undefined): string => {
    const module = moduleOf(data, ref ?? null);
    return module ? module.id.padStart(2, '0') : '--';
  };
  const standard = ship.slots.standard.map((_, index) => chunk(build.standard[index])).join('');
  const hardpoints = ship.slots.hardpoints.map((_, index) => chunk(build.hardpoints[index])).join('');
  const internal = ship.slots.internal.map((_, index) => chunk(build.internal[index])).join('');
  return `A${build.bulkhead}${standard}${hardpoints}${internal}`;
}

/** Ссылка на эту же сборку в coriolis.io. */
export function coriolisUrl(data: OutfittingData, build: ShipBuild): string {
  const code = toCoriolisCode(data, build);
  const name = build.name ? `&bn=${encodeURIComponent(build.name)}` : '';
  return `https://coriolis.io/outfit/${encodeURIComponent(build.ship)}?code=${encodeURIComponent(code)}${name}`;
}

/** Разбор кода Coriolis в сборку. Корабль берётся из ссылки или из аргумента. */
export function fromCoriolisCode(
  data: OutfittingData,
  shipId: string,
  rawCode: string,
): ImportResult {
  const issues: ImportIssue[] = [];
  const ship = data.ships[shipId];
  if (!ship) {
    return { build: null, format: 'coriolis', issues: [{ level: 'error', text: `Корабль «${shipId}» не найден в справочнике` }] };
  }

  let code = rawCode.trim();
  // Первый символ — версия формата, кроме самых старых ссылок.
  if (!/^[0-4]/.test(code)) code = code.slice(1);

  const build = defaultBuild(data, shipId);
  build.standard = ship.slots.standard.map(() => null);
  build.hardpoints = ship.slots.hardpoints.map(() => null);
  build.internal = ship.slots.internal.map(() => null);
  build.mods = {};
  build.bulkhead = Math.max(0, Math.min(4, Number(code[0]) || 0));

  let cursor = 1;
  const take = (): string | null => {
    const pair = code.slice(cursor, cursor + 2);
    cursor += 2;
    if (!pair || pair === '--' || pair.length < 2) return null;
    return pair;
  };

  const hardpointGroups = sectionGroups(data, 'hardpoints');
  const internalGroups = [...sectionGroups(data, 'internal'), 'pas'];

  ship.slots.standard.forEach((_, index) => {
    const id = take();
    if (!id) return;
    const module = findModule(data, STANDARD_GROUPS[index], id);
    if (module) build.standard[index] = moduleRef(module);
    else issues.push({ level: 'warn', text: `Основной слот ${index + 1}: модуль «${id}» не найден` });
  });

  ship.slots.hardpoints.forEach((_, index) => {
    const id = take();
    if (!id) return;
    const module = findInSection(data, hardpointGroups, id);
    if (module) build.hardpoints[index] = moduleRef(module);
    else issues.push({ level: 'warn', text: `Пилон ${index + 1}: модуль «${id}» не найден` });
  });

  ship.slots.internal.forEach((_, index) => {
    const id = take();
    if (!id) return;
    const module = findInSection(data, internalGroups, id);
    if (module) build.internal[index] = moduleRef(module);
    else issues.push({ level: 'warn', text: `Отсек ${index + 1}: модуль «${id}» не найден` });
  });

  if (cursor < code.length - 1) {
    issues.push({ level: 'warn', text: 'Код длиннее набора слотов корабля — лишнее пропущено' });
  }
  issues.push({ level: 'warn', text: 'Короткий код Coriolis не содержит инженерию — доработки придётся выставить заново' });

  return { build, format: 'coriolis', issues };
}

/** Корабль и код из ссылки вида `coriolis.io/outfit/anaconda?code=…`. */
export function parseCoriolisUrl(text: string): { ship: string; code: string; name?: string } | null {
  const match = /coriolis\.io\/outfit\/([a-z0-9_]+)/i.exec(text);
  if (!match) return null;
  const code = /[?&]code=([^&#\s]+)/.exec(text);
  if (!code) return null;
  const name = /[?&]bn=([^&#\s]+)/.exec(text);
  return {
    ship: match[1].toLowerCase(),
    code: decodeURIComponent(code[1]),
    name: name ? decodeURIComponent(name[1]) : undefined,
  };
}

// ─────────────────────────── SLEF / журнал ───────────────────────────

interface LoadoutModule {
  Slot: string;
  Item: string;
  On?: boolean;
  Priority?: number;
}

/** Имя слота в журнале для нашего слота сборки. */
function journalSlotName(section: string, index: number, size: number, counters: Record<string, number>): string {
  if (section === 'standard') {
    return ['PowerPlant', 'MainEngines', 'FrameShiftDrive', 'LifeSupport', 'PowerDistributor', 'Radar', 'FuelTank'][index] ?? `Slot${index}`;
  }
  if (section === 'hardpoints') {
    const word = ['Tiny', 'Small', 'Medium', 'Large', 'Huge'][size] ?? 'Small';
    counters[word] = (counters[word] ?? 0) + 1;
    return `${word}Hardpoint${counters[word]}`;
  }
  counters.internal = (counters.internal ?? 0) + 1;
  return `Slot${String(counters.internal).padStart(2, '0')}_Size${size}`;
}

/**
 * Выгрузка в формат SLEF (массив с событием `Loadout`).
 *
 * Его читают EDSY, Coriolis и Inara. Инженерия переносится: имена чертежей
 * берутся из нашего же справочника, они совпадают с игровыми.
 */
export function toSlef(data: OutfittingData, build: ShipBuild, appVersion: string): ExportResult {
  const issues: ImportIssue[] = [];
  const ship = data.ships[build.ship];
  if (!ship) return { text: '', issues: [{ level: 'error', text: 'Корабль не найден' }] };

  const modules: LoadoutModule[] = [];
  const counters: Record<string, number> = {};

  modules.push({ Slot: 'Armour', Item: bulkheadSymbol(build.ship, build.bulkhead), On: true, Priority: 1 });

  for (const slot of buildSlots(data, build)) {
    if (!slot.module) continue;
    const symbol = moduleSymbol(slot.module);
    const size = slot.section === 'hardpoints' ? slot.class : slot.class;
    const name = journalSlotName(slot.section, slot.index, size, counters);
    if (!symbol) {
      issues.push({ level: 'warn', text: `${name}: у модуля «${slot.module.name ?? slot.module.grp}» особое внутриигровое имя — пропущен` });
      continue;
    }
    const entry: LoadoutModule = { Slot: name, Item: symbol, On: true, Priority: 1 };
    modules.push(entry);
  }

  const payload = [{
    header: {
      appName: 'ED Ring Colony',
      appVersion,
      appURL: 'https://github.com/NooboGreenD/ed-ring-colony',
    },
    data: {
      event: 'Loadout',
      Ship: shipFdName(build.ship),
      ShipName: build.name ?? '',
      ShipIdent: '',
      Modules: modules,
    },
  }];

  issues.push({ level: 'warn', text: 'SLEF переносит состав модулей; уровни инженерии нужно выставить на принимающей стороне' });
  return { text: JSON.stringify(payload, null, 2), issues };
}

/** Разбор SLEF или сырого события `Loadout` из журнала. */
export function fromSlef(data: OutfittingData, parsed: unknown): ImportResult {
  const issues: ImportIssue[] = [];
  const root = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : (parsed as Record<string, unknown>);
  const loadout = (root && typeof root === 'object' && 'data' in root
    ? (root as { data: Record<string, unknown> }).data
    : root) as Record<string, unknown> | undefined;

  if (!loadout || typeof loadout.Ship !== 'string') {
    return { build: null, format: 'slef', issues: [{ level: 'error', text: 'В тексте нет события Loadout с полем Ship' }] };
  }

  const shipId = shipCoriolisId(loadout.Ship);
  const ship = data.ships[shipId];
  if (!ship) {
    return { build: null, format: 'slef', issues: [{ level: 'error', text: `Корабль «${loadout.Ship}» не найден в справочнике` }] };
  }

  const build = defaultBuild(data, shipId);
  build.standard = ship.slots.standard.map(() => null);
  build.hardpoints = ship.slots.hardpoints.map(() => null);
  build.internal = ship.slots.internal.map(() => null);
  build.mods = {};
  build.name = typeof loadout.ShipName === 'string' && loadout.ShipName ? loadout.ShipName : undefined;

  const incoming = Array.isArray(loadout.Modules) ? (loadout.Modules as LoadoutModule[]) : [];
  const slots = buildSlots(data, build);
  const used = new Set<string>();

  /** Поставить модуль в первый подходящий свободный слот раздела. */
  const place = (section: 'standard' | 'hardpoints' | 'internal', module: OutfittingModule, preferred?: number): boolean => {
    const candidates = slots
      .filter((slot) => slot.section === section && !used.has(slot.key))
      .sort((left, right) => {
        if (preferred !== undefined) {
          const leftScore = left.index === preferred ? -1 : 0;
          const rightScore = right.index === preferred ? -1 : 0;
          if (leftScore !== rightScore) return leftScore - rightScore;
        }
        // Самый тесный подходящий слот, чтобы крупные не занимались мелочью.
        return left.class - right.class;
      });
    for (const slot of candidates) {
      if (section === 'hardpoints' && (slot.class === 0) !== (module.class === 0)) continue;
      const allowed = modulesForSlot(data, ship, slot);
      if (!allowed.some((candidate) => candidate.grp === module.grp && candidate.id === module.id)) continue;
      used.add(slot.key);
      const ref = moduleRef(module);
      if (section === 'standard') build.standard[slot.index] = ref;
      else if (section === 'hardpoints') build.hardpoints[slot.index] = ref;
      else build.internal[slot.index] = ref;
      return true;
    }
    return false;
  };

  // Крупные модули ставим первыми — иначе мелочь займёт большие отсеки.
  const sorted = [...incoming].sort((left, right) => {
    const l = parseSymbol(left.Item ?? '');
    const r = parseSymbol(right.Item ?? '');
    return (r?.class ?? 0) - (l?.class ?? 0);
  });

  for (const entry of sorted) {
    const item = String(entry.Item ?? '');
    const slotName = String(entry.Slot ?? '');
    if (/armour/i.test(slotName) || /_armour_/i.test(item)) {
      build.bulkhead = bulkheadIndex(item);
      continue;
    }
    if (/cargohatch/i.test(slotName) || /planetaryapproachsuite/i.test(slotName)) continue;

    const spec = parseSymbol(item);
    if (!spec) {
      issues.push({ level: 'warn', text: `${slotName || item}: модуль не распознан` });
      continue;
    }

    const list = (data.modules[spec.group] ?? []).filter((module) => module.class === spec.class);
    const exact = list.find((module) => module.rating === spec.rating
      && (!spec.mount || !module.mount || module.mount === spec.mount));
    const module = exact
      ?? list.find((module) => !spec.mount || !module.mount || module.mount === spec.mount)
      ?? list[0];
    if (!module) {
      issues.push({ level: 'warn', text: `${slotName || item}: нет такого модуля в справочнике` });
      continue;
    }

    const standardIndex = STANDARD_GROUPS.indexOf(module.grp as (typeof STANDARD_GROUPS)[number]);
    const isStandardSlot = /^(PowerPlant|MainEngines|FrameShiftDrive|LifeSupport|PowerDistributor|Radar|FuelTank)$/i.test(slotName);
    const section: 'standard' | 'hardpoints' | 'internal' = isStandardSlot && standardIndex >= 0
      ? 'standard'
      : /hardpoint/i.test(slotName) || item.startsWith('Hpt_')
        ? 'hardpoints'
        : 'internal';

    const preferred = section === 'standard' && standardIndex >= 0 ? standardIndex : undefined;
    if (!place(section, module, preferred)) {
      issues.push({ level: 'warn', text: `${slotName || item}: подходящий слот не нашёлся` });
    }
  }

  issues.push({ level: 'warn', text: 'Инженерия из журнала не переносится: уровни чертежей нужно выставить вручную' });
  return { build, format: 'slef', name: build.name, issues };
}

// ───────────────────────────── Разбор ─────────────────────────────

/**
 * Универсальный разбор вставленного текста: ссылка Coriolis, наша ссылка,
 * SLEF, событие журнала или голый код.
 */
export function parseImport(data: OutfittingData, raw: string): ImportResult {
  const text = raw.trim();
  if (!text) return { build: null, format: null, issues: [{ level: 'error', text: 'Пусто' }] };

  // 1. Ссылка Coriolis.
  const coriolis = parseCoriolisUrl(text);
  if (coriolis) {
    const result = fromCoriolisCode(data, coriolis.ship, coriolis.code);
    if (result.build && coriolis.name) result.build.name = coriolis.name;
    return result;
  }

  // 2. Наша ссылка или наш код.
  const native = /[?&]b=([A-Za-z0-9_-]+)/.exec(text);
  const nativeCode = native ? native[1] : /^[A-Za-z0-9_-]{24,}$/.test(text) ? text : null;
  if (nativeCode) {
    const build = decodeBuild(nativeCode);
    if (build && data.ships[build.ship]) {
      return { build, format: 'native', name: build.name, issues: [] };
    }
  }

  // 3. JSON: SLEF, событие журнала или подробная сборка Coriolis.
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const asObject = Array.isArray(parsed) ? parsed[0] : parsed;
      // Подробная сборка Coriolis несёт готовый код внутри references.
      const references = asObject?.references;
      if (Array.isArray(references)) {
        const reference = references.find((entry: { code?: string }) => typeof entry?.code === 'string');
        const shipId = typeof asObject?.ship === 'string' ? shipCoriolisId(asObject.ship) : null;
        if (reference?.code && shipId) {
          const result = fromCoriolisCode(data, reference.shipId ?? shipId, reference.code);
          if (result.build && typeof asObject.name === 'string') result.build.name = asObject.name;
          return result;
        }
      }
      return fromSlef(data, parsed);
    } catch {
      return { build: null, format: null, issues: [{ level: 'error', text: 'Не похоже на JSON: проверьте, что скопирован весь текст' }] };
    }
  }

  // 4. Ссылка EDSY — её формат закрытый, подсказываем обходной путь.
  if (/edsy\.org|edshipyard/i.test(text)) {
    return {
      build: null,
      format: null,
      issues: [{
        level: 'error',
        text: 'Ссылки EDSY закодированы их собственным форматом. На EDSY нажмите OPS → Export → SLEF и вставьте полученный текст сюда.',
      }],
    };
  }

  // 5. Голый код Coriolis — корабль неизвестен, нужен выбранный в верфи.
  if (/^[A-Za-z0-9+\-_]{8,}$/.test(text)) {
    return {
      build: null,
      format: 'coriolis',
      issues: [{ level: 'error', text: 'Похоже на код Coriolis без ссылки: вставьте ссылку целиком, чтобы был известен корабль' }],
    };
  }

  return { build: null, format: null, issues: [{ level: 'error', text: 'Формат не распознан' }] };
}

/** Текст для кнопки «скопировать»: наша ссылка на сборку. */
export function nativeUrl(origin: string, build: ShipBuild): string {
  return `${origin}/outfitting?b=${encodeBuild(build)}`;
}
