/**
 * Расчёт характеристик сборки корабля.
 *
 * Формулы — те же, что использует игра и coriolis.io:
 *
 *  * кривая «масса → множитель» (двигатели и щиты) —
 *    `multiplier = minMul + ((maxMass − mass)/(maxMass − minMass))^k · (maxMul − minMul)`,
 *    где `k` подобран так, чтобы в оптимальной массе получался `optMul`;
 *  * дальность прыжка — `(топливо/fuelmul)^(1/fuelpower) · optmass/масса`;
 *  * щит — база корабля × множитель генератора (по массе КОРПУСА) ×
 *    (1 + сумма усилителей) + плоские надбавки Стражей;
 *  * броня — база × (1 + бонус переборки) + плоские усиления.
 *
 * Модуль здесь — «эффективный»: сначала к нему применяется чертёж инженера
 * и экспериментальный эффект (`effectiveModule`), и только потом считается
 * масса, энергия и всё остальное. Иначе инженерная сборка показывала бы
 * стоковые цифры.
 */

import type {
  BuildSlot,
  ModificationRule,
  ModuleComparisonDelta,
  OutfittingData,
  OutfittingModule,
  OutfittingShip,
  PipState,
  ShipBuild,
  SlotModification,
} from './types';

/** Порядок основных слотов: он одинаков у всех кораблей. */
export const STANDARD_GROUPS = ['pp', 't', 'fsd', 'ls', 'pd', 's', 'ft'] as const;

/** Служебные записи набора Coriolis, которые не показываем в списках. */
function isRealModule(module: OutfittingModule): boolean {
  if (module.grp === 'mm' || module.grp === 'mh') return false;
  if (module.info) return false;
  if (module.rating === 'Z') return false;
  return true;
}

/** Индекс «id модуля → модуль» по всему справочнику. */
export function indexModules(data: OutfittingData): Map<string, OutfittingModule> {
  const index = new Map<string, OutfittingModule>();
  for (const [group, list] of Object.entries(data.modules)) {
    for (const module of list) index.set(`${group}:${module.id}`, module);
  }
  return index;
}

/** Найти модуль по группе и id (id уникальны только внутри группы). */
export function findModule(data: OutfittingData, group: string, id: string): OutfittingModule | null {
  return data.modules[group]?.find((module) => module.id === id) ?? null;
}

/** Разобрать ссылку «группа:id» из сборки. */
export function parseRef(ref: string | null | undefined): { group: string; id: string } | null {
  if (!ref) return null;
  const at = ref.indexOf(':');
  if (at < 0) return null;
  return { group: ref.slice(0, at), id: ref.slice(at + 1) };
}

export function moduleRef(module: OutfittingModule): string {
  return `${module.grp}:${module.id}`;
}

/** Модуль по ссылке из сборки. */
export function moduleOf(data: OutfittingData, ref: string | null | undefined): OutfittingModule | null {
  const parsed = parseRef(ref);
  return parsed ? findModule(data, parsed.group, parsed.id) : null;
}

/**
 * Кривая «масса → множитель» из игры.
 *
 * Лёгкий корабль получает `maxMul`, тяжёлый — `minMul`, в оптимальной массе
 * ровно `optMul`. Показатель степени подбирается так, чтобы кривая проходила
 * через оптимальную точку — именно это делают и двигатели, и щиты.
 */
export function massCurveMultiplier(
  mass: number,
  minMass: number,
  optMass: number,
  maxMass: number,
  minMul: number,
  optMul: number,
  maxMul: number,
): number {
  if (!(maxMass > minMass) || !(maxMul > minMul)) return optMul;
  const xnorm = Math.min(1, Math.max(0, (maxMass - mass) / (maxMass - minMass)));
  const optNorm = Math.min(1, Math.max(1e-6, (maxMass - optMass) / (maxMass - minMass)));
  const ratio = (optMul - minMul) / (maxMul - minMul);
  const exponent = Math.log(Math.max(1e-6, ratio)) / Math.log(optNorm);
  const ynorm = Math.pow(xnorm, exponent);
  return minMul + ynorm * (maxMul - minMul);
}

/** Правило применения свойства (по умолчанию — процентное умножение). */
export function ruleFor(data: OutfittingData, property: string): ModificationRule {
  return data.modifications[property] ?? {
    name: property,
    type: 'percentage',
    method: 'multiplicative',
    higherbetter: true,
  };
}

