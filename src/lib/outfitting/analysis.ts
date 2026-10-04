/**
 * Боевая и ходовая аналитика сборки: вкладки «Атака», «Защита» и графики.
 *
 * Формулы повторяют coriolis.io (а значит и игру):
 *
 *  * скорострельность — `burst / ((burst − 1)/burstrof + fireint)`; у лучевых
 *    орудий интервала нет, их `damage`/`distdraw`/`thermload` уже посекундные,
 *    поэтому скорострельность считаем равной 1;
 *  * DPS — `damage × roundspershot × rof`, SDPS (с учётом перезарядки) —
 *    `(clip × damage) / (clip/rof + reload)`;
 *  * EPS — `distdraw × rof` (расход конденсатора WEP), HPS — `thermload × rof`;
 *  * сопротивления усилителей щита складываются мультипликативно и получают
 *    «затухание» выше 30 %: `mul = 0.7 − (0.7 − mul)/2`;
 *  * эффективная прочность = запас / (1 − суммарное сопротивление).
 *
 * Расчёты не знают про интерфейс: наружу уходят только числа, подписи
 * собирает компонент на языке пользователя.
 */

import {
  buildSlots,
  effectiveModule,
  jumpDistance,
  pipAdjustedSpeed,
  pipRechargeRate,
  sysDamageResistance,
  thrusterMultiplier,
} from './calc';
import type { BuildStats } from './calc';
import type {
  BuildSlot,
  OutfittingData,
  OutfittingModule,
  PipState,
  ShipBuild,
} from './types';

/** Типы урона игры: абсолютный, кинетический, термический, взрывной. */
export type DamageType = 'absolute' | 'kinetic' | 'thermal' | 'explosive';

export const DAMAGE_TYPES: DamageType[] = ['absolute', 'kinetic', 'thermal', 'explosive'];

/** Ключи распределения урона в наборе Coriolis. */
const DIST_KEYS: Record<DamageType, string> = {
  absolute: 'A',
  kinetic: 'K',
  thermal: 'T',
  explosive: 'E',
};

function numberOf(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Орудие ли это: у орудия всегда есть урон. */
export function isWeapon(data: OutfittingData, module: OutfittingModule | null): boolean {
  if (!module) return false;
  if (data.groups[module.grp]?.category !== 'hardpoint') return false;
  return numberOf(module.damage) > 0;
}

/**
 * Скорострельность, выстрелов в секунду.
 *
 * Лучевые орудия (нет `fireint`) стреляют непрерывно: у них в справочнике
 * посекундные значения, поэтому возвращаем 1 — умножение ничего не меняет.
 */
export function weaponRoF(module: OutfittingModule): number {
  const interval = numberOf(module.fireint);
  if (!(interval > 0)) return 1;
  const burst = Math.max(1, numberOf(module.burst, 1));
  const burstRoF = numberOf(module.burstrof);
  if (burst > 1 && burstRoF > 0) {
    return burst / ((burst - 1) / burstRoF + interval);
  }
  return 1 / interval;
}

export interface WeaponMetrics {
  /** Урон за один выстрел со всеми снарядами залпа. */
  damagePerShot: number;
  rof: number;
  /** Урон в секунду без учёта перезарядки. */
  dps: number;
  /** Урон в секунду с учётом перезарядки обоймы. */
  sdps: number;
  /** Расход конденсатора WEP, МВт. */
  eps: number;
  /** Тепловыделение в секунду. */
  hps: number;
  /** Урон на единицу энергии конденсатора. */
  dpe: number;
  /** Доли урона по типам. */
  distribution: Record<DamageType, number>;
  /** Урон в секунду по типам. */
  dpsByType: Record<DamageType, number>;
  sdpsByType: Record<DamageType, number>;
  clip: number;
  ammo: number;
  reload: number;
  /** Пробитие брони. */
  piercing: number;
  range: number;
  falloff: number;
  shotspeed: number;
  jitter: number;
  /** Секунд непрерывного огня до пустой обоймы. */
  clipTime: number;
  /** Секунд огня до полного расхода боезапаса (с перезарядками). */
  ammoTime: number;
}

const ZERO_DIST: Record<DamageType, number> = {
  absolute: 0, kinetic: 0, thermal: 0, explosive: 0,
};

/** Разложение урона по типам: по умолчанию весь урон термический. */
function damageDistribution(module: OutfittingModule): Record<DamageType, number> {
  const raw = module.damagedist;
  const result = { ...ZERO_DIST };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    let total = 0;
    for (const type of DAMAGE_TYPES) {
      const value = numberOf((raw as Record<string, number>)[DIST_KEYS[type]]);
      result[type] = value;
      total += value;
    }
    if (total > 0) {
      for (const type of DAMAGE_TYPES) result[type] /= total;
      return result;
    }
  }
  result.thermal = 1;
  return result;
}

