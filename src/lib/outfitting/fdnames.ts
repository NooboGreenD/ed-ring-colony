/**
 * Внутренние имена Frontier (`Int_…`, `Hpt_…`) для модулей и кораблей.
 *
 * Эти имена — общий язык всех инструментов Elite: их пишет игра в журнал
 * (событие `Loadout`), их понимают EDSY, Coriolis и Inara в формате SLEF.
 * В нашем справочнике их нет: скрипт сборки выбрасывает поле `symbol`, чтобы
 * файл был легче. Поэтому имя собирается по правилу «группа + класс +
 * рейтинг + подвес», одинаковому в обе стороны: один и тот же словарь
 * используется и для разбора чужого билда, и для выгрузки своего.
 *
 * Правило покрывает обычные модули. Редкие (предзаряженные награды за
 * общественные цели, Powerplay-варианты) имеют собственные имена и в выгрузку
 * не попадают — верфь честно показывает их список в предупреждении.
 */

import type { OutfittingModule } from './types';

/** Рейтинг → цифра класса в имени Frontier (A — лучший). */
const RATING_TO_CLASS: Record<string, number> = {
  A: 5, B: 4, C: 3, D: 2, E: 1, F: 1, G: 1, H: 1, I: 1,
};

const CLASS_TO_RATING: Record<number, string> = { 5: 'A', 4: 'B', 3: 'C', 2: 'D', 1: 'E' };

/** Класс пилона → слово размера в имени Frontier. */
const SIZE_WORDS = ['Tiny', 'Small', 'Medium', 'Large', 'Huge'];

const MOUNT_WORDS: Record<string, string> = { F: 'Fixed', G: 'Gimbal', T: 'Turret' };
const WORD_MOUNTS: Record<string, string> = { Fixed: 'F', Gimbal: 'G', Turret: 'T' };

/** Группа справочника → основа имени Frontier для внутренних модулей. */
const INTERNAL_BASE: Record<string, string> = {
  pp: 'Powerplant',
  t: 'Engine',
  fsd: 'Hyperdrive',
  ls: 'LifeSupport',
  pd: 'PowerDistributor',
  s: 'Sensors',
  ft: 'FuelTank',
  am: 'Repairer',
  bsg: 'ShieldGenerator',
  psg: 'ShieldGenerator',
  sg: 'ShieldGenerator',
  cr: 'CargoRack',
  cc: 'DroneControl_Collection',
  dtl: 'DroneControl_Decontamination',
  fx: 'DroneControl_FuelTransfer',
  hb: 'DroneControl_ResourceSiphon',
  pc: 'DroneControl_Prospector',
  rpl: 'DroneControl_Repair',
  rcpl: 'DroneControl_Recon',
  rsl: 'DroneControl_UnkVesselResearch',
  ews: 'ExpModuleStabiliser',
  fh: 'FighterBay',
  fi: 'FSDInterdictor',
  fs: 'FuelScoop',
  gfsb: 'GuardianFSDBooster',
  ghrp: 'GuardianHullReinforcement',
  gmrp: 'GuardianModuleReinforcement',
  gsrp: 'GuardianShieldReinforcement',
  hr: 'HullReinforcement',
  mahr: 'MetaAlloyHullReinforcement',
  mrp: 'ModuleReinforcement',
  pv: 'BuggyBay',
  rf: 'Refinery',
  scb: 'ShieldCellBank',
  pce: 'PassengerCabin',
  pci: 'PassengerCabin',
  pcm: 'PassengerCabin',
  pcq: 'PassengerCabin',
};

/** Модули с постоянным именем — без класса и рейтинга. */
const FIXED_INTERNAL: Record<string, string> = {
  pas: 'Int_PlanetApproachSuite',
  ss: 'Int_DetailedSurfaceScanner_Tiny',
  sua: 'Int_SupercruiseAssist',
};