/** Сопротивления не складываются напрямую: прибавка идёт от «остатка». */
export const RESISTANCES = new Set(['kinres', 'thermres', 'explres', 'causres']);

/**
 * Применить одну поправку (чертежа или эксперимента) к полю модуля.
 *
 * Соглашение о числах — как в наборе Coriolis и в игре:
 *
 *  * сопротивления — доля *оставшегося* сопротивления: `base + v·(1 − base)`,
 *    поэтому +8 % к 50 % даёт 54 %, а не 58 %;
 *  * `hullboost`/`shieldboost` — сами по себе множители «+80 % к корпусу»,
 *    поэтому поправка умножает множитель целиком: `(1 + base)·(1 + v) − 1`;
 *  * `rof` хранится как поправка к *интервалу* между выстрелами, а у нас в
 *    справочнике это поле называется `fireint` — скорострельность растёт,
 *    когда интервал падает;
 *  * `damagedist` — не число, а новое распределение урона по типам;
 *  * остальное — по правилу из `modifications.json`: прибавка, перезапись
 *    или процент от базового значения.
 */
function applyFeature(
  data: OutfittingData,
  target: OutfittingModule,
  property: string,
  raw: number | Record<string, number> | [number, number],
): void {
  if (property === 'damagedist') {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) target.damagedist = { ...raw };
    return;
  }
  const value = Array.isArray(raw) ? raw[1] : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return;

  if (RESISTANCES.has(property)) {
    const base = Number(target[property] ?? 0);
    target[property] = base + value * (1 - base);
    return;
  }
  if (property === 'hullboost' || property === 'shieldboost') {
    const base = Number(target[property] ?? 0);
    target[property] = (1 + base) * (1 + value) - 1;
    return;
  }
  if (property === 'rof') {
    const base = Number(target.fireint ?? 0);
    if (base > 0) target.fireint = base * (1 + value);
    return;
  }

  const base = Number(target[property] ?? 0);
  switch (ruleFor(data, property).method) {
    case 'additive': target[property] = base + value; break;
    case 'overwrite': target[property] = value; break;
    default: target[property] = base * (1 + value); break;
  }
}

/**
 * Модуль с учётом чертежа инженера и экспериментального эффекта.
 *
 * `quality` — «насколько удачно легла доработка»: 0 — нижняя граница
 * диапазона уровня, 1 — верхняя (максимально прокачанный модификатор).
 */
export function effectiveModule(
  data: OutfittingData,
  module: OutfittingModule | null,
  modification: SlotModification | null | undefined,
): OutfittingModule | null {
  if (!module) return null;
  // Coriolis marks these as pre-engineered. Their factory engineering is part
  // of the module, not a user modification: apply it first and never replace
  // it with the blueprint selected in the build.
  const pre = module.preEngineered as unknown as {
    reengineerable?: boolean;
    blueprints?: string[];
    grade?: number;
    canApplyExperimental?: boolean;
  } | undefined;
  const factoryBlueprints = pre?.blueprints ?? [];
  const userBlueprint = pre?.reengineerable === false ? undefined : modification?.blueprint;
  const special = modification?.special && (!pre || pre.canApplyExperimental !== false)
    ? modification.special
    : undefined;
  if (!userBlueprint && !special && factoryBlueprints.length === 0) return module;
  const result: OutfittingModule = { ...module };

  const applyBlueprint = (id: string, gradeNumber: number) => {
    const grade = data.blueprints[id]?.grades?.[String(gradeNumber)];
    if (!grade) return;
    for (const [property, range] of Object.entries(grade.features)) {
      const [min, max] = range;
      applyFeature(data, result, property, max);
    }
  };
  for (const id of factoryBlueprints) applyBlueprint(id, pre?.grade ?? 1);

  const blueprint = userBlueprint ? data.blueprints[userBlueprint] : null;
  const grade = blueprint?.grades?.[String(modification?.grade ?? 1)];
  const quality = Math.min(1, Math.max(0, modification?.quality ?? 1));
  if (grade) {
    for (const [property, range] of Object.entries(grade.features)) {
      const [min, max] = range;
      applyFeature(data, result, property, min + (max - min) * quality);
    }
  }

  // Экспериментальный эффект ложится поверх чертежа — так же, как в игре.
  const specialEffect = special ? data.specials[special] : null;
  if (specialEffect) {
    for (const [property, raw] of Object.entries(specialEffect.features ?? {})) {
      applyFeature(data, result, property, raw);
    }
  }

  return result;
}