/** Полные боевые цифры одного орудия. */
export function weaponMetrics(module: OutfittingModule): WeaponMetrics {
  const rof = weaponRoF(module);
  const rounds = Math.max(1, numberOf(module.roundspershot, 1));
  const damagePerShot = numberOf(module.damage) * rounds;
  const dps = damagePerShot * rof;
  const clip = numberOf(module.clip);
  const reload = numberOf(module.reload);
  const ammo = numberOf(module.ammo);
  const sdps = clip > 0 && reload > 0
    ? (clip * damagePerShot) / (clip / rof + reload)
    : dps;
  const eps = numberOf(module.distdraw) * rof;
  const hps = numberOf(module.thermload) * rof;
  const distribution = damageDistribution(module);

  const dpsByType = { ...ZERO_DIST };
  const sdpsByType = { ...ZERO_DIST };
  for (const type of DAMAGE_TYPES) {
    dpsByType[type] = dps * distribution[type];
    sdpsByType[type] = sdps * distribution[type];
  }

  const clipTime = clip > 0 ? clip / rof : Infinity;
  const shots = ammo > 0 ? ammo + clip : Infinity;
  const ammoTime = Number.isFinite(shots)
    ? shots / rof + (clip > 0 ? Math.max(0, Math.ceil(shots / clip) - 1) * reload : 0)
    : Infinity;

  return {
    damagePerShot,
    rof,
    dps,
    sdps,
    eps,
    hps,
    dpe: eps > 0 ? dps / eps : 0,
    distribution,
    dpsByType,
    sdpsByType,
    clip,
    ammo,
    reload,
    piercing: numberOf(module.piercing),
    range: numberOf(module.range),
    falloff: numberOf(module.falloff),
    shotspeed: numberOf(module.shotspeed),
    jitter: numberOf(module.jitter),
    clipTime,
    ammoTime,
  };
}

export interface WeaponEntry {
  slot: BuildSlot;
  module: OutfittingModule;
  metrics: WeaponMetrics;
}

export interface OffenceSummary {
  weapons: WeaponEntry[];
  dps: number;
  sdps: number;
  eps: number;
  hps: number;
  /** Урон на единицу энергии по всей сборке. */
  dpe: number;
  dpsByType: Record<DamageType, number>;
  sdpsByType: Record<DamageType, number>;
  /** Среднее пробитие, взвешенное по вкладу в DPS. */
  piercing: number;
  /** Самая короткая эффективная дистанция среди орудий, м. */
  minRange: number;
  /** Самая большая дистанция, м. */
  maxRange: number;
  /** Ёмкость конденсатора WEP, МДж. */
  wepCapacity: number;
  /** Восстановление WEP при текущих пипках, МВт. */
  wepRecharge: number;
  /** Секунд непрерывного огня (конденсатор + восстановление). */
  sustainTime: number;
  /** Урон, который удастся выдать за время работы конденсатора. */
  burstDamage: number;
}

