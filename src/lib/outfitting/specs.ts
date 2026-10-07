/**
 * Словарь параметров модуля: подпись, единица измерения, точность и раздел.
 *
 * Нужен в двух местах: всплывающая подсказка со всеми цифрами модуля и
 * переключатель «что показывать в строке слота» (масса / энергия /
 * характеристики / цена).
 *
 * Подписи живут здесь, а не в общем словаре интерфейса, по той же причине,
 * что и названия групп модулей в `i18n.ts`: это словарь справочника, он нужен
 * функциям вне React и меняется вместе с набором данных Coriolis. Параметров
 * около восьмидесяти, и это игровой жаргон, поэтому держим русский и
 * английский варианты, а остальные языки показывают английский.
 */

/** Раздел параметра — он же вариант фильтра отображения. */
export type SpecSection = 'mass' | 'power' | 'perf' | 'price';

export interface SpecDef {
  /** Поле модуля в справочнике. */
  key: string;
  section: SpecSection;
  /** Единица измерения (уже переведённая, одинакова во всех языках). */
  unit?: string;
  digits?: number;
  /** Значение в долях, показываем процентами. */
  percent?: boolean;
  /** Больше — лучше (для раскраски дельты). */
  higherBetter?: boolean;
}

/**
 * Порядок важен: подсказка и строка слота показывают параметры именно в этом
 * порядке, от «общих» к «узким».
 */