/** Слоты сборки в порядке отображения. */
export function buildSlots(data: OutfittingData, build: ShipBuild): BuildSlot[] {
  const ship = data.ships[build.ship];
  if (!ship) return [];
  const slots: BuildSlot[] = [];

  ship.slots.standard.forEach((size, index) => {
    slots.push({
      key: `S${index}`,
      section: 'standard',
      index,
      class: size,
      group: STANDARD_GROUPS[index],
      module: moduleOf(data, build.standard[index]),
      modification: build.mods[`S${index}`] ?? null,
    });
  });

  ship.slots.hardpoints.forEach((size, index) => {
    slots.push({
      key: `H${index}`,
      section: 'hardpoints',
      index,
      class: size,
      module: moduleOf(data, build.hardpoints[index]),
      modification: build.mods[`H${index}`] ?? null,
    });
  });

  ship.slots.internal.forEach((slot, index) => {
    const size = typeof slot === 'number' ? slot : slot.class;
    slots.push({
      key: `I${index}`,
      section: 'internal',
      index,
      class: size,
      special: typeof slot === 'number' ? undefined : slot.name,
      eligible: typeof slot === 'number' ? undefined : slot.eligible,
      module: moduleOf(data, build.internal[index]),
      modification: build.mods[`I${index}`] ?? null,
    });
  });

  return slots;
}

/** Модули, которые физически влезут в слот (без учёта энергии и денег). */
export function modulesForSlot(data: OutfittingData, ship: OutfittingShip, slot: BuildSlot): OutfittingModule[] {
  const result: OutfittingModule[] = [];
  const push = (list: OutfittingModule[] | undefined) => {
    for (const module of list ?? []) {
      if (!isRealModule(module)) continue;
      if (module.class > slot.class) continue;
      result.push(module);
    }
  };

  if (slot.section === 'standard') {
    const group = slot.group!;
    for (const module of data.modules[group] ?? []) {
      if (!isRealModule(module)) continue;
      // Топливный бак и «основные» модули меньшего класса ставить можно,
      // но реактор/двигатели/FSD меньшего класса — обычная практика
      // облегчения корабля, поэтому ограничение только сверху.
      if (module.class > slot.class) continue;
      result.push(module);
    }
    return result;
  }

  if (slot.section === 'hardpoints') {
    const utility = slot.class === 0;
    for (const [group, list] of Object.entries(data.modules)) {
      const meta = data.groups[group];
      if (!meta) continue;
      if (utility ? meta.category !== 'utility' : meta.category !== 'hardpoint') continue;
      push(list);
    }
    return result;
  }

  // Внутренние отсеки: обычные, военные (только усиления) и посадочный.
  for (const [group, list] of Object.entries(data.modules)) {
    const meta = data.groups[group];
    if (!meta) continue;
    if (slot.eligible) {
      if (!slot.eligible[group]) continue;
    } else if (meta.category !== 'internal' && group !== 'ft') {
      continue;
    } else if (group === 'pas') {
      // Комплект планетарной посадки живёт в своём слоте.
      continue;
    }
    if (group === 'fh' && !ship.properties.fighterHangars) continue;
    push(list);
  }
  return result;
}