/** Сводка по вооружению сборки при заданном распределении пипок. */
export function offenceSummary(
  data: OutfittingData,
  build: ShipBuild,
  stats: BuildStats,
  pips: PipState,
): OffenceSummary {
  const weapons: WeaponEntry[] = [];
  for (const slot of buildSlots(data, build)) {
    if (slot.section !== 'hardpoints' || slot.class === 0) continue;
    const module = effectiveModule(data, slot.module, slot.modification);
    if (!isWeapon(data, module)) continue;
    weapons.push({ slot, module: module!, metrics: weaponMetrics(module!) });
  }

  const dpsByType = { ...ZERO_DIST };
  const sdpsByType = { ...ZERO_DIST };
  let dps = 0;
  let sdps = 0;
  let eps = 0;
  let hps = 0;
  let piercingWeighted = 0;
  let minRange = Infinity;
  let maxRange = 0;

  for (const entry of weapons) {
    const m = entry.metrics;
    dps += m.dps;
    sdps += m.sdps;
    eps += m.eps;
    hps += m.hps;
    piercingWeighted += m.piercing * m.dps;
    if (m.range > 0) {
      minRange = Math.min(minRange, m.range);
      maxRange = Math.max(maxRange, m.range);
    }
    for (const type of DAMAGE_TYPES) {
      dpsByType[type] += m.dpsByType[type];
      sdpsByType[type] += m.sdpsByType[type];
    }
  }

  const wepCapacity = stats.distributor.wep;
  const wepRecharge = pipRechargeRate(stats.distributor.wepRate, pips.wep);
  const drain = eps - wepRecharge;
  const sustainTime = eps <= 0 ? Infinity : drain <= 0 ? Infinity : wepCapacity / drain;

  return {
    weapons,
    dps,
    sdps,
    eps,
    hps,
    dpe: eps > 0 ? dps / eps : 0,
    dpsByType,
    sdpsByType,
    piercing: dps > 0 ? piercingWeighted / dps : 0,
    minRange: Number.isFinite(minRange) ? minRange : 0,
    maxRange,
    wepCapacity,
    wepRecharge,
    sustainTime,
    burstDamage: Number.isFinite(sustainTime) ? dps * sustainTime : Infinity,
  };
}

/**
 * «Затухание» сопротивлений усилителей щита.
 *
 * Игра режет пополам всё, что сверх 30 % суммарного сопротивления от
 * усилителей: множитель урона ниже 0,7 подтягивается обратно.
 */
function dampenBoosterMultiplier(multiplier: number): number {
  if (multiplier >= 0.7) return multiplier;
  return 0.7 - (0.7 - multiplier) / 2;
}

export interface ResistanceSet {
  /** Доля срезанного урона 0..1 по типам. */
  kinetic: number;
  thermal: number;
  explosive: number;
  caustic: number;
}

export interface DefenceSummary {
  shield: {
    /** Запас щита от генератора, МДж. */
    generator: number;
    /** Прибавка усилителей, МДж. */
    boosters: number;
    /** Плоские прибавки Стражей, МДж. */
    addition: number;
    /** Полный «сырой» запас щита, МДж. */
    total: number;
    /** Запас батарей щита (SCB) за весь боезапас, МДж. */
    cells: number;
    /** Сопротивления без пипок. */
    resistances: ResistanceSet;
    /** Сопротивления с учётом текущих пипок SYS. */
    withPips: ResistanceSet;
    /**
     * Эффективная прочность по типам урона с учётом пипок, МДж.
     * `base` — среднее по кинетике, теплу и взрыву: так «эффективный щит»
     * считает coriolis.io.
     */
    effective: ResistanceSet & { base: number };
    /** МДж/с восстановления из рабочего состояния. */
    regen: number;
    /** МДж/с восстановления после падения щита. */
    brokenRegen: number;
    /** Секунд на подъём щита с нуля до 50 %. */
    recoverTime: number;
    /** Секунд на долив с 50 % до 100 %. */
    rechargeTime: number;
  };
  armour: {
    total: number;
    resistances: ResistanceSet;
    /** Эффективная прочность брони по типам урона; `base` — среднее. */
    effective: ResistanceSet & { base: number };
    /** Прочность модулей (Module Reinforcement). */
    moduleArmour: number;
    /** Доля урона, перенаправленного с модулей. */
    moduleProtection: number;
  };
  /** Суммарная «боевая живучесть»: щит + батареи + броня. */
  totalEffective: number;
}

