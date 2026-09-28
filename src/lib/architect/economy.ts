/**
 * Зависимости экономик от тел и торговые рынки построек.
 *
 * В Elite Dangerous (Trailblazers / Operations) экономика, которую постройка
 * приносит системе, зависит не только от типа постройки, но и от **тела**, на
 * котором она стоит: добыча сильнее на телах с кольцами и металлами, сельское
 * хозяйство — на землеподобных и водных мирах, и так далее. Рынок станции, в
 * свою очередь, определяется её экономикой: что она **производит** (продаёт) и
 * что **ввозит** (покупает).
 *
 * Здесь собраны эти зависимости — как ориентир для планирования, а не как
 * точная формула игры (Frontier её не публикует). Модуль намеренно без React и
 * без сети: он прогоняется в тестах (`scripts/tests/architect-economy.test.mjs`)
 * и переиспользуется в интерфейсе.
 */
import type { ArchitectBody, SystemEconomy } from './types.ts';

/**
 * Признак тела, влияющий на экономику. Часть выводится из подтипа тела
 * (`subType`), часть — из физических флагов скана.
 */
export type BodyTrait =
  | 'rings'
  | 'terraformable'
  | 'atmosphere'
  | 'volcanism'
  | 'earthlike'
  | 'water'
  | 'ammonia'
  | 'metalRich'
  | 'hmc'
  | 'rocky'
  | 'icy'
  | 'gasGiant';

/** Русские подписи признаков тела. */
export const BODY_TRAIT_LABELS_RU: Record<BodyTrait, string> = {
  rings: 'кольца / пояс',
  terraformable: 'терраформируемое',
  atmosphere: 'атмосфера',
  volcanism: 'вулканизм / геология',
  earthlike: 'землеподобный мир',
  water: 'водный мир',
  ammonia: 'аммиачный мир',
  metalRich: 'металлическое тело',
  hmc: 'высокое содержание металлов',
  rocky: 'каменистое тело',
  icy: 'ледяное тело',
  gasGiant: 'газовый гигант',
};

/** Уровень соответствия экономики телу. */
export type EconomyFitLevel = 'boost' | 'neutral' | 'weak';

export interface EconomyAffinity {
  /** Признаки тела, усиливающие экономику. */
  boost: BodyTrait[];
  /**
   * Экономика **ожидает** подходящее тело: если ни одного `boost`-признака нет,
   * постройка на таком теле работает слабее — интерфейс предупреждает.
   */
  bodyDependent: boolean;
  /** Короткое пояснение зависимости — для подсказок. */
  note: string;
}

/**
 * Какие тела усиливают каждую экономику. `bodyDependent: false` — экономика от
 * тела почти не зависит (военные, услуги, колония): такие постройки можно
 * ставить где удобно, предупреждения о теле для них не выводятся.
 */
export const ECONOMY_AFFINITY: Record<SystemEconomy, EconomyAffinity> = {
  extraction: {
    boost: ['rings', 'metalRich', 'hmc', 'volcanism'],
    bodyDependent: true,
    note: 'Добыча сильнее у колец/поясов и на телах, богатых металлами и рудой.',
  },
  refinery: {
    boost: ['rings', 'metalRich', 'hmc'],
    bodyDependent: true,
    note: 'Переработке нужно сырьё рядом: кольца и металлические тела.',
  },
  agriculture: {
    boost: ['earthlike', 'water', 'ammonia', 'terraformable', 'atmosphere'],
    bodyDependent: true,
    note: 'Сельское хозяйство растёт на землеподобных, водных, аммиачных и терраформируемых мирах.',
  },
  industrial: {
    boost: ['hmc', 'rocky', 'volcanism'],
    bodyDependent: true,
    note: 'Промышленности помогают каменистые и металлические тела с геологией.',
  },
  tourism: {
    boost: ['earthlike', 'water', 'ammonia', 'terraformable', 'rings', 'volcanism'],
    bodyDependent: true,
    note: 'Туризм тянется к «видовым» телам: землеподобные, водные, кольца, вулканизм.',
  },
  hightech: {
    boost: ['earthlike', 'water', 'terraformable'],
    bodyDependent: false,
    note: 'Высокие технологии почти не зависят от тела, но выигрывают от комфортных миров.',
  },
  military: {
    boost: [],
    bodyDependent: false,
    note: 'Военная экономика от типа тела не зависит.',
  },
  colony: {
    boost: [],
    bodyDependent: false,
    note: 'Колониальная экономика — стартовая, от тела не зависит.',
  },
  service: {
    boost: [],
    bodyDependent: false,
    note: 'Сервисная экономика от типа тела не зависит.',
  },
  contraband: {
    boost: [],
    bodyDependent: false,
    note: 'Контрабанда от типа тела не зависит.',
  },
  none: {
    boost: [],
    bodyDependent: false,
    note: 'Постройка не задаёт экономику.',
  },
};

/** Что рынок экономики производит (продаёт) и что ввозит (покупает). */
export interface EconomyMarket {
  produces: string[];
  imports: string[];
}

/**
 * Ориентировочный рынок по экономике станции. Категории — по типам экономик
 * Elite Dangerous; конкретный ассортимент станции плавает, поэтому это ориентир
 * для перевозчиков, а не точный прайс.
 */
