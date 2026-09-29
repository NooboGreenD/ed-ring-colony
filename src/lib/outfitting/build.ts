/**
 * Сборка корабля: заводская комплектация, ссылки и человеческие названия.
 *
 * Сборка хранится как обычный объект (`ShipBuild`) и кодируется в ссылку
 * base64url — так её можно кинуть в чат эскадрильи, а страница откроется
 * ровно с тем же кораблём. Формат наш, не coriolis.io: их код завязан на
 * внутренние индексы их же версии данных.
 */

import { STANDARD_GROUPS, findModule, moduleRef } from './calc';
import type { OutfittingData, OutfittingModule, ShipBuild } from './types';

/** Группы модулей по разделам — нужны для разбора заводской комплектации. */
function groupsOfSection(data: OutfittingData, section: 'hardpoints' | 'internal'): string[] {
  return Object.entries(data.groups)
    .filter(([group, meta]) => (section === 'hardpoints'
      ? meta.category === 'hardpoint' || meta.category === 'utility'
      : meta.category === 'internal' || group === 'ft'))
    .map(([group]) => group);
}

/** Заводская запись слота: «5E» (класс+рейтинг) либо id модуля. */
function resolveDefault(
  data: OutfittingData,
  entry: string | number | undefined,
  groups: string[],
): string | null {
  if (!entry || entry === 0) return null;
  const text = String(entry);
  const classRating = /^(\d)([A-Z])$/.exec(text);
  if (classRating && groups.length === 1) {
    const module = (data.modules[groups[0]] ?? []).find(
      (candidate) => candidate.class === Number(classRating[1]) && candidate.rating === classRating[2],
    );
    if (module) return moduleRef(module);
  }
  for (const group of groups) {
    const module = findModule(data, group, text);
    if (module) return moduleRef(module);
  }
  return null;
}

/** Заводская сборка корабля — то, что стоит на нём в верфи по умолчанию. */
export function defaultBuild(data: OutfittingData, shipId: string): ShipBuild {
  const ship = data.ships[shipId];
  const build: ShipBuild = {
    ship: shipId,
    bulkhead: 0,
    standard: [],
    hardpoints: [],
    internal: [],
    mods: {},
  };
  if (!ship) return build;

  build.standard = ship.slots.standard.map((size, index) => {
    const group = STANDARD_GROUPS[index];
    const fromDefaults = resolveDefault(data, ship.defaults?.standard?.[index], [group]);
    if (fromDefaults) return fromDefaults;
    // Заводская запись потерялась — ставим самый доступный модуль по размеру.
    const fallback = (data.modules[group] ?? [])
      .filter((module) => module.class === size)
      .sort((left, right) => Number(left.cost ?? 0) - Number(right.cost ?? 0))[0];
    return fallback ? moduleRef(fallback) : null;
  });

  const hardpointGroups = groupsOfSection(data, 'hardpoints');
  build.hardpoints = ship.slots.hardpoints.map(
    (_, index) => resolveDefault(data, ship.defaults?.hardpoints?.[index], hardpointGroups),
  );

  const internalGroups = groupsOfSection(data, 'internal');
  build.internal = ship.slots.internal.map(
    (_, index) => resolveDefault(data, ship.defaults?.internal?.[index], [...internalGroups, 'pas']),
  );

  return build;
}