function effectiveFor(base: number, resistance: number): number {
  const mul = 1 - resistance;
  if (mul <= 0.0001) return Infinity;
  return base / mul;
}

/** Сводка по защите сборки при заданном распределении пипок. */
export function defenceSummary(
  data: OutfittingData,
  build: ShipBuild,
  stats: BuildStats,
  pips: PipState,
): DefenceSummary {
  const slots = buildSlots(data, build);

  let generatorModule: OutfittingModule | null = null;
  let shieldAddition = 0;
  let cells = 0;
  let moduleArmour = 0;
  let moduleProtection = 0;

  // Множители урона от усилителей щита (меньше — лучше).
  let boosterKin = 1;
  let boosterTherm = 1;
  let boosterExpl = 1;
  let boostSum = 0;

  for (const slot of slots) {
    const module = effectiveModule(data, slot.module, slot.modification);
    if (!module) continue;

    if (module.grp === 'sg' || module.grp === 'bsg' || module.grp === 'psg') {
      generatorModule = module;
    }
    if (module.grp === 'gsrp') shieldAddition += numberOf(module.shieldaddition);
    if (module.grp === 'sb') {
      boostSum += numberOf(module.shieldboost);
      boosterKin *= 1 - numberOf(module.kinres);
      boosterTherm *= 1 - numberOf(module.thermres);
      boosterExpl *= 1 - numberOf(module.explres);
    }
    if (module.grp === 'scb') {
      const reinforcement = numberOf(module.shieldreinforcement);
      const duration = numberOf(module.duration, 1);
      const ammo = numberOf(module.ammo);
      cells += reinforcement * duration * (ammo + 1);
    }
    if (module.grp === 'mrp' || module.grp === 'gmrp') {
      moduleArmour += numberOf(module.integrity);
      moduleProtection = 1 - (1 - moduleProtection) * (1 - numberOf(module.protection));
    }
  }

  boosterKin = dampenBoosterMultiplier(boosterKin);
  boosterTherm = dampenBoosterMultiplier(boosterTherm);
  boosterExpl = dampenBoosterMultiplier(boosterExpl);

  const genKin = 1 - numberOf(generatorModule?.kinres);
  const genTherm = 1 - numberOf(generatorModule?.thermres);
  const genExpl = 1 - numberOf(generatorModule?.explres);

  const resistances: ResistanceSet = {
    kinetic: 1 - genKin * boosterKin,
    thermal: 1 - genTherm * boosterTherm,
    explosive: 1 - genExpl * boosterExpl,
    caustic: 0,
  };

  const sysRes = sysDamageResistance(pips.sys);
  const withPips: ResistanceSet = {
    kinetic: 1 - (1 - resistances.kinetic) * (1 - sysRes),
    thermal: 1 - (1 - resistances.thermal) * (1 - sysRes),
    explosive: 1 - (1 - resistances.explosive) * (1 - sysRes),
    caustic: sysRes,
  };

  const shieldTotal = stats.shield;
  const generatorPart = shieldTotal > 0
    ? Math.max(0, shieldTotal - shieldAddition) / (1 + boostSum)
    : 0;

  const regen = numberOf(generatorModule?.regen);
  const brokenRegen = numberOf(generatorModule?.brokenregen);

  const armourRes: ResistanceSet = {
    kinetic: stats.armourResistances.kinetic,
    thermal: stats.armourResistances.thermal,
    explosive: stats.armourResistances.explosive,
    caustic: stats.armourResistances.caustic,
  };

  // `base` — средняя эффективная прочность по трём основным типам урона:
  // именно её Coriolis показывает как «эффективный щит». Брать сюда сырой
  // запас нельзя, иначе подпись «с учётом пипок» обманывает.
  const shieldByType = {
    kinetic: effectiveFor(shieldTotal, withPips.kinetic),
    thermal: effectiveFor(shieldTotal, withPips.thermal),
    explosive: effectiveFor(shieldTotal, withPips.explosive),
    caustic: effectiveFor(shieldTotal, withPips.caustic),
  };
  const armourByType = {
    kinetic: effectiveFor(stats.armour, armourRes.kinetic),
    thermal: effectiveFor(stats.armour, armourRes.thermal),
    explosive: effectiveFor(stats.armour, armourRes.explosive),
    caustic: effectiveFor(stats.armour, armourRes.caustic),
  };

  const averageShield = shieldTotal > 0
    ? (shieldByType.kinetic + shieldByType.thermal + shieldByType.explosive) / 3
    : 0;
  const averageArmour = (armourByType.kinetic + armourByType.thermal + armourByType.explosive) / 3;

  const shieldEffective = { base: averageShield, ...shieldByType };
  const armourEffective = { base: averageArmour, ...armourByType };

  return {
    shield: {
      generator: generatorPart,
      boosters: shieldTotal > 0 ? Math.max(0, shieldTotal - shieldAddition) - generatorPart : 0,
      addition: shieldAddition,
      total: shieldTotal,
      cells,
      resistances,
      withPips,
      effective: shieldEffective,
      regen,
      brokenRegen,
      recoverTime: brokenRegen > 0 && shieldTotal > 0 ? (shieldTotal * 0.5) / brokenRegen : 0,
      rechargeTime: regen > 0 && shieldTotal > 0 ? (shieldTotal * 0.5) / regen : 0,
    },
    armour: {
      total: stats.armour,
      resistances: armourRes,
      effective: armourEffective,
      moduleArmour,
      moduleProtection,
    },
    totalEffective: averageShield + cells + averageArmour,
  };
}