export interface BuildStats {
  /** Масса корпуса с переборкой и модулями, без топлива и груза. */
  unladenMass: number;
  /** Масса с полным баком. */
  fuelledMass: number;
  /** Масса с полным баком и полным трюмом. */
  ladenMass: number;
  hullMass: number;
  cargo: number;
  fuel: number;
  /** Пассажирских мест во всех каютах. */
  passengers: number;
  cost: number;
  /** Дальность одного прыжка с полным баком (без груза). */
  jumpRange: number;
  /** Максимальная дальность прыжка (пустой бак, топлива ровно на прыжок). */
  maxJumpRange: number;
  /** Дальность прыжка с полным баком и полным трюмом. */
  ladenJumpRange: number;
  /** Суммарный запас хода на полном баке. */
  totalRange: number;
  speed: number;
  boost: number;
  ladenSpeed: number;
  ladenBoost: number;
  shield: number;
  shieldResistances: { kinetic: number; thermal: number; explosive: number };
  armour: number;
  armourResistances: { kinetic: number; thermal: number; explosive: number; caustic: number };
  /** Ёмкость реактора. */
  powerCapacity: number;
  /** Потребление со сложенными орудиями. */
  powerRetracted: number;
  /** Потребление с развёрнутыми орудиями. */
  powerDeployed: number;
  /** Ёмкости и скорости восстановления распределителя. */
  distributor: {
    sys: number;
    eng: number;
    wep: number;
    sysRate: number;
    engRate: number;
    wepRate: number;
  };
  boostEnergy: number;
  pipSpeed: number;
  masslock: number;
  /** Пустых слотов. */
  emptySlots: number;
  /** Модулей с инженерными доработками. */
  engineered: number;
  /** Сколько модулей несут экспериментальный эффект. */
  experimental: number;
  /** Ошибки сборки кодами — текст подставляет интерфейс на своём языке. */
  warnings: BuildWarning[];
}

/** Распределение пипок по умолчанию (2-2-2). */
export const DEFAULT_PIPS: PipState = { sys: 2, eng: 2, wep: 2 };

/** Уменьшение входящего урона щита при SYS пипках (0..60%). */
export function sysDamageResistance(pips: number): number {
  if (pips <= 0) return 0;
  const clamped = Math.min(4, Math.max(0, pips));
  return 0.6 * Math.pow(clamped / 4, 0.85);
}

/** Эффективная ёмкость щита с учётом SYS пипок (МДж). */
export function pipEffectiveShield(shield: number, sysPips: number): number {
  if (shield <= 0) return 0;
  const res = sysDamageResistance(sysPips);
  if (res >= 1) return shield;
  return shield / (1 - res);
}

/** Скорость с учётом ENG пипок. */
export function pipAdjustedSpeed(baseSpeed: number, pipSpeed: number | undefined, engPips: number): number {
  const factor = pipSpeed ?? 0.125;
  const pips = Math.min(4, Math.max(0, engPips));
  return baseSpeed * (1 - (4 - pips) * factor);
}

/** Восстановление подсистемы распределителя (МВт/с) при заданных пипках. */
export function pipRechargeRate(baseRate: number, pips: number): number {
  return (baseRate || 0) * (Math.min(4, Math.max(0, pips)) / 4);
}

/**
 * Проблема сборки. Расчёт не знает языка интерфейса, поэтому возвращает код
 * и, если нужно, число (например, нехватку мегаватт), а перевод собирает
 * `StatsPanel` через `t('outfitting.warn.…')`.
 */
export interface BuildWarning {
  code: 'shield' | 'power' | 'noFsd' | 'noThrusters' | 'overweight';
  value?: string;
}

interface SlotView {
  slot: BuildSlot;
  module: OutfittingModule | null;
}

function resolved(data: OutfittingData, build: ShipBuild): SlotView[] {
  return buildSlots(data, build).map((slot) => ({
    slot,
    module: effectiveModule(data, slot.module, slot.modification),
  }));
}

/** Дальность одного прыжка при указанной массе и доступном топливе. */
export function jumpDistance(fsd: OutfittingModule | null, mass: number, fuel: number, boost = 0): number {
  if (!fsd) return 0;
  const optMass = Number(fsd.optmass ?? 0);
  const fuelMul = Number(fsd.fuelmul ?? 0);
  const fuelPower = Number(fsd.fuelpower ?? 0);
  const maxFuel = Number(fsd.maxfuel ?? 0);
  if (!(optMass > 0) || !(fuelMul > 0) || !(fuelPower > 0) || !(mass > 0)) return 0;
  const used = Math.max(0, Math.min(maxFuel, fuel));
  if (used <= 0) return 0;
  return Math.pow(used / fuelMul, 1 / fuelPower) * (optMass / mass) + boost;
}

/** Суммарный запас хода: прыжки по полному баку, пока топливо не кончится. */
function totalRangeOf(fsd: OutfittingModule | null, unladenMass: number, fuel: number, boost = 0): number {
  if (!fsd || fuel <= 0) return 0;
  let remaining = fuel;
  let mass = unladenMass + fuel;
  let total = 0;
  for (let jump = 0; jump < 200 && remaining > 0.01; jump += 1) {
    const used = Math.min(Number(fsd.maxfuel ?? 0), remaining);
    if (used <= 0) break;
    total += jumpDistance(fsd, mass, used, boost);
    remaining -= used;
    mass -= used;
  }
  return total;
}

