/**
 * Контракт справочника верфи (`public/data/outfitting.json`).
 *
 * Файл собирает `scripts/build-outfitting-data.mjs` из открытого набора
 * Coriolis (`EDCD/coriolis-data`) — того же, на котором считает coriolis.io.
 * Здесь только описания типов: расчёты живут в `calc.ts`, сборка — в
 * `build.ts`, а страница верфи — в `src/app/outfitting`.
 */

/** Значение любого поля модуля: числа, строки и распределение урона. */
export type ModuleValue = number | string | boolean | PreEngineered | Record<string, number | boolean>;

/** Модуль верфи: id, класс, рейтинг и всё, что о нём знает игра. */
/**
 * Заводская настройка модуля (pre-engineered).
 *
 * Такие модули продаются уже модифицированными: чертёж и его уровень менять
 * нельзя, поэтому инженерия к ним не применяется. Экспериментальный эффект
 * иногда разрешён — это отдельное поле, а не «свободный» чертёж.
 */
export interface PreEngineered {
  /** Модуль нельзя переделать у инженера: выбор чертежа недоступен. */
  reengineerable?: boolean;
  /** Уровень заводской прокачки менять нельзя. */
  gradeChangeable?: boolean;
  /** Чертёж(и), с которыми модуль выходит с завода. */
  blueprints?: string[];
  /** Уровень заводской прокачки (обычно 5). */
  grade?: number;
  /** Разрешён ли экспериментальный эффект поверх заводской настройки. */
  canApplyExperimental?: boolean;
  /** Заводские экспериментальные эффекты, уже наложенные на модуль. */
  experimentalEffects?: string[];
  /**
   * Правки, для которых в наборе нет подходящего чертежа (например, у
   * MercGear из обновления «Operations»). Формат тот же, что у `features`
   * чертежа: поле → доля изменения.
   */
  features?: Record<string, number>;
  /**
   * Числа собраны по официальному описанию обновления, а не выгружены из
   * игры: интерфейс помечает такие модули знаком «≈».
   */
  approx?: boolean;
  /** Внутренний идентификатор рецепта Frontier — для справки и сверки. */
  recipe?: string;
  /** Английское описание из набора данных или патчноута. */
  description?: string;
  /** Особые условия получения (например, `CG` — награда за общинную цель). */
  availability?: string;
}

export interface OutfittingModule {
  id: string;
  grp: string;
  class: number;
  rating: string;
  name?: string;
  mass?: number;
  power?: number;
  cost?: number;
  integrity?: number;
  /** Крепление орудия: F — фиксированное, G — турель, T — наводящееся. */
  mount?: string;
  /** Пассивный модуль (утилиты, которые не требуют развёртывания). */
  passive?: number;
  /** Пометка из набора Coriolis: модуль ещё не разобран. */
  info?: string;
  /** Powerplay-модуль: доступен только за лояльность фракции. */
  pp?: string;
  /** Заводская настройка: чертежи, уровень и разрешённая эксперименталка. */
  preEngineered?: PreEngineered;
  /** Модуль продаётся за Merc Coin (валюта операций). */
  merc?: boolean;
  /** Цена в жетонах, если она известна. */
  coins?: number;
  /** Имя из набора данных до замены на официальное игровое. */
  sourceName?: string;
  [key: string]: ModuleValue | undefined;
}

/** Переборка (броня корпуса) — свои цифры у каждого корабля. */
export interface Bulkhead {
  id: string;
  grp: 'bh';
  name: string;
  cost: number;
  mass: number;
  hullboost: number;
  kinres: number;
  thermres: number;
  explres: number;
  causres?: number;
  /** Архивная броня недоступна для новой установки; индекс старых сборок сохраняется. */
  archived?: boolean;
}

/** Слот внутреннего отсека: обычный (число) или особый (военный, посадочный). */
export type InternalSlot = number | { class: number; name?: string; eligible?: Record<string, number> };

export interface ShipProperties {
  name: string;
  manufacturer: string;
  class: number;
  hullCost: number;
  speed: number;
  boost: number;
  boostEnergy: number;
  baseShieldStrength: number;
  baseArmour: number;
  heatCapacity: number;
  hardness: number;
  hullMass: number;
  masslock: number;
  pipSpeed: number;
  crew: number;
  reserveFuelCapacity: number;
  fighterHangars?: boolean;
  pitch?: number;
  roll?: number;
  yaw?: number;
  minthrust?: number;
}

export interface OutfittingShip {
  id: string;
  properties: ShipProperties;
  retailCost: number;
  bulkheads: Bulkhead[];
  slots: {
    /** Реактор, двигатели, FSD, жизнеобеспечение, распределитель, сенсоры, бак. */
    standard: number[];
    hardpoints: number[];
    internal: InternalSlot[];
  };
  defaults: {
    standard: (string | number)[];
    hardpoints: (string | number)[];
    internal: (string | number)[];
  };
}