/** Точка кривой «нагрузка → характеристики» для графиков. */
export interface LoadPoint {
  /** Тонн груза в трюме. */
  cargo: number;
  /** Тонн топлива в баке. */
  fuel: number;
  mass: number;
  jumpRange: number;
  speed: number;
  boost: number;
}

interface CoreModules {
  fsd: OutfittingModule | null;
  thrusters: OutfittingModule | null;
  jumpBoost: number;
}

/** Двигатели, FSD и прибавка к прыжку от бустеров Стражей. */
export function coreModules(data: OutfittingData, build: ShipBuild): CoreModules {
  let fsd: OutfittingModule | null = null;
  let thrusters: OutfittingModule | null = null;
  let jumpBoost = 0;
  for (const slot of buildSlots(data, build)) {
    const module = effectiveModule(data, slot.module, slot.modification);
    if (!module) continue;
    if (module.grp === 'fsd') fsd = module;
    if (module.grp === 't') thrusters = module;
    jumpBoost += numberOf(module.jumpboost);
  }
  return { fsd, thrusters, jumpBoost };
}

/** Характеристики сборки при произвольной загрузке трюма и бака. */
export function profileAt(
  data: OutfittingData,
  build: ShipBuild,
  stats: BuildStats,
  cargo: number,
  fuel: number,
  core?: CoreModules,
): LoadPoint {
  const ship = data.ships[build.ship];
  const parts = core ?? coreModules(data, build);
  const mass = stats.unladenMass + Math.max(0, cargo) + Math.max(0, fuel);
  const multiplier = thrusterMultiplier(parts.thrusters, mass);
  return {
    cargo,
    fuel,
    mass,
    jumpRange: jumpDistance(parts.fsd, mass, fuel, parts.jumpBoost),
    speed: (ship?.properties.speed ?? 0) * multiplier,
    boost: (ship?.properties.boost ?? 0) * multiplier,
  };
}