export const MODULE_SPECS: SpecDef[] = [
  // ── Масса и габариты ──
  { key: 'mass', section: 'mass', unit: 't', digits: 2, higherBetter: false },
  { key: 'integrity', section: 'mass', digits: 0, higherBetter: true },
  { key: 'boot', section: 'mass', unit: 's', digits: 1, higherBetter: false },

  // ── Энергия ──
  { key: 'power', section: 'power', unit: 'MW', digits: 2, higherBetter: false },
  { key: 'pgen', section: 'power', unit: 'MW', digits: 2, higherBetter: true },
  { key: 'eff', section: 'power', digits: 2, higherBetter: false },
  { key: 'activepower', section: 'power', unit: 'MW', digits: 2, higherBetter: false },
  { key: 'distdraw', section: 'power', unit: 'MJ', digits: 2, higherBetter: false },
  { key: 'thermload', section: 'power', digits: 2, higherBetter: false },
  { key: 'syscap', section: 'power', unit: 'MJ', digits: 1, higherBetter: true },
  { key: 'engcap', section: 'power', unit: 'MJ', digits: 1, higherBetter: true },
  { key: 'wepcap', section: 'power', unit: 'MJ', digits: 1, higherBetter: true },
  { key: 'sysrate', section: 'power', unit: 'MW/s', digits: 2, higherBetter: true },
  { key: 'engrate', section: 'power', unit: 'MW/s', digits: 2, higherBetter: true },
  { key: 'weprate', section: 'power', unit: 'MW/s', digits: 2, higherBetter: true },

  // ── Характеристики ──
  { key: 'damage', section: 'perf', digits: 2, higherBetter: true },
  { key: 'fireint', section: 'perf', unit: 's', digits: 2, higherBetter: false },
  { key: 'burst', section: 'perf', digits: 0, higherBetter: true },
  { key: 'burstrof', section: 'perf', unit: '/s', digits: 1, higherBetter: true },
  { key: 'roundspershot', section: 'perf', digits: 0, higherBetter: true },
  { key: 'clip', section: 'perf', digits: 0, higherBetter: true },
  { key: 'ammo', section: 'perf', digits: 0, higherBetter: true },
  { key: 'reload', section: 'perf', unit: 's', digits: 1, higherBetter: false },
  { key: 'piercing', section: 'perf', digits: 0, higherBetter: true },
  { key: 'jitter', section: 'perf', unit: '°', digits: 2, higherBetter: false },
  { key: 'range', section: 'perf', unit: 'm', digits: 0, higherBetter: true },
  { key: 'falloff', section: 'perf', unit: 'm', digits: 0, higherBetter: true },
  { key: 'shotspeed', section: 'perf', unit: 'm/s', digits: 0, higherBetter: true },
  { key: 'breachdmg', section: 'perf', digits: 2, higherBetter: true },
  { key: 'breachmin', section: 'perf', percent: true, digits: 0, higherBetter: true },
  { key: 'breachmax', section: 'perf', percent: true, digits: 0, higherBetter: true },
  { key: 'charge', section: 'perf', unit: 's', digits: 2, higherBetter: false },
  { key: 'chargetime', section: 'perf', unit: 's', digits: 2, higherBetter: false },
  { key: 'chargeup', section: 'perf', unit: 's', digits: 1, higherBetter: false },
  { key: 'cooldown', section: 'perf', unit: 's', digits: 1, higherBetter: false },

  { key: 'optmass', section: 'perf', unit: 't', digits: 0, higherBetter: true },
  { key: 'minmass', section: 'perf', unit: 't', digits: 0, higherBetter: false },
  { key: 'maxmass', section: 'perf', unit: 't', digits: 0, higherBetter: true },
  { key: 'optmul', section: 'perf', digits: 2, higherBetter: true },
  { key: 'minmul', section: 'perf', digits: 2, higherBetter: true },
  { key: 'maxmul', section: 'perf', digits: 2, higherBetter: true },
  { key: 'optmulspeed', section: 'perf', digits: 2, higherBetter: true },
  { key: 'optmulrotation', section: 'perf', digits: 2, higherBetter: true },
  { key: 'optmulacceleration', section: 'perf', digits: 2, higherBetter: true },

  { key: 'maxfuel', section: 'perf', unit: 't', digits: 2, higherBetter: true },
  { key: 'fuelmul', section: 'perf', digits: 3, higherBetter: true },
  { key: 'fuelpower', section: 'perf', digits: 2, higherBetter: false },
  { key: 'fuel', section: 'perf', unit: 't', digits: 1, higherBetter: true },
  { key: 'cargo', section: 'perf', unit: 't', digits: 0, higherBetter: true },
  { key: 'passengers', section: 'perf', digits: 0, higherBetter: true },
  { key: 'bins', section: 'perf', digits: 0, higherBetter: true },
  { key: 'bays', section: 'perf', digits: 0, higherBetter: true },
  { key: 'rebuildsperbay', section: 'perf', digits: 0, higherBetter: true },
  { key: 'rate', section: 'perf', unit: 'kg/s', digits: 2, higherBetter: true },
  { key: 'jumpboost', section: 'perf', unit: 'ly', digits: 2, higherBetter: true },

  { key: 'hullboost', section: 'perf', percent: true, digits: 0, higherBetter: true },
  { key: 'shieldboost', section: 'perf', percent: true, digits: 1, higherBetter: true },
  { key: 'shieldaddition', section: 'perf', unit: 'MJ', digits: 0, higherBetter: true },
  { key: 'shieldreinforcement', section: 'perf', unit: 'MJ/s', digits: 1, higherBetter: true },
  { key: 'hullreinforcement', section: 'perf', digits: 0, higherBetter: true },
  { key: 'protection', section: 'perf', percent: true, digits: 0, higherBetter: true },
  { key: 'regen', section: 'perf', unit: 'MJ/s', digits: 2, higherBetter: true },
  { key: 'brokenregen', section: 'perf', unit: 'MJ/s', digits: 2, higherBetter: true },
  { key: 'kinres', section: 'perf', percent: true, digits: 1, higherBetter: true },
  { key: 'thermres', section: 'perf', percent: true, digits: 1, higherBetter: true },
  { key: 'explres', section: 'perf', percent: true, digits: 1, higherBetter: true },
  { key: 'causres', section: 'perf', percent: true, digits: 1, higherBetter: true },

  { key: 'duration', section: 'perf', unit: 's', digits: 1, higherBetter: true },
  { key: 'spinup', section: 'perf', unit: 's', digits: 1, higherBetter: false },
  { key: 'repair', section: 'perf', digits: 0, higherBetter: true },
  { key: 'maximum', section: 'perf', digits: 0, higherBetter: true },
  { key: 'time', section: 'perf', unit: 's', digits: 0, higherBetter: true },
  { key: 'drain', section: 'perf', digits: 0, higherBetter: true },
  { key: 'proberadius', section: 'perf', digits: 2, higherBetter: true },
  { key: 'scanrange', section: 'perf', unit: 'm', digits: 0, higherBetter: true },
  { key: 'scantime', section: 'perf', unit: 's', digits: 1, higherBetter: false },
  { key: 'hacktime', section: 'perf', unit: 's', digits: 1, higherBetter: false },
  { key: 'angle', section: 'perf', unit: '°', digits: 0, higherBetter: true },
  { key: 'maxangle', section: 'perf', unit: '°', digits: 0, higherBetter: true },
  { key: 'facinglimit', section: 'perf', unit: '°', digits: 0, higherBetter: true },
  { key: 'ranget', section: 'perf', unit: 's', digits: 0, higherBetter: true },

  // ── Деньги ──
  { key: 'cost', section: 'price', unit: 'CR', digits: 0, higherBetter: false },
  { key: 'ammocost', section: 'price', unit: 'CR', digits: 0, higherBetter: false },
  { key: 'fightercost', section: 'price', unit: 'CR', digits: 0, higherBetter: false },
];