/** Множитель скорости двигателей для указанной массы. */
export function thrusterMultiplier(thrusters: OutfittingModule | null, mass: number): number {
  if (!thrusters) return 0;
  const minMass = Number(thrusters.minmass ?? 0);
  const optMass = Number(thrusters.optmass ?? 0);
  const maxMass = Number(thrusters.maxmass ?? 0);
  if (!(maxMass > 0)) return 1;
  return massCurveMultiplier(
    mass,
    minMass,
    optMass,
    maxMass,
    Number(thrusters.minmul ?? 0.8),
    Number(thrusters.optmul ?? 1),
    Number(thrusters.maxmul ?? 1.2),
  );
}

/** Полный расчёт сборки. */
export function computeStats(data: OutfittingData, build: ShipBuild): BuildStats {
  const ship = data.ships[build.ship];
  const warnings: BuildWarning[] = [];
  const empty: BuildStats = {
    unladenMass: 0, fuelledMass: 0, ladenMass: 0, hullMass: 0, cargo: 0, fuel: 0, passengers: 0, cost: 0,
    jumpRange: 0, maxJumpRange: 0, ladenJumpRange: 0, totalRange: 0,
    speed: 0, boost: 0, ladenSpeed: 0, ladenBoost: 0,
    shield: 0, shieldResistances: { kinetic: 0, thermal: 0, explosive: 0 },
    armour: 0, armourResistances: { kinetic: 0, thermal: 0, explosive: 0, caustic: 0 },
    powerCapacity: 0, powerRetracted: 0, powerDeployed: 0,
    distributor: { sys: 0, eng: 0, wep: 0, sysRate: 0, engRate: 0, wepRate: 0 },
    boostEnergy: 0, pipSpeed: 0.125,
    masslock: 0, emptySlots: 0, engineered: 0, experimental: 0, warnings,
  };
  if (!ship) return empty;

  const bulkheadRaw = ship.bulkheads[build.bulkhead] ?? ship.bulkheads[0];
  const bulkheadMod = build.mods.BH ?? null;
  const bulkhead = effectiveModule(data, bulkheadRaw as unknown as OutfittingModule, bulkheadMod);
  const views = resolved(data, build);

  let mass = ship.properties.hullMass + Number(bulkhead?.mass ?? 0);
  let cost = ship.properties.hullCost + Number(bulkheadRaw?.cost ?? 0);
  let cargo = 0;
  let fuel = 0;
  let passengers = 0;
  let powerCapacity = 0;
  let powerRetracted = 0;
  let powerDeployed = 0;
  let shieldBoost = 0;
  let shieldAddition = 0;
  let hullReinforcement = 0;
  let jumpBoost = 0;
  let emptySlots = 0;
  let engineered = bulkheadMod?.blueprint ? 1 : 0;
  let experimental = bulkheadMod?.special ? 1 : 0;
  const shieldRes = { kinetic: 0, thermal: 0, explosive: 0 };
  const distributor = { sys: 0, eng: 0, wep: 0, sysRate: 0, engRate: 0, wepRate: 0 };
  let armourRes = {
    kinetic: Number(bulkhead?.kinres ?? 0),
    thermal: Number(bulkhead?.thermres ?? 0),
    explosive: Number(bulkhead?.explres ?? 0),
    caustic: Number(bulkhead?.causres ?? 0),
  };

  let fsd: OutfittingModule | null = null;
  let thrusters: OutfittingModule | null = null;
  let shieldGenerator: OutfittingModule | null = null;

  for (const { slot, module } of views) {
    if (!module) {
      if (slot.section !== 'hardpoints') emptySlots += 1;
      continue;
    }
    if (slot.modification?.blueprint) engineered += 1;
    if (slot.modification?.special) experimental += 1;
    mass += Number(module.mass ?? 0);
    cost += Number(module.cost ?? 0);
    cargo += Number(module.cargo ?? 0);
    fuel += Number(module.fuel ?? 0);
    passengers += Number(module.passengers ?? 0);
    jumpBoost += Number(module.jumpboost ?? 0);
    hullReinforcement += Number(module.hullreinforcement ?? 0);
    shieldAddition += Number(module.shieldaddition ?? 0);

    if (module.grp === 'pp') powerCapacity += Number(module.pgen ?? 0);
    if (module.grp === 'pd') {
      distributor.sys += Number(module.syscap ?? 0);
      distributor.eng += Number(module.engcap ?? 0);
      distributor.wep += Number(module.wepcap ?? 0);
      distributor.sysRate += Number(module.sysrate ?? 0);
      distributor.engRate += Number(module.engrate ?? 0);
      distributor.wepRate += Number(module.weprate ?? 0);
    }
    if (module.grp === 'fsd') fsd = module;
    if (module.grp === 't') thrusters = module;
    if (module.grp === 'sg' || module.grp === 'bsg' || module.grp === 'psg') shieldGenerator = module;

    if (module.grp === 'sb') {
      shieldBoost += Number(module.shieldboost ?? 0);
      shieldRes.kinetic = combineResistance(shieldRes.kinetic, Number(module.kinres ?? 0));
      shieldRes.thermal = combineResistance(shieldRes.thermal, Number(module.thermres ?? 0));
      shieldRes.explosive = combineResistance(shieldRes.explosive, Number(module.explres ?? 0));
    }
    if (module.grp === 'hr' || module.grp === 'ghrp' || module.grp === 'mahr') {
      armourRes = {
        kinetic: combineResistance(armourRes.kinetic, Number(module.kinres ?? 0)),
        thermal: combineResistance(armourRes.thermal, Number(module.thermres ?? 0)),
        explosive: combineResistance(armourRes.explosive, Number(module.explres ?? 0)),
        caustic: combineResistance(armourRes.caustic, Number(module.causres ?? 0)),
      };
    }

    const power = Number(module.power ?? 0);
    if (power > 0) {
      powerDeployed += power;
      const isWeapon = data.groups[module.grp]?.category === 'hardpoint';
      if (!isWeapon || module.passive) powerRetracted += power;
    }
  }

  // Резерв топлива (для FSD он недоступен) в массу входит.
  const reserve = ship.properties.reserveFuelCapacity ?? 0;
  const unladenMass = mass + reserve;
  const fuelledMass = unladenMass + fuel;
  const ladenMass = fuelledMass + cargo;

  const jumpRange = jumpDistance(fsd, fuelledMass, fuel, jumpBoost);
  const maxJumpRange = jumpDistance(fsd, unladenMass + Math.min(fuel, Number(fsd?.maxfuel ?? 0)), fuel, jumpBoost);
  const ladenJumpRange = jumpDistance(fsd, ladenMass, fuel, jumpBoost);
  const totalRange = totalRangeOf(fsd, unladenMass, fuel, jumpBoost);

  const speedMul = thrusterMultiplier(thrusters, fuelledMass);
  const ladenMul = thrusterMultiplier(thrusters, ladenMass);

  const shieldMul = shieldGenerator
    ? massCurveMultiplier(
      ship.properties.hullMass,
      Number(shieldGenerator.minmass ?? 0),
      Number(shieldGenerator.optmass ?? 0),
      Number(shieldGenerator.maxmass ?? 0),
      Number(shieldGenerator.minmul ?? 0),
      Number(shieldGenerator.optmul ?? 1),
      Number(shieldGenerator.maxmul ?? 1),
    )
    : 0;
  const shield = shieldGenerator
    ? ship.properties.baseShieldStrength * shieldMul * (1 + shieldBoost) + shieldAddition
    : 0;
  if (shieldGenerator && ship.properties.hullMass > Number(shieldGenerator.maxmass ?? Infinity)) {
    warnings.push({ code: 'shield' });
  }
  if (shieldGenerator) {
    shieldRes.kinetic = combineResistance(shieldRes.kinetic, Number(shieldGenerator.kinres ?? 0));
    shieldRes.thermal = combineResistance(shieldRes.thermal, Number(shieldGenerator.thermres ?? 0));
    shieldRes.explosive = combineResistance(shieldRes.explosive, Number(shieldGenerator.explres ?? 0));
  }

  const armour = ship.properties.baseArmour * (1 + Number(bulkhead?.hullboost ?? 0)) + hullReinforcement;

  if (powerDeployed > powerCapacity) {
    warnings.push({ code: 'power', value: (powerDeployed - powerCapacity).toFixed(2) });
  }
  if (!fsd) warnings.push({ code: 'noFsd' });
  if (!thrusters) warnings.push({ code: 'noThrusters' });
  if (thrusters && ladenMass > Number(thrusters.maxmass ?? Infinity)) {
    warnings.push({ code: 'overweight' });
  }

  return {
    unladenMass, fuelledMass, ladenMass, hullMass: ship.properties.hullMass,
    cargo, fuel, passengers, cost,
    jumpRange, maxJumpRange, ladenJumpRange, totalRange,
    speed: ship.properties.speed * speedMul,
    boost: ship.properties.boost * speedMul,
    ladenSpeed: ship.properties.speed * ladenMul,
    ladenBoost: ship.properties.boost * ladenMul,
    shield, shieldResistances: shieldRes,
    armour, armourResistances: armourRes,
    powerCapacity, powerRetracted, powerDeployed,
    distributor,
    boostEnergy: Number(ship.properties.boostEnergy ?? 0),
    pipSpeed: Number(ship.properties.pipSpeed ?? 0.125),
    masslock: ship.properties.masslock,
    emptySlots, engineered, experimental, warnings,
  };
}