/** Группа справочника → основа имени Frontier для орудий. */
const HARDPOINT_BASE: Record<string, string> = {
  pl: 'PulseLaser',
  ul: 'PulseLaserBurst',
  bl: 'BeamLaser',
  mc: 'MultiCannon',
  advmc: 'MultiCannon',
  c: 'Cannon',
  fc: 'SlugShot',
  rg: 'RailGun',
  pa: 'PlasmaAccelerator',
  ml: 'MiningLaser',
  abl: 'Mining_AbrBlstr',
  sdm: 'Mining_SubSurfDispMisle',
  scl: 'Mining_SeismChrgWarhd',
  nl: 'MineLauncher',
  tp: 'AdvancedTorpPylon',
  rfl: 'FlakMortar',
  tbrfl: 'FlechetteLauncher',
  tbem: 'CausticMissile',
  tbsc: 'PlasmaShockCannon',
  ggc: 'Guardian_GaussCannon',
  gpc: 'Guardian_PlasmaLauncher',
  gsc: 'Guardian_ShardCannon',
  axmc: 'ATMultiCannon',
  axmce: 'ATMultiCannon',
  axmr: 'ATDumbfireMissile',
  axmre: 'ATDumbfireMissile',
};

/** Утилиты с постоянным именем. */
const FIXED_UTILITY: Record<string, string> = {
  hs: 'Hpt_HeatSinkLauncher_Turret_Tiny',
  csl: 'Hpt_CausticSinkLauncher_Turret_Tiny',
  ch: 'Hpt_ChaffLauncher_Tiny',
  ec: 'Hpt_ElectronicCountermeasure_Tiny',
  po: 'Hpt_PlasmaPointDefence_Turret_Tiny',
  xs: 'Hpt_XenoScanner_Basic_Tiny',
  sfn: 'Hpt_AntiUnknownShutdown_Tiny',
};

/** Утилиты вида `Hpt_X_Size0_ClassN`. */
const SIZED_UTILITY: Record<string, string> = {
  sb: 'ShieldBooster',
  cs: 'CargoScanner',
  kw: 'CrimeScanner',
  ws: 'CloudScanner',
  pwa: 'MRAScanner',
};

/** Каюты: класс имени задаёт комфорт, а не рейтинг модуля. */
const CABIN_CLASS: Record<string, number> = { pce: 1, pci: 2, pcm: 3, pcq: 4 };

/**
 * Имя Frontier для модуля справочника.
 *
 * `null` — модуль с уникальным именем (награда за общественную цель,
 * Powerplay-вариант): вычислить его по правилу нельзя.
 */
export function moduleSymbol(module: OutfittingModule): string | null {
  const grp = module.grp;
  const size = module.class;
  const ratingClass = RATING_TO_CLASS[module.rating] ?? 1;

  if (FIXED_INTERNAL[grp]) return FIXED_INTERNAL[grp];
  if (FIXED_UTILITY[grp]) return FIXED_UTILITY[grp];

  if (SIZED_UTILITY[grp]) {
    return `Hpt_${SIZED_UTILITY[grp]}_Size0_Class${ratingClass}`;
  }

  if (HARDPOINT_BASE[grp]) {
    const mount = MOUNT_WORDS[module.mount ?? 'F'] ?? 'Fixed';
    const sizeWord = SIZE_WORDS[size] ?? 'Small';
    // У улучшенной мультипушки суффикс свой, у AX-версий — общий `_V2`.
    const suffix = grp === 'advmc' ? '_Advanced' : grp === 'axmce' || grp === 'axmre' ? '_V2' : '';
    return `Hpt_${HARDPOINT_BASE[grp]}_${mount}_${sizeWord}${suffix}`;
  }

  if (grp === 'mr') {
    const base = module.missile === 'D' ? 'DumbfireMissileRack' : 'BasicMissileRack';
    const mount = MOUNT_WORDS[module.mount ?? 'F'] ?? 'Fixed';
    return `Hpt_${base}_${mount}_${SIZE_WORDS[size] ?? 'Small'}`;
  }

  if (grp === 'mlc') {
    // Универсальные контроллеры дронов различаются набором функций, который в
    // справочнике не закодирован — уникальное имя не собрать.
    return null;
  }

  const base = INTERNAL_BASE[grp];
  if (!base) return null;

  if (grp === 'ft') return `Int_FuelTank_Size${size}_Class3`;
  if (grp === 'cr') return `Int_CargoRack_Size${size}_Class1`;
  if (grp === 'fh') return `Int_FighterBay_Size${size}_Class1`;
  if (grp === 'gfsb') return `Int_GuardianFSDBooster_Size${size}`;
  if (CABIN_CLASS[grp]) return `Int_PassengerCabin_Size${size}_Class${CABIN_CLASS[grp]}`;
  if (grp === 'bsg') return `Int_ShieldGenerator_Size${size}_Class${ratingClass}_Fast`;
  if (grp === 'psg') return `Int_ShieldGenerator_Size${size}_Class${ratingClass}_Strong`;

  return `Int_${base}_Size${size}_Class${ratingClass}`;
}