const BY_KEY = new Map(MODULE_SPECS.map((spec) => [spec.key, spec]));

export function specFor(key: string): SpecDef | undefined {
  return BY_KEY.get(key);
}

/** Подписи параметров: русский и английский (остальные языки — английский). */
const SPEC_NAMES: Record<string, Record<string, string>> = {
  ru: {
    mass: 'Масса', integrity: 'Прочность', boot: 'Запуск',
    power: 'Потребление', pgen: 'Выработка', eff: 'Теплоэффективность',
    activepower: 'Потребление в работе', distdraw: 'Расход WEP', thermload: 'Тепло',
    syscap: 'Ёмкость SYS', engcap: 'Ёмкость ENG', wepcap: 'Ёмкость WEP',
    sysrate: 'Зарядка SYS', engrate: 'Зарядка ENG', weprate: 'Зарядка WEP',
    damage: 'Урон', fireint: 'Интервал выстрела', burst: 'Выстрелов в очереди',
    burstrof: 'Темп в очереди', roundspershot: 'Снарядов в залпе', clip: 'Обойма',
    ammo: 'Боезапас', reload: 'Перезарядка', piercing: 'Пробитие', jitter: 'Разброс',
    range: 'Дальность', falloff: 'Начало спада', shotspeed: 'Скорость снаряда',
    breachdmg: 'Урон по модулям', breachmin: 'Пробой: минимум', breachmax: 'Пробой: максимум',
    charge: 'Зарядка выстрела', chargetime: 'Время заряда', chargeup: 'Раскрутка',
    cooldown: 'Откат',
    optmass: 'Оптимальная масса', minmass: 'Минимальная масса', maxmass: 'Максимальная масса',
    optmul: 'Множитель (опт.)', minmul: 'Множитель (мин.)', maxmul: 'Множитель (макс.)',
    optmulspeed: 'Множитель скорости', optmulrotation: 'Множитель вращения',
    optmulacceleration: 'Множитель ускорения',
    maxfuel: 'Топлива на прыжок', fuelmul: 'Множитель топлива', fuelpower: 'Степень топлива',
    fuel: 'Ёмкость бака', cargo: 'Трюм', passengers: 'Пассажиры', bins: 'Бункеры',
    bays: 'Ангары', rebuildsperbay: 'Сборок на ангар', rate: 'Скорость набора',
    jumpboost: 'Прибавка к прыжку',
    hullboost: 'Бонус к броне',
    shieldboost: 'Усиление щита', shieldaddition: 'Прибавка щита',
    shieldreinforcement: 'Восстановление щита', hullreinforcement: 'Усиление корпуса',
    protection: 'Защита модулей', regen: 'Регенерация', brokenregen: 'Регенерация после сбоя',
    kinres: 'Сопр. кинетике', thermres: 'Сопр. теплу', explres: 'Сопр. взрыву',
    causres: 'Сопр. кислоте',
    duration: 'Длительность', spinup: 'Раскрутка', repair: 'Ремонтный запас',
    maximum: 'Максимум', time: 'Время работы', drain: 'Сброс тепла',
    proberadius: 'Радиус зондов', scanrange: 'Дальность скана', scantime: 'Время скана',
    hacktime: 'Время взлома', angle: 'Угол', maxangle: 'Максимальный угол',
    facinglimit: 'Сектор наведения', ranget: 'Время до цели',
    cost: 'Цена', ammocost: 'Цена боекомплекта', fightercost: 'Цена истребителя',
  },
  en: {
    mass: 'Mass', integrity: 'Integrity', boot: 'Boot time',
    power: 'Power draw', pgen: 'Power generated', eff: 'Heat efficiency',
    activepower: 'Active power', distdraw: 'WEP draw', thermload: 'Thermal load',
    syscap: 'SYS capacity', engcap: 'ENG capacity', wepcap: 'WEP capacity',
    sysrate: 'SYS recharge', engrate: 'ENG recharge', weprate: 'WEP recharge',
    damage: 'Damage', fireint: 'Fire interval', burst: 'Burst size',
    burstrof: 'Burst rate', roundspershot: 'Rounds per shot', clip: 'Clip',
    ammo: 'Ammo', reload: 'Reload', piercing: 'Armour piercing', jitter: 'Jitter',
    range: 'Range', falloff: 'Falloff', shotspeed: 'Shot speed',
    breachdmg: 'Breach damage', breachmin: 'Breach min', breachmax: 'Breach max',
    charge: 'Charge', chargetime: 'Charge time', chargeup: 'Spin up', cooldown: 'Cooldown',
    optmass: 'Optimal mass', minmass: 'Minimum mass', maxmass: 'Maximum mass',
    optmul: 'Optimal multiplier', minmul: 'Minimum multiplier', maxmul: 'Maximum multiplier',
    optmulspeed: 'Speed multiplier', optmulrotation: 'Rotation multiplier',
    optmulacceleration: 'Acceleration multiplier',
    maxfuel: 'Max fuel per jump', fuelmul: 'Fuel multiplier', fuelpower: 'Fuel power',
    fuel: 'Fuel capacity', cargo: 'Cargo', passengers: 'Passengers', bins: 'Bins',
    bays: 'Bays', rebuildsperbay: 'Rebuilds per bay', rate: 'Refuel rate',
    jumpboost: 'Jump boost',
    hullboost: 'Hull boost',
    shieldboost: 'Shield boost', shieldaddition: 'Shield addition',
    shieldreinforcement: 'Shield reinforcement', hullreinforcement: 'Hull reinforcement',
    protection: 'Module protection', regen: 'Regeneration', brokenregen: 'Broken regeneration',
    kinres: 'Kinetic resistance', thermres: 'Thermal resistance',
    explres: 'Explosive resistance', causres: 'Caustic resistance',
    duration: 'Duration', spinup: 'Spin up', repair: 'Repair capacity',
    maximum: 'Maximum', time: 'Operating time', drain: 'Heat drain',
    proberadius: 'Probe radius', scanrange: 'Scan range', scantime: 'Scan time',
    hacktime: 'Hack time', angle: 'Angle', maxangle: 'Maximum angle',
    facinglimit: 'Facing limit', ranget: 'Time to target',
    cost: 'Cost', ammocost: 'Ammo cost', fightercost: 'Fighter cost',
  },
};