export const ECONOMY_MARKET: Record<SystemEconomy, EconomyMarket> = {
  agriculture: {
    produces: ['Продовольствие (зерно, фрукты, рыба, кофе, чай)', 'Напитки'],
    imports: ['Техника и уборщики урожая', 'Пестициды и агромедикаменты', 'Потребительские товары'],
  },
  extraction: {
    produces: ['Руды и минералы', 'Сырьё'],
    imports: ['Горная техника и экстракторы', 'Продовольствие', 'Спасательное снаряжение'],
  },
  refinery: {
    produces: ['Металлы', 'Минералы', 'Полупроводники'],
    imports: ['Руды и минералы', 'Горная техника', 'Химия'],
  },
  industrial: {
    produces: ['Машины и техника', 'Металлы и сплавы', 'Роботы и фабрикаторы'],
    imports: ['Минералы и металлы', 'Химия и полимеры', 'Продовольствие'],
  },
  hightech: {
    produces: ['Технологии и электроника', 'Медикаменты', 'Компьютерные компоненты'],
    imports: ['Металлы и сплавы', 'Продовольствие', 'Потребительские товары'],
  },
  military: {
    produces: ['Оружие и снаряжение', 'Военные ткани и броня'],
    imports: ['Металлы и сплавы', 'Продовольствие', 'Медикаменты'],
  },
  tourism: {
    produces: ['Услуги и туристические данные'],
    imports: ['Продовольствие и напитки', 'Предметы роскоши', 'Потребительские товары'],
  },
  service: {
    produces: ['Потребительские товары', 'Услуги'],
    imports: ['Продовольствие', 'Техника', 'Медикаменты'],
  },
  colony: {
    produces: ['Базовые товары колонии'],
    imports: ['Продовольствие', 'Техника', 'Медикаменты и снаряжение'],
  },
  contraband: {
    produces: ['Нелегальные товары'],
    imports: ['Наркотики и оружие'],
  },
  none: {
    produces: [],
    imports: [],
  },
};

/** Вывести набор признаков тела для расчёта соответствия экономике. */
export function bodyTraits(body: ArchitectBody | null | undefined): Set<BodyTrait> {
  const traits = new Set<BodyTrait>();
  if (!body) return traits;
  if (body.hasRings) traits.add('rings');
  if (body.terraformable) traits.add('terraformable');
  if (body.hasAtmosphere) traits.add('atmosphere');
  if (body.volcanism) traits.add('volcanism');
  const sub = String(body.subType ?? '').toLowerCase();
  if (sub.includes('earth')) traits.add('earthlike');
  if (sub.includes('water world') || sub.includes('water giant')) traits.add('water');
  if (sub.includes('ammonia')) traits.add('ammonia');
  if (sub.includes('metal-rich') || sub.includes('metal rich')) traits.add('metalRich');
  if (sub.includes('high metal content')) traits.add('hmc');
  if (sub.includes('gas giant')) traits.add('gasGiant');
  // «Icy» ловим раньше «rocky», чтобы «Rocky ice world» считался ледяным.
  if (sub.includes('icy') || sub.includes('ice world') || sub.includes('rocky ice')) traits.add('icy');
  else if (sub.includes('rocky')) traits.add('rocky');
  return traits;
}

export interface EconomyBodyFit {
  level: EconomyFitLevel;
  /** Совпавшие усиливающие признаки тела (для «boost»). */
  matched: BodyTrait[];
  /** Человеко-читаемое пояснение. */
  reason: string;
}

/**
 * Насколько тело подходит экономике.
 *
 * `boost`  — на теле есть хотя бы один усиливающий признак;
 * `weak`   — экономика зависит от тела, но подходящих признаков нет;
 * `neutral`— экономика от тела не зависит (или это звезда/орбита).
 */
export function economyBodyFit(economy: SystemEconomy, body: ArchitectBody | null | undefined): EconomyBodyFit {
  const affinity = ECONOMY_AFFINITY[economy] ?? ECONOMY_AFFINITY.none;
  if (economy === 'none' || (!affinity.bodyDependent && affinity.boost.length === 0)) {
    return { level: 'neutral', matched: [], reason: affinity.note };
  }
  const traits = bodyTraits(body);
  const matched = affinity.boost.filter((trait) => traits.has(trait));
  if (matched.length > 0) {
    const names = matched.map((trait) => BODY_TRAIT_LABELS_RU[trait]).join(', ');
    return { level: 'boost', matched, reason: `Тело усиливает экономику: ${names}` };
  }
  if (affinity.bodyDependent && body) {
    const wanted = affinity.boost.map((trait) => BODY_TRAIT_LABELS_RU[trait]).join(', ');
    return { level: 'weak', matched: [], reason: `Экономика слабо развивается на этом теле — ей подошли бы: ${wanted}` };
  }
  return { level: 'neutral', matched: [], reason: affinity.note };
}

/** Какие экономики усиливает конкретное тело (для карточки тела). */
export function bodyBoostedEconomies(body: ArchitectBody | null | undefined): SystemEconomy[] {
  if (!body) return [];
  const traits = bodyTraits(body);
  const result: SystemEconomy[] = [];
  for (const economy of Object.keys(ECONOMY_AFFINITY) as SystemEconomy[]) {
    if (economy === 'none') continue;
    const affinity = ECONOMY_AFFINITY[economy];
    if (affinity.boost.some((trait) => traits.has(trait))) result.push(economy);
  }
  return result;
}