/** Один уровень чертежа инженера. */
export interface BlueprintGrade {
  /** Свойство → [минимум, максимум] изменения. */
  features: Record<string, [number, number]>;
  /** Материалы на один прогон. */
  components: Record<string, number>;
}

export interface Blueprint {
  grades: Record<string, BlueprintGrade>;
}

/**
 * Экспериментальный эффект.
 *
 * `features` — поправки к полям модуля в соглашении Coriolis (см. `calc.ts`,
 * `applyFeature`): доли от базового значения, кроме `jitter` (абсолютные
 * градусы разброса) и `damagedist` (новое распределение урона по типам).
 * Отдельно стоит `rof`: это поправка к *интервалу* между выстрелами, она
 * применяется к полю `fireint`, поэтому «−2,9 %» интервала — это «+3 %»
 * скорострельности.
 *
 * Названия и описания не хранятся в данных: `kind` — ключ перевода в
 * `src/lib/i18n/outfittingSpecials.ts` (один и тот же эффект встречается у
 * разных групп модулей под разными id). `tag` — боевой эффект, который не
 * выражается числами («цель теряет захват», «перегрев цели»).
 */
export interface SpecialEffect {
  /** Английское название из набора Coriolis — запасной вариант для UI. */
  name: string;
  /** Ключ перевода названия и описания. */
  kind: string;
  /** Ключ перевода боевого эффекта без числового выражения. */
  tag?: string;
  features: Record<string, number | [number, number] | Record<string, number>>;
  components: Record<string, number>;
}

/** Как применяется изменение свойства. */
export interface ModificationRule {
  name: string;
  type: 'percentage' | 'numeric' | 'object';
  method: 'multiplicative' | 'additive' | 'overwrite';
  higherbetter: boolean;
  hidden?: boolean;
}

/** Какие чертежи доступны группе модулей и у каких инженеров. */
export interface ModuleBlueprintIndex {
  blueprints: Record<string, { grades: Record<string, { engineers: string[] }> }>;
  /** Свойства, которые вообще можно менять у группы. */
  modifications?: string[];
  /** Экспериментальные эффекты, доступные группе. */
  specials?: string[];
}

export interface OutfittingData {
  version: number;
  generatedAt: string;
  source: string;
  /** Версия административных изменений (исходный справочник остаётся version=1). */
  catalogRevision?: number;
  groups: Record<string, { name: string; short?: string; customName?: boolean; category: 'core' | 'internal' | 'hardpoint' | 'utility' }>;
  ships: Record<string, OutfittingShip>;
  modules: Record<string, OutfittingModule[]>;
  blueprints: Record<string, Blueprint>;
  moduleBlueprints: Record<string, ModuleBlueprintIndex>;
  specials: Record<string, SpecialEffect>;
  modifications: Record<string, ModificationRule>;
  /** Инженер → «группа:чертёж» → максимальный уровень. */
  engineers: Record<string, Record<string, number>>;
}

/** Инженерная доработка конкретного модуля в сборке. */
export interface SlotModification {
  blueprint?: string;
  grade?: number;
  /** Качество прогона 0..1: 0 — минимум диапазона, 1 — максимум. */
  quality?: number;
  special?: string;
}

/** Сборка корабля: что стоит в слотах и что доработано. */
export interface ShipBuild {
  ship: string;
  name?: string;
  /** Индекс переборки в `ship.bulkheads`. */
  bulkhead: number;
  standard: (string | null)[];
  hardpoints: (string | null)[];
  internal: (string | null)[];
  /** Ключ слота (`S0`, `H2`, `I4`) → доработка. */
  mods: Record<string, SlotModification>;
}

/** Слот сборки в удобном для интерфейса виде. */
export interface BuildSlot {
  key: string;
  section: 'standard' | 'hardpoints' | 'internal';
  index: number;
  class: number;
  /** Особое назначение слота: военный отсек, посадочный комплект. */
  special?: string;
  eligible?: Record<string, number>;
  /** Только эта группа модулей (основные слоты жёстко заданы). */
  group?: string;
  module: OutfittingModule | null;
  modification: SlotModification | null;
}

/** Состояние распределителя питания (пипки: SYS / ENG / WEP, максимум 4 на систему, сумма ≤ 6). */
export interface PipState {
  sys: number;
  eng: number;
  wep: number;
}

/** Разница характеристик корабля при установке альтернативного модуля. */
export interface ModuleComparisonDelta {
  massDelta: number;
  jumpRangeDelta: number;
  maxJumpRangeDelta: number;
  ladenJumpRangeDelta: number;
  speedDelta: number;
  boostDelta: number;
  shieldDelta: number;
  armourDelta: number;
  powerDeployedDelta: number;
  powerCapacityDelta: number;
  costDelta: number;
  cargoDelta: number;
  fuelDelta: number;
  passengersDelta: number;
}