/** Подпись параметра на языке интерфейса (запасной вариант — английский). */
export function specName(locale: string, key: string): string {
  return SPEC_NAMES[locale]?.[key] ?? SPEC_NAMES.en[key] ?? key;
}

/** Поля, которые в подсказке показывать не нужно: они и так в заголовке. */
const HIDDEN = new Set([
  'id', 'grp', 'class', 'rating', 'name', 'mount', 'missile', 'info', 'pp', 'powerplay',
  'ship', 'symbol', 'preEngineered', 'engineering', 'experimental', 'special',
  'requirements', 'restriction', 'type', 'rechargerating', 'damagedist', 'passive',
  'eps', 'hps',
]);

export interface SpecValue {
  key: string;
  section: SpecSection;
  /** Готовая к показу строка значения. */
  display: string;
  raw: number;
  higherBetter: boolean;
}

/** Числовые параметры модуля, отсортированные как в `MODULE_SPECS`. */
export function moduleSpecValues(
  module: Record<string, unknown>,
  locale: string,
  format: (value: number, digits: number) => string,
  sections?: SpecSection[],
): SpecValue[] {
  const wanted = sections ? new Set(sections) : null;
  const result: SpecValue[] = [];
  const seen = new Set<string>();

  const push = (key: string, spec: SpecDef | undefined) => {
    if (seen.has(key) || HIDDEN.has(key)) return;
    const raw = module[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw === 0) return;
    const definition = spec ?? { key, section: 'perf' as SpecSection, digits: 2, higherBetter: true };
    if (wanted && !wanted.has(definition.section)) return;
    seen.add(key);
    const digits = definition.digits ?? 2;
    const display = definition.percent
      ? `${format(raw * 100, digits)} %`
      : `${format(raw, digits)}${definition.unit ? ` ${definition.unit}` : ''}`;
    result.push({
      key,
      section: definition.section,
      display,
      raw,
      higherBetter: definition.higherBetter ?? true,
    });
  };

  for (const spec of MODULE_SPECS) push(spec.key, spec);
  for (const key of Object.keys(module)) push(key, BY_KEY.get(key));
  // `locale` не нужен для чисел, но подпись берут там же, где и значения.
  void locale;
  return result;
}