/** Кривая «груз → прыжок/скорость» от пустого трюма до полного. */
export function cargoCurve(
  data: OutfittingData,
  build: ShipBuild,
  stats: BuildStats,
  steps = 20,
): LoadPoint[] {
  const core = coreModules(data, build);
  const maxCargo = Math.max(stats.cargo, 1);
  const points: LoadPoint[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const cargo = (maxCargo * index) / steps;
    points.push(profileAt(data, build, stats, cargo, stats.fuel, core));
  }
  return points;
}

/** Кривая «топливо → прыжок» от пустого бака до полного. */
export function fuelCurve(
  data: OutfittingData,
  build: ShipBuild,
  stats: BuildStats,
  steps = 20,
): LoadPoint[] {
  const core = coreModules(data, build);
  const maxFuel = Math.max(stats.fuel, 0.1);
  const points: LoadPoint[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const fuel = (maxFuel * index) / steps;
    points.push(profileAt(data, build, stats, 0, fuel, core));
  }
  return points;
}

/** Скорость и буст при каждом положении пипок ENG (0..4). */
export function engPipCurve(stats: BuildStats): { pips: number; speed: number; boost: number }[] {
  const result: { pips: number; speed: number; boost: number }[] = [];
  for (let pips = 0; pips <= 4; pips += 1) {
    result.push({
      pips,
      speed: pipAdjustedSpeed(stats.speed, stats.pipSpeed, pips),
      boost: pipAdjustedSpeed(stats.boost, stats.pipSpeed, pips),
    });
  }
  return result;
}

/** Эффективная прочность щита при каждом положении пипок SYS. */
export function sysPipCurve(shield: number, baseResistance: number): { pips: number; value: number }[] {
  const result: { pips: number; value: number }[] = [];
  for (let pips = 0; pips <= 4; pips += 1) {
    const total = 1 - (1 - baseResistance) * (1 - sysDamageResistance(pips));
    result.push({ pips, value: shield > 0 ? effectiveFor(shield, total) : 0 });
  }
  return result;
}

/** Распределение стоимости сборки по разделам. */
export function costBreakdown(
  data: OutfittingData,
  build: ShipBuild,
): { key: string; value: number }[] {
  const ship = data.ships[build.ship];
  if (!ship) return [];
  const bulkhead = ship.bulkheads[build.bulkhead] ?? ship.bulkheads[0];
  const totals: Record<string, number> = {
    hull: ship.properties.hullCost + numberOf(bulkhead?.cost),
    core: 0,
    hardpoints: 0,
    utility: 0,
    internal: 0,
  };
  for (const slot of buildSlots(data, build)) {
    const cost = numberOf(slot.module?.cost);
    if (!cost) continue;
    if (slot.section === 'standard') totals.core += cost;
    else if (slot.section === 'hardpoints') totals[slot.class === 0 ? 'utility' : 'hardpoints'] += cost;
    else totals.internal += cost;
  }
  return Object.entries(totals)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({ key, value }));
}

/** Потребление энергии по разделам — для графика баланса реактора. */
export function powerBreakdown(
  data: OutfittingData,
  build: ShipBuild,
): { key: string; value: number }[] {
  const totals: Record<string, number> = { core: 0, hardpoints: 0, utility: 0, internal: 0 };
  for (const slot of buildSlots(data, build)) {
    const module = effectiveModule(data, slot.module, slot.modification);
    const power = numberOf(module?.power);
    if (!module || power <= 0) continue;
    if (module.grp === 'pp') continue;
    if (slot.section === 'standard') totals.core += power;
    else if (slot.section === 'hardpoints') totals[slot.class === 0 ? 'utility' : 'hardpoints'] += power;
    else totals.internal += power;
  }
  return Object.entries(totals)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({ key, value }));
}
