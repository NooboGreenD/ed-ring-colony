/**
 * Инженеры Elite Dangerous: дерево знакомств и условия доступа.
 *
 * Данные сверены с открытыми справочниками (INARA, EDCD) и описывают то, что
 * реально спрашивают у игрока: как узнать об инженере, что нужно, чтобы он
 * согласился встретиться, и чем «оплачивается» приглашение.
 *
 * Список того, что инженер улучшает, НЕ хранится здесь: он берётся из того же
 * набора, что и верфь (`public/data/outfitting.json`, раздел `engineers`) —
 * так страница инженеров и конструктор сборок всегда говорят одно и то же.
 * Для инженеров Одиссеи (скафандры и ручное оружие) модулей в том наборе нет,
 * поэтому их умения перечислены здесь текстом.
 */

export type EngineerBranch = 'ship' | 'odyssey';

export interface Engineer {
  /** Ключ для ссылок и локального прогресса. */
  id: string;
  /** Имя ровно как в игре (по нему же связываемся со справочником верфи). */
  name: string;
  /** Написания имени в сторонних наборах данных (в них встречаются опечатки). */
  aliases?: string[];
  branch: EngineerBranch;
  /** Инженер, который «даёт наводку». Пусто — о нём известно и так. */
  from: string[];
  system: string;
  station: string;
  /** Нужен пермит на систему. */
  permit?: boolean;
  /** Колония (Colonia): туда 22 000 св. лет. */
  colonia?: boolean;
  /** Как узнать об инженере. */
  discovery: string;
  /** Что нужно, чтобы он согласился на встречу. */
  meeting: string;
  /** Чем «оплачивается» приглашение. */
  unlock: string;
  /** Одиссея: что принести, чтобы он дал наводку на следующего. */
  referral?: string;
  /** Специализация — одной строкой, для карточки в дереве. */
  focus: string;
  /** Умения инженеров Одиссеи (у корабельных берутся из справочника верфи). */
  skills?: string[];
}