/** Расчёт влияния кандидата-модуля на текущую сборку (сравнение характеристик). */
export function computeModuleDelta(
  data: OutfittingData,
  build: ShipBuild,
  slot: BuildSlot,
  candidateModule: OutfittingModule | null,
): ModuleComparisonDelta {
  const currentStats = computeStats(data, build);
  const nextBuild: ShipBuild = {
    ...build,
    standard: [...build.standard],
    hardpoints: [...build.hardpoints],
    internal: [...build.internal],
    mods: { ...build.mods },
  };
  const nextRef = candidateModule ? moduleRef(candidateModule) : null;
  nextBuild[slot.section][slot.index] = nextRef;
  if (!nextRef) delete nextBuild.mods[slot.key];

  const nextStats = computeStats(data, nextBuild);

  return {
    massDelta: nextStats.unladenMass - currentStats.unladenMass,
    jumpRangeDelta: nextStats.jumpRange - currentStats.jumpRange,
    maxJumpRangeDelta: nextStats.maxJumpRange - currentStats.maxJumpRange,
    ladenJumpRangeDelta: nextStats.ladenJumpRange - currentStats.ladenJumpRange,
    speedDelta: nextStats.speed - currentStats.speed,
    boostDelta: nextStats.boost - currentStats.boost,
    shieldDelta: nextStats.shield - currentStats.shield,
    armourDelta: nextStats.armour - currentStats.armour,
    powerDeployedDelta: nextStats.powerDeployed - currentStats.powerDeployed,
    powerCapacityDelta: nextStats.powerCapacity - currentStats.powerCapacity,
    costDelta: nextStats.cost - currentStats.cost,
    cargoDelta: nextStats.cargo - currentStats.cargo,
    fuelDelta: nextStats.fuel - currentStats.fuel,
    passengersDelta: nextStats.passengers - currentStats.passengers,
  };
}

/** Сопротивления складываются «по остатку»: 40% и 40% дают не 80%, а 64%. */
function combineResistance(current: number, extra: number): number {
  if (!extra) return current;
  return 1 - (1 - current) * (1 - extra);
}

/** Чертежи, доступные группе модулей, с максимальным уровнем и инженерами. */
export function blueprintsForGroup(data: OutfittingData, group: string): {
  id: string;
  maxGrade: number;
  engineers: Record<number, string[]>;
}[] {
  const entry = data.moduleBlueprints[group];
  if (!entry) return [];
  return Object.entries(entry.blueprints ?? {}).map(([id, info]) => {
    const grades = Object.keys(info.grades ?? {}).map(Number).filter((value) => Number.isFinite(value));
    const engineers: Record<number, string[]> = {};
    for (const [grade, gradeInfo] of Object.entries(info.grades ?? {})) {
      engineers[Number(grade)] = gradeInfo.engineers ?? [];
    }
    return { id, maxGrade: grades.length ? Math.max(...grades) : 1, engineers };
  }).sort((left, right) => left.id.localeCompare(right.id));
}