/** Пустая сборка: корпус и ничего больше (удобно собирать «с нуля»). */
export function strippedBuild(data: OutfittingData, shipId: string): ShipBuild {
  const base = defaultBuild(data, shipId);
  return {
    ...base,
    hardpoints: base.hardpoints.map(() => null),
    internal: base.internal.map((entry, index) => {
      const slot = data.ships[shipId]?.slots.internal[index];
      // Комплект планетарной посадки снимать бессмысленно: он ничего не весит.
      return typeof slot === 'number' ? null : entry;
    }),
    mods: {},
  };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(text, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string {
  const base64 = code.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/** Компактный код сборки для ссылки. */
export function encodeBuild(build: ShipBuild): string {
  const compact = {
    s: build.ship,
    n: build.name || undefined,
    b: build.bulkhead,
    c: build.standard,
    h: build.hardpoints,
    i: build.internal,
    m: Object.keys(build.mods).length ? build.mods : undefined,
  };
  return toBase64Url(JSON.stringify(compact));
}

/** Разобрать код сборки; кривой код — это `null`, а не исключение. */
export function decodeBuild(code: string): ShipBuild | null {
  try {
    const parsed = JSON.parse(fromBase64Url(code));
    if (!parsed || typeof parsed.s !== 'string') return null;
    return {
      ship: parsed.s,
      name: typeof parsed.n === 'string' ? parsed.n : undefined,
      bulkhead: Number(parsed.b) || 0,
      standard: Array.isArray(parsed.c) ? parsed.c : [],
      hardpoints: Array.isArray(parsed.h) ? parsed.h : [],
      internal: Array.isArray(parsed.i) ? parsed.i : [],
      mods: parsed.m && typeof parsed.m === 'object' ? parsed.m : {},
    };
  } catch {
    return null;
  }
}

/** Русские названия чертежей: собираются из частей идентификатора Coriolis. */
const BLUEPRINT_WORDS: Record<string, string> = {
  Advanced: 'улучшенный',
  Armoured: 'бронированный',
  Boosted: 'усиленный',
  Charge: 'заряд',
  Cheap: 'дешёвый',
  Double: 'двойной',
  Dirty: 'форсированные',
  Efficient: 'экономичный',
  Explosive: 'противоосколочный',
  Expanded: 'расширенный',
  FastBoot: 'быстрый запуск',
  FastCharge: 'быстрый заряд',
  FastScan: 'быстрое сканирование',
  Focused: 'сфокусированный',
  Force: 'силовой',
  Heavy: 'тяжёлый',
  HeavyDuty: 'усиленный (heavy duty)',
  HighCapacity: 'ёмкий',
  Kinetic: 'противокинетический',
  Lightweight: 'облегчённый',
  LightWeight: 'облегчённый',
  LongRange: 'дальнобойный',
  Optimised: 'оптимизированный',
  Overcharged: 'форсированный',
  Penetrator: 'бронебойный',
  Rapid: 'скорострельный',
  RapidCharge: 'быстрая перезарядка',
  RapidFire: 'скорострельный',
  Reinforced: 'усиленный',
  Shielded: 'экранированный',
  Short: 'короткий',
  ShortRange: 'ближнего боя',
  Sturdy: 'прочный',
  Stealth: 'малозаметный',
  Strong: 'прочный',
  Thermic: 'противотермический',
  Thermal: 'термический',
  WideAngle: 'широкоугольный',
};

const BLUEPRINT_PREFIX: Record<string, string> = {
  AFM: 'AFMU',
  Armour: 'Броня',
  Engine: 'Двигатели',
  FSD: 'FSD',
  FSDinterdictor: 'Интердиктор',
  HullReinforcement: 'Усиление корпуса',
  Misc: 'Модуль',
  PowerPlant: 'Реактор',
  PowerDistributor: 'Распределитель',
  Sensor: 'Сенсоры',
  Scanner: 'Сканер',
  ShieldBooster: 'Усилитель щита',
  ShieldCellBank: 'Батарея щита',
  ShieldGenerator: 'Генератор щита',
  Weapon: 'Орудие',
};

/** «FSD_LongRange» → «FSD · дальнобойный». */
export function blueprintLabel(id: string): string {
  const [prefix, ...rest] = id.split('_');
  const head = BLUEPRINT_PREFIX[prefix] ?? prefix.replace(/([a-z])([A-Z])/g, '$1 $2');
  const tail = rest.map((part) => BLUEPRINT_WORDS[part] ?? part.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
  return tail.length ? `${head} · ${tail.join(' ')}` : head;
}

/** Человеческое имя модуля для списков: «3A Генератор щита». */
export function moduleLabel(data: OutfittingData, module: OutfittingModule | null): string {
  if (!module) return '—';
  const group = data.groups[module.grp]?.name ?? module.grp;
  const name = module.name && module.name !== group ? module.name : group;
  const mount = module.mount === 'G' ? ' (турель)' : module.mount === 'T' ? ' (наводящееся)' : module.mount === 'F' ? ' (фикс.)' : '';
  return `${module.class}${module.rating} ${name}${mount}`;
}