export const ENGINEERS: Engineer[] = [
  // ── Корабельные инженеры: первая линия ───────────────────────────────
  {
    id: 'farseer',
    name: 'Felicity Farseer',
    aliases: ['Felicty Farseer'],
    branch: 'ship',
    from: [],
    system: 'Deciat',
    station: 'Farseer Inc',
    discovery: 'Общедоступные источники — искать никого не нужно.',
    meeting: 'Ранг исследователя Scout или выше.',
    unlock: 'Передать 1 единицу Meta Alloys (мета-сплавы; проще всего купить в Maia).',
    focus: 'FSD, двигатели, сенсоры — первая остановка любого исследователя',
  },
  {
    id: 'martuuk',
    name: 'Elvira Martuuk',
    branch: 'ship',
    from: [],
    system: 'Khun',
    station: 'Long Sight Base',
    discovery: 'Общеизвестно.',
    meeting: 'Удалиться от стартовой системы минимум на 300 св. лет.',
    unlock: 'Передать 3 единицы Soontill Relics.',
    focus: 'FSD (G5), щиты, двигатели',
  },
  {
    id: 'dweller',
    name: 'The Dweller',
    branch: 'ship',
    from: [],
    system: 'Wyrd',
    station: 'Black Hide',
    discovery: 'Общеизвестно.',
    meeting: 'Совершить сделки минимум на 5 чёрных рынках.',
    unlock: 'Заплатить 500 000 CR.',
    focus: 'Распределитель питания (G5), импульсные и лучевые лазеры',
  },
  {
    id: 'mcquinn',
    name: 'Tod "The Blaster" McQuinn',
    branch: 'ship',
    from: [],
    system: 'Wolf 397',
    station: 'Trophy Camp',
    discovery: 'Общеизвестно.',
    meeting: 'Получить более 15 наградных ваучеров (bounty vouchers).',
    unlock: 'Сдать наградных ваучеров на 100 000 CR.',
    focus: 'Мультипушки и рельсотроны (G5)',
  },
  {
    id: 'ryder',
    name: 'Liz Ryder',
    branch: 'ship',
    from: [],
    system: 'Eurybia',
    station: 'Demolition Unlimited',
    discovery: 'Открытые источники.',
    meeting: 'Отношение Cordial или Friendly с фракцией Eurybia Blue Mafia.',
    unlock: 'Передать 200 единиц Landmines.',
    focus: 'Ракеты, торпеды, начальная броня и усиление корпуса',
  },

  // ── Вторая линия ─────────────────────────────────────────────────────
  {
    id: 'ishmaak',
    name: 'Juri Ishmaak',
    branch: 'ship',
    from: ['farseer'],
    system: 'Giryak',
    station: "Pater's Memorial",
    discovery: 'Наводка от Felicity Farseer (уровень 3–4).',
    meeting: 'Получить более 50 федеральных боевых бондов.',
    unlock: 'Сдать федеральных боевых бондов на 100 000 CR (иногда требуется 1 000 000).',
    focus: 'Мины, добывающие орудия, сканеры, сенсоры',
  },
  {
    id: 'nemo',
    name: 'Zacariah Nemo',
    branch: 'ship',
    from: ['martuuk'],
    system: 'Yoru',
    station: 'Nemo Cyber Party Base',
    discovery: 'Наводка от Elvira Martuuk (уровень 3–4).',
    meeting: 'Получить приглашение от фракции Party of Yoru.',
    unlock: 'Передать 25 единиц Xihe Companions.',
    focus: 'Картечницы (G5), мультипушки, плазма',
  },
  {
    id: 'qwent',
    name: 'Marco Qwent',
    branch: 'ship',
    from: ['martuuk'],
    system: 'Sirius',
    station: 'Qwent Research Base',
    permit: true,
    discovery: 'Наводка от Elvira Martuuk (уровень 3–4).',
    meeting: 'Получить приглашение от Sirius Corporation (пермит на систему).',
    unlock: 'Передать 25 единиц Modular Terminals.',
    focus: 'Реактор (G4) и распределитель питания',
  },
  {
    id: 'cheung',
    name: 'Lei Cheung',
    branch: 'ship',
    from: ['dweller'],
    system: 'Laksak',
    station: "Trader's Rest",
    discovery: 'Наводка от The Dweller (уровень 3–4).',
    meeting: 'Поторговать более чем на 50 рынках.',
    unlock: 'Передать 200 единиц Gold.',
    focus: 'Генераторы щита (G5), сенсоры, детальный сканер',
  },
  {
    id: 'selene',
    name: 'Selene Jean',
    branch: 'ship',
    from: ['mcquinn'],
    system: 'Kuk',
    station: "Prospector's Rest",
    discovery: 'Наводка от Tod "The Blaster" McQuinn (уровень 3–4).',
    meeting: 'Добыть не менее 500 тонн руды.',
    unlock: 'Передать 10 единиц самостоятельно добытого Painite.',
    focus: 'Броня, усиление корпуса и защита модулей (G5)',
  },
  {
    id: 'tani',
    name: 'Hera Tani',
    branch: 'ship',
    from: ['ryder'],
    system: 'Kuwemaki',
    station: "The Jet's Hole",
    discovery: 'Наводка от Liz Ryder (уровень 3–4).',
    meeting: 'Ранг Outsider или выше в Империи.',
    unlock: 'Передать 50 единиц Kamitra Cigars.',
    focus: 'Реактор (G5), распределитель, сенсоры',
  },

  // ── Третья линия ─────────────────────────────────────────────────────
  {
    id: 'palin',
    name: 'Professor Palin',
    branch: 'ship',
    from: ['qwent'],
    system: 'Arque',
    station: 'Abel Laboratory',
    discovery: 'Наводка от Marco Qwent (уровень 3–4).',
    meeting: 'Удалиться от стартовой системы минимум на 5 000 св. лет.',
    unlock: 'Передать 25 единиц Sensor Fragments (обломки сенсоров таргоидов).',
    focus: 'Двигатели (G5), FSD',
  },
  {
    id: 'sedesi',
    name: 'Chloe Sedesi',
    branch: 'ship',
    from: ['qwent'],
    system: 'Shenve',
    station: 'Cinder Dock',
    discovery: 'Наводка от Marco Qwent (уровень 3–4).',
    meeting: 'Удалиться от стартовой системы минимум на 5 000 св. лет.',
    unlock: 'Передать 25 единиц Sensor Fragments.',
    focus: 'Двигатели (G5), FSD — «второй Палин» ближе к Колонии',
  },
  {
    id: 'jameson',
    name: 'Lori Jameson',
    branch: 'ship',
    from: ['qwent'],
    system: 'Shinrarta Dezhra',
    station: 'Jameson Base',
    permit: true,
    discovery: 'Наводка от Marco Qwent (уровень 3–4).',
    meeting: 'Боевой ранг Dangerous или выше.',
    unlock: 'Передать 25 единиц Kongga Ale.',
    focus: 'Сенсоры, сканеры, жизнеобеспечение, топливозаборник, AFMU',
  },
  {
    id: 'ramtah',
    name: 'Ram Tah',
    branch: 'ship',
    from: ['cheung'],
    system: 'Meene',
    station: 'Phoenix Base',
    discovery: 'Наводка от Lei Cheung (уровень 3–4).',
    meeting: 'Ранг исследователя Surveyor или выше.',
    unlock: 'Передать 50 единиц Classified Scan Databanks.',
    focus: 'Утилиты (chaff, теплоотвод, ПРО), контроллеры дронов, орудия Стражей',
  },
  {
    id: 'dekker',
    name: 'Colonel Bris Dekker',
    branch: 'ship',
    from: ['ishmaak'],
    system: 'Sol',
    station: "Dekker's Yard",
    permit: true,
    discovery: 'Наводка от Juri Ishmaak (уровень 3–4).',
    meeting: 'Friendly с Федерацией (плюс пермит на Sol).',
    unlock: 'Сдать федеральных боевых бондов на 1 000 000 CR (иногда 10 000 000).',
    focus: 'Интердиктор FSD (G4), FSD',
  },
  {
    id: 'sarge',
    name: 'The Sarge',
    branch: 'ship',
    from: ['ishmaak'],
    system: 'Beta-3 Tucani',
    station: 'The Beach',
    discovery: 'Наводка от Juri Ishmaak (уровень 3–4).',
    meeting: 'Ранг Midshipman или выше во флоте Федерации.',
    unlock: 'Передать 50 единиц Aberrant Shield Pattern Analysis.',
    focus: 'Пушки, контроллеры дронов, рельсотрон',
  },
  {
    id: 'vatermann',
    name: 'Didi Vatermann',
    branch: 'ship',
    from: ['selene'],
    system: 'Leesti',
    station: 'Vatermann LLC',
    discovery: 'Наводка от Selene Jean (уровень 3–4).',
    meeting: 'Торговый ранг Merchant или выше.',
    unlock: 'Передать 50 единиц Lavian Brandy.',
    focus: 'Усилители щита (G5), генераторы щита',
  },
  {
    id: 'turner',
    name: 'Bill Turner',
    branch: 'ship',
    from: ['selene'],
    system: 'Alioth',
    station: 'Turner Metallics Inc',
    permit: true,
    discovery: 'Наводка от Selene Jean (уровень 3–4).',
    meeting: 'Friendly с Альянсом и Allied с Alioth Independents — иначе не дадут пермит на Alioth.',
    unlock: 'Передать 50 единиц Bromellite.',
    focus: 'Плазменные ускорители, сенсоры, детальный сканер, вспомогательные модули',
  },
  {
    id: 'tarquin',
    name: 'Broo Tarquin',
    branch: 'ship',
    from: ['tani'],
    system: 'Muang',
    station: "Broo's Legacy",
    discovery: 'Наводка от Hera Tani (уровень 3–4).',
    meeting: 'Боевой ранг Competent или выше.',
    unlock: 'Передать 50 единиц Fujin Tea.',
    focus: 'Все лазеры (импульс, очередь, луч) до G5',
  },
  {
    id: 'fortune',
    name: 'Tiana Fortune',
    branch: 'ship',
    from: ['tani'],
    system: 'Achenar',
    station: "Fortune's Loss",
    permit: true,
    discovery: 'Наводка от Hera Tani (уровень 3–4).',
    meeting: 'Friendly с Империей (пермит на Achenar).',
    unlock: 'Передать 50 единиц Decoded Emission Data.',
    focus: 'Сканеры, сенсоры, контроллеры дронов',
  },

  // ── Колония ──────────────────────────────────────────────────────────
  {
    id: 'brandon',
    name: 'Mel Brandon',
    branch: 'ship',
    from: ['martuuk'],
    colonia: true,
    system: 'Luchtaine',
    station: 'The Brig',
    discovery: 'Наводка от Elvira Martuuk (уровень 3–4).',
    meeting: 'Получить приглашение от Colonia Council.',
    unlock: 'Сдать наградных ваучеров на 100 000 CR.',
    focus: 'Почти всё сразу: FSD, двигатели, щиты, лазеры — «универсал Колонии»',
  },
  {
    id: 'hicks',
    name: 'Marsha Hicks',
    branch: 'ship',
    from: ['dweller'],
    colonia: true,
    system: 'Tir',
    station: 'The Watchtower',
    discovery: 'Наводка от The Dweller (уровень 3–4).',
    meeting: 'Ранг исследователя Surveyor или выше.',
    unlock: 'Передать 10 единиц самостоятельно добытого Osmium.',
    focus: 'Пушки, картечницы, мультипушки, топливозаборник, обогатитель, дроны',
  },
  {
    id: 'olmanova',
    name: 'Petra Olmanova',
    branch: 'ship',
    from: ['mcquinn'],
    colonia: true,
    system: 'Asura',
    station: 'Sanctuary',
    discovery: 'Наводка от Tod "The Blaster" McQuinn (уровень 3–4).',
    meeting: 'Боевой ранг Expert или выше.',
    unlock: 'Передать 200 единиц Progenitor Cells.',
    focus: 'Броня, усиления, утилиты, ракеты и торпеды — вся «оборонка» до G5',
  },
  {
    id: 'dorn',
    name: 'Etienne Dorn',
    branch: 'ship',
    from: ['ryder'],
    colonia: true,
    system: 'Los',
    station: "Kraken's Retreat",
    discovery: 'Наводка от Liz Ryder (уровень 3–4).',
    meeting: 'Торговый ранг Dealer или выше.',
    unlock: 'Передать 25 единиц Occupied Escape Pods.',
    focus: 'Реактор, распределитель, сенсоры, жизнеобеспечение, рельсотрон, плазма — всё до G5',
  },

  // ── Одиссея: скафандры и ручное оружие ───────────────────────────────
  {
    id: 'navarro',
    name: 'Jude Navarro',
    branch: 'odyssey',
    from: [],
    system: 'Aurai',
    station: "Marshall's Drift",
    discovery: 'Общеизвестно.',
    meeting: '—',
    unlock: 'Выполнить 10 миссий на восстановление или перезапуск поселений (Restore / Reactivation).',
    referral: 'Передать 5 единиц Genetic Repair Meds.',
    focus: 'Скафандр Maverick и боевые модификации',
    skills: ['Скорость перезарядки', 'Ёмкость магазина', 'Дополнительный боезапас', 'Сопротивление урону', 'Урон в ближнем бою'],
  },
  {
    id: 'velasquez',
    name: 'Terra Velasquez',
    branch: 'odyssey',
    from: ['navarro'],
    system: 'Shou Xing',
    station: "Rascal's Choice",
    discovery: 'Наводка от Jude Navarro.',
    meeting: '—',
    unlock: 'Выполнить 6 миссий Covert theft и Covert heist.',
    referral: 'Передать 15 Financial Projections.',
    focus: 'Подвижность и скрытность',
    skills: ['Точность от бедра', 'Глушитель', 'Дольше спринт', 'Скорость в бою', 'Больше запаса воздуха'],
  },
  {
    id: 'geiger',
    name: 'Oden Geiger',
    branch: 'odyssey',
    from: ['velasquez'],
    system: 'Candiaei',
    station: "Ankh's Promise",
    discovery: 'Наводка от Terra Velasquez.',
    meeting: '—',
    unlock: 'Продать барменам суммарно 20 Biological Sample, Employee Genetic Data и Genetic Research.',
    focus: 'Оптика и электроника',
    skills: ['Стабильность', 'Прицел', 'Улучшенное наведение', 'Ёмкость батареи', 'Ночное зрение'],
  },
  {
    id: 'ferrari',
    name: 'Hero Ferrari',
    branch: 'odyssey',
    from: [],
    system: 'Siris',
    station: 'Nevermore Terrace',
    discovery: 'Общеизвестно.',
    meeting: '—',
    unlock: 'Пройти 10 наземных зон конфликта.',
    referral: 'Передать 5 Settlement Defence Plans.',
    focus: 'Скафандр Artemis, подвижность',
    skills: ['Быстрое обращение', 'Глушитель', 'Дольше спринт', 'Улучшенный прыжковый ускоритель', 'Больше запаса воздуха'],
  },
  {
    id: 'beck',
    name: 'Wellington Beck',
    branch: 'odyssey',
    from: ['ferrari'],
    system: 'Jolapa',
    station: 'Beck Facility',
    discovery: 'Наводка от Hero Ferrari.',
    meeting: '—',
    unlock: 'Продать барменам суммарно 15 Multimedia Entertainment, Classic Entertainment и Cat Media.',
    referral: 'Передать 5 Insight Entertainment Suites.',
    focus: 'Дальность, оптика и снаряжение',
    skills: ['Увеличенная дальность', 'Прицел', 'Экономия батареи инструмента', 'Ёмкость батареи', 'Больше места в рюкзаке'],
  },
  {
    id: 'laszlo',
    name: 'Uma Laszlo',
    branch: 'odyssey',
    from: ['beck'],
    system: 'Xuane',
    station: "Laszlo's Resolve",
    discovery: 'Наводка от Wellington Beck.',
    meeting: '—',
    unlock: 'Опустить репутацию с Sirius Corporation до Unfriendly или ниже.',
    focus: 'Урон и живучесть',
    skills: ['Скорость перезарядки', 'Перезарядка в кобуре', 'Урон в голову', 'Сопротивление урону', 'Быстрое восстановление щита'],
  },
  {
    id: 'domino',
    name: 'Domino Green',
    branch: 'odyssey',
    from: [],
    system: 'Orishis',
    station: 'The Jackrabbit',
    discovery: 'Общеизвестно.',
    meeting: '—',
    unlock: 'Пролететь не менее 100 св. лет на шаттлах Apex.',
    referral: 'Передать 5 доз Push.',
    focus: 'Скафандр Dominator, дальность и точность',
    skills: ['Увеличенная дальность', 'Стабильность', 'Улучшенное наведение', 'Больше места в рюкзаке', 'Экономия батареи инструмента'],
  },
  {
    id: 'fowler',
    name: 'Kit Fowler',
    branch: 'odyssey',
    from: ['domino'],
    system: 'Capoya',
    station: 'The Last Call',
    discovery: 'Наводка от Domino Green.',
    meeting: '—',
    unlock: 'Продать барменам 5 Opinion Polls.',
    referral: 'Передать 5 Surveillance Equipment.',
    focus: 'Боезапас и щит',
    skills: ['Перезарядка в кобуре', 'Ёмкость магазина', 'Урон в ближнем бою', 'Быстрое восстановление щита', 'Дополнительный боезапас'],
  },
  {
    id: 'bond',
    name: 'Yarden Bond',
    branch: 'odyssey',
    from: ['fowler'],
    system: 'Bayan',
    station: 'Salamander Bank',
    discovery: 'Наводка от Kit Fowler.',
    meeting: '—',
    unlock: 'Продать барменам 5 Smear Campaign Plans.',
    focus: 'Скрытность',
    skills: ['Быстрое обращение', 'Точность от бедра', 'Маскировка звука', 'Улучшенный прыжковый ускоритель', 'Скорость в бою', 'Тихие шаги'],
  },
  {
    id: 'baltanos',
    name: 'Baltanos',
    branch: 'odyssey',
    from: [],
    colonia: true,
    system: 'Deriso',
    station: 'The Divine Apparatus',
    discovery: 'Общеизвестно (Колония).',
    meeting: '—',
    unlock: 'Достичь репутации Friendly с Colonia Council.',
    referral: 'Передать 10 Faction Associates.',
    focus: 'Подвижность и тишина',
    skills: ['Глушитель', 'Точность от бедра', 'Быстрое обращение', 'Улучшенный прыжковый ускоритель', 'Больше запаса воздуха', 'Дольше спринт', 'Скорость в бою'],
  },
  {
    id: 'bresa',
    name: 'Eleanor Bresa',
    branch: 'odyssey',
    from: [],
    colonia: true,
    system: 'Desy',
    station: 'Bresa Modifications',
    discovery: 'Общеизвестно (Колония).',
    meeting: '—',
    unlock: 'Посетить 5 поселений в системе Colonia.',
    referral: 'Передать 10 Digital Designs.',
    focus: 'Боезапас и живучесть',
    skills: ['Ёмкость магазина', 'Скорость перезарядки', 'Перезарядка в кобуре', 'Урон в ближнем бою', 'Сопротивление урону', 'Дополнительный боезапас', 'Быстрое восстановление щита'],
  },
  {
    id: 'dayette',
    name: 'Rosa Dayette',
    branch: 'odyssey',
    from: [],
    colonia: true,
    system: 'Kojeara',
    station: "Rosa's Shop",
    discovery: 'Общеизвестно (Колония).',
    meeting: '—',
    unlock: 'Продать станциям Колонии суммарно 10 Culinary Recipes или Cocktail Recipes.',
    referral: 'Передать 10 Manufacturing Instructions.',
    focus: 'Дальность и снаряжение',
    skills: ['Увеличенная дальность', 'Прицел', 'Стабильность', 'Больше места в рюкзаке', 'Улучшенное наведение', 'Экономия батареи инструмента', 'Ёмкость батареи'],
  },
  {
    id: 'yishen',
    name: 'Yi Shen',
    branch: 'odyssey',
    from: ['baltanos', 'bresa', 'dayette'],
    colonia: true,
    system: 'Einheriar',
    station: 'Eidolon Hold',
    discovery: 'Наводка сразу от троих: Baltanos, Eleanor Bresa и Rosa Dayette.',
    meeting: '—',
    unlock: 'Выполнить задания-наводки у Baltanos, Eleanor Bresa и Rosa Dayette.',
    focus: 'Скрытность и точные попадания',
    skills: ['Маскировка звука', 'Урон в голову', 'Тихие шаги', 'Ночное зрение'],
  },
];