export interface ParsedSymbol {
  group: string;
  class: number;
  rating: string;
  mount?: string;
}

const INTERNAL_BY_BASE = new Map<string, string>();
for (const [grp, base] of Object.entries(INTERNAL_BASE)) {
  if (!INTERNAL_BY_BASE.has(base)) INTERNAL_BY_BASE.set(base, grp);
}
const HARDPOINT_BY_BASE = new Map<string, string>();
for (const [grp, base] of Object.entries(HARDPOINT_BASE)) {
  if (!HARDPOINT_BY_BASE.has(base)) HARDPOINT_BY_BASE.set(base, grp);
}
const UTILITY_BY_BASE = new Map<string, string>();
for (const [grp, base] of Object.entries(SIZED_UTILITY)) UTILITY_BY_BASE.set(base, grp);
const FIXED_BY_SYMBOL = new Map<string, string>();
for (const [grp, symbol] of Object.entries(FIXED_INTERNAL)) FIXED_BY_SYMBOL.set(symbol.toLowerCase(), grp);
for (const [grp, symbol] of Object.entries(FIXED_UTILITY)) FIXED_BY_SYMBOL.set(symbol.toLowerCase(), grp);

/** Разбор имени Frontier обратно в «группа + класс + рейтинг + подвес». */
export function parseSymbol(rawSymbol: string): ParsedSymbol | null {
  const symbol = rawSymbol.trim().replace(/_name;?$/i, '').replace(/^\$/, '');
  const lower = symbol.toLowerCase();

  const fixed = FIXED_BY_SYMBOL.get(lower);
  if (fixed) return { group: fixed, class: fixed === 'ss' ? 1 : 1, rating: fixed === 'ss' ? 'I' : 'I' };

  // Int_<Base>_Size<N>_Class<N>[_Fast|_Strong]
  const internal = /^int_(.+?)_size(\d+)_class(\d+)(_fast|_strong)?$/i.exec(symbol);
  if (internal) {
    const base = internal[1];
    const size = Number(internal[2]);
    const classNumber = Number(internal[3]);
    const variant = (internal[4] ?? '').toLowerCase();
    let group = INTERNAL_BY_BASE.get(base) ?? null;
    if (base.toLowerCase() === 'shieldgenerator') {
      group = variant === '_fast' ? 'bsg' : variant === '_strong' ? 'psg' : 'sg';
    }
    if (base.toLowerCase() === 'passengercabin') {
      group = ['pce', 'pci', 'pcm', 'pcq'][Math.max(0, Math.min(3, classNumber - 1))];
    }
    if (base.toLowerCase() === 'cargorack') group = 'cr';
    if (base.toLowerCase() === 'fueltank') return { group: 'ft', class: size, rating: 'C' };
    if (!group) {
      // Имена вроде `Int_DroneControl_Collection` нормализуем по префиксу.
      for (const [known, grp] of INTERNAL_BY_BASE) {
        if (base.toLowerCase().startsWith(known.toLowerCase())) { group = grp; break; }
      }
    }
    if (!group) return null;
    return { group, class: size, rating: CLASS_TO_RATING[classNumber] ?? 'E' };
  }

  const booster = /^int_guardianfsdbooster_size(\d+)$/i.exec(symbol);
  if (booster) return { group: 'gfsb', class: Number(booster[1]), rating: 'H' };

  // Hpt_<Base>_Size0_Class<N>
  const utility = /^hpt_(.+?)_size0_class(\d+)$/i.exec(symbol);
  if (utility) {
    const group = UTILITY_BY_BASE.get(utility[1]) ?? null;
    if (!group) return null;
    return { group, class: 0, rating: CLASS_TO_RATING[Number(utility[2])] ?? 'E' };
  }

  // Hpt_<Base>_<Mount>_<Size>[_V2|_Advanced]
  const hardpoint = /^hpt_(.+?)_(fixed|gimbal|turret)_(tiny|small|medium|large|huge)(_v2|_advanced)?$/i.exec(symbol);
  if (hardpoint) {
    const base = hardpoint[1];
    const mount = WORD_MOUNTS[hardpoint[2][0].toUpperCase() + hardpoint[2].slice(1).toLowerCase()] ?? 'F';
    const size = SIZE_WORDS.findIndex((word) => word.toLowerCase() === hardpoint[3].toLowerCase());
    const variant = (hardpoint[4] ?? '').toLowerCase();
    let group = HARDPOINT_BY_BASE.get(base) ?? null;
    if (/^basicmissilerack$/i.test(base) || /^dumbfiremissilerack$/i.test(base)) group = 'mr';
    if (/^multicannon$/i.test(base) && variant === '_advanced') group = 'advmc';
    if (/^atmulticannon$/i.test(base) && variant === '_v2') group = 'axmce';
    if (/^atdumbfiremissile$/i.test(base) && variant === '_v2') group = 'axmre';
    if (!group) {
      for (const [known, grp] of HARDPOINT_BY_BASE) {
        if (base.toLowerCase() === known.toLowerCase()) { group = grp; break; }
      }
    }
    if (!group) return null;
    return { group, class: size < 0 ? 1 : size, rating: 'E', mount };
  }

  return null;
}