export const ENGINEER_BY_ID = new Map(ENGINEERS.map((engineer) => [engineer.id, engineer]));

/** Дети инженера в дереве — кого он «открывает». */
export function childrenOf(id: string, branch: EngineerBranch): Engineer[] {
  return ENGINEERS.filter((engineer) => engineer.branch === branch && engineer.from.includes(id));
}

/** Корни ветки: о них известно без наводки. */
export function rootsOf(branch: EngineerBranch): Engineer[] {
  return ENGINEERS.filter((engineer) => engineer.branch === branch && engineer.from.length === 0);
}

/** Уровень в дереве: 0 — корень. Используется для раскладки и подсказок. */
export function depthOf(engineer: Engineer): number {
  let depth = 0;
  let current = engineer;
  const guard = new Set<string>();
  while (current.from.length > 0 && !guard.has(current.id)) {
    guard.add(current.id);
    const parent = ENGINEER_BY_ID.get(current.from[0]);
    if (!parent) break;
    current = parent;
    depth += 1;
  }
  return depth;
}

/** Путь от корня до инженера — «что нужно открыть раньше». */
export function pathTo(id: string): Engineer[] {
  const engineer = ENGINEER_BY_ID.get(id);
  if (!engineer) return [];
  const chain: Engineer[] = [engineer];
  let current = engineer;
  const guard = new Set<string>([id]);
  while (current.from.length > 0) {
    const parent = ENGINEER_BY_ID.get(current.from[0]);
    if (!parent || guard.has(parent.id)) break;
    guard.add(parent.id);
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/**
 * Найти инженера по идентификатору или по имени из справочника верфи —
 * ссылка `/engineers?engineer=…` приходит и в том, и в другом виде.
 */
export function resolveEngineer(key: string | null | undefined): Engineer | null {
  if (!key) return null;
  const direct = ENGINEER_BY_ID.get(key);
  if (direct) return direct;
  const needle = key.trim().toLowerCase();
  return (
    ENGINEERS.find((engineer) => lookupNames(engineer).some((name) => name.toLowerCase() === needle))
    // Запасной вариант: сопоставление по фамилии («Farseer», «McQuinn»).
    ?? ENGINEERS.find((engineer) => engineer.name.toLowerCase().includes(needle))
    ?? null
  );
}

/** Имена, под которыми инженер встречается в справочнике верфи. */
export function lookupNames(engineer: Engineer): string[] {
  return [engineer.name, ...(engineer.aliases ?? [])];
}