/**
 * Идентификатор корабля Frontier ↔ идентификатор набора Coriolis.
 *
 * Совпадают не все: у Frontier исторические имена вроде `federation_corvette`
 * и `typex_3`. Корабли, которых нет в таблице, выгружаются и читаются по
 * идентификатору Coriolis — он совпадает с игровым чаще, чем нет.
 */
export const SHIP_FD_TO_CORIOLIS: Record<string, string> = {
  adder: 'adder',
  typex: 'alliance_chieftain',
  typex_2: 'alliance_crusader',
  typex_3: 'alliance_challenger',
  anaconda: 'anaconda',
  asp: 'asp',
  asp_scout: 'asp_scout',
  belugaliner: 'beluga',
  cobramkiii: 'cobra_mk_iii',
  cobramkiv: 'cobra_mk_iv',
  cobramkv: 'cobramkv',
  corsair: 'imperial_corsair',
  diamondback: 'diamondback',
  diamondbackxl: 'diamondback_explorer',
  dolphin: 'dolphin',
  eagle: 'eagle',
  federation_dropship_mkii: 'federal_assault_ship',
  federation_corvette: 'federal_corvette',
  federation_dropship: 'federal_dropship',
  federation_gunship: 'federal_gunship',
  ferdelance: 'fer_de_lance',
  hauler: 'hauler',
  empire_trader: 'imperial_clipper',
  empire_courier: 'imperial_courier',
  cutter: 'imperial_cutter',
  empire_eagle: 'imperial_eagle',
  independant_trader: 'keelback',
  krait_mkii: 'krait_mkii',
  krait_light: 'krait_phantom',
  mamba: 'mamba',
  mandalay: 'mandalay',
  orca: 'orca',
  panthermkii: 'panthermkii',
  python: 'python',
  python_nx: 'python_nx',
  sidewinder: 'sidewinder',
  type6: 'type_6_transporter',
  type7: 'type_7_transport',
  type8: 'type_8_transport',
  type9: 'type_9_heavy',
  type9_military: 'type_10_defender',
  viper: 'viper',
  viper_mkiv: 'viper_mk_iv',
  vulture: 'vulture',
};

const CORIOLIS_TO_SHIP_FD: Record<string, string> = {};
for (const [fd, coriolis] of Object.entries(SHIP_FD_TO_CORIOLIS)) CORIOLIS_TO_SHIP_FD[coriolis] = fd;

/** Игровое имя корабля по идентификатору Coriolis. */
export function shipFdName(coriolisId: string): string {
  return CORIOLIS_TO_SHIP_FD[coriolisId] ?? coriolisId;
}

/** Идентификатор Coriolis по игровому имени корабля. */
export function shipCoriolisId(fdName: string): string {
  const key = fdName.trim().toLowerCase();
  return SHIP_FD_TO_CORIOLIS[key] ?? key;
}

/** Имя переборки в журнале: `<корабль>_armour_<вариант>`. */
export function bulkheadSymbol(coriolisShipId: string, index: number): string {
  const variants = ['grade1', 'grade2', 'grade3', 'mirrored', 'reactive'];
  return `${shipFdName(coriolisShipId)}_armour_${variants[index] ?? 'grade1'}`;
}

/** Индекс переборки по имени из журнала. */
export function bulkheadIndex(symbol: string): number {
  const variants = ['grade1', 'grade2', 'grade3', 'mirrored', 'reactive'];
  const lower = symbol.toLowerCase();
  const found = variants.findIndex((variant) => lower.endsWith(variant));
  return found < 0 ? 0 : found;
}
