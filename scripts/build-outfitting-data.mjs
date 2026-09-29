#!/usr/bin/env node
/**
 * Сборка справочника верфи (`public/data/outfitting.json`).
 *
 * Источник цифр — открытый набор данных Coriolis (`EDCD/coriolis-data`): тот
 * же, на котором работает coriolis.io. Мы не тянем его в зависимости и не
 * ходим за ним в рантайме: скрипт один раз перекладывает нужные поля в
 * компактный JSON, который отдаётся статикой и кешируется браузером.
 *
 * Запуск:
 *   node scripts/build-outfitting-data.mjs                 # скачает архив с GitHub
 *   node scripts/build-outfitting-data.mjs /path/coriolis-data   # из локальной копии
 *
 * Что выкидывается: внутренние идентификаторы Frontier/EDDB, англоязычные
 * описания и символы — они не нужны ни калькулятору, ни интерфейсу, а вес
 * файла определяет скорость открытия страницы.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'outfitting.json');
const REPO = 'https://github.com/EDCD/coriolis-data.git';

/** Поля, которые в наш справочник не попадают. */
const DROP = new Set(['edID', 'eddbID', 'symbol', 'ukDiscript', 'ukName', 'eddbCategory', 'uuid']);

/** Русские названия групп модулей и их раздел на странице. */
const GROUPS = {
  // Основные (core internals)
  pp: { name: 'Реактор', short: 'реактор', category: 'core' },
  t: { name: 'Двигатели', short: 'двигатели', category: 'core' },
  fsd: { name: 'Гипердвигатель (FSD)', short: 'FSD', category: 'core' },
  ls: { name: 'Жизнеобеспечение', short: 'жизнеобеспечение', category: 'core' },
  pd: { name: 'Распределитель питания', short: 'распределитель', category: 'core' },
  s: { name: 'Сенсоры', short: 'сенсоры', category: 'core' },
  ft: { name: 'Топливный бак', short: 'бак', category: 'core' },
  // Опциональные
  am: { name: 'Ремонтный модуль (AFMU)', category: 'internal' },
  bsg: { name: 'Bi-Weave щит', category: 'internal' },
  cr: { name: 'Грузовой отсек', category: 'internal' },
  crl: { name: 'Грузовой отсек (большой)', category: 'internal' },
  cc: { name: 'Контроллер сборщиков', category: 'internal' },
  dc: { name: 'Стыковочный компьютер', category: 'internal' },
  dtl: { name: 'Контроллер дезактивации', category: 'internal' },
  fh: { name: 'Ангар истребителей', category: 'internal' },
  fi: { name: 'Интердиктор FSD', category: 'internal' },
  fs: { name: 'Топливозаборник', category: 'internal' },
  fx: { name: 'Контроллер перекачки топлива', category: 'internal' },
  hb: { name: 'Контроллер взлома люков', category: 'internal' },
  hr: { name: 'Усиление корпуса', category: 'internal' },
  mahr: { name: 'Мета-сплав: усиление корпуса', category: 'internal' },
  mlc: { name: 'Универсальный контроллер дронов', category: 'internal' },
  mrp: { name: 'Защита модулей', category: 'internal' },
  pv: { name: 'Ангар SRV', category: 'internal' },
  psg: { name: 'Призматический щит', category: 'internal' },
  pc: { name: 'Контроллер разведчиков', category: 'internal' },
  pce: { name: 'Каюты: эконом', category: 'internal' },
  pci: { name: 'Каюты: бизнес', category: 'internal' },
  pcm: { name: 'Каюты: первый класс', category: 'internal' },
  pcq: { name: 'Каюты: люкс', category: 'internal' },
  rf: { name: 'Обогатитель', category: 'internal' },
  scb: { name: 'Батарея щита (SCB)', category: 'internal' },
  sg: { name: 'Генератор щита', category: 'internal' },
  ss: { name: 'Детальный сканер (DSS)', category: 'internal' },
  rpl: { name: 'Контроллер ремонтных дронов', category: 'internal' },
  rcpl: { name: 'Контроллер разведдронов', category: 'internal' },
  rsl: { name: 'Контроллер исследовательских дронов', category: 'internal' },
  gsrp: { name: 'Стражи: усиление щита', category: 'internal' },
  gfsb: { name: 'Стражи: ускоритель FSD', category: 'internal' },
  ghrp: { name: 'Стражи: усиление корпуса', category: 'internal' },
  gmrp: { name: 'Стражи: защита модулей', category: 'internal' },
  sua: { name: 'Помощник суперкруиза', category: 'internal' },
  ews: { name: 'Стабилизатор экспериментальных орудий', category: 'internal' },
  pas: { name: 'Комплект планетарной посадки', category: 'internal' },
  mm: { name: 'Пустой слот', category: 'internal' },
  // Орудия
  pl: { name: 'Импульсный лазер', category: 'hardpoint' },
  ul: { name: 'Очередной лазер', category: 'hardpoint' },
  bl: { name: 'Лучевой лазер', category: 'hardpoint' },
  mc: { name: 'Мультипушка', category: 'hardpoint' },
  advmc: { name: 'Мультипушка (улучшенная)', category: 'hardpoint' },
  axmc: { name: 'AX мультипушка', category: 'hardpoint' },
  axmce: { name: 'AX мультипушка (улучшенная)', category: 'hardpoint' },
  c: { name: 'Пушка', category: 'hardpoint' },
  fc: { name: 'Картечница', category: 'hardpoint' },
  rfl: { name: 'Зенитная установка', category: 'hardpoint' },
  rg: { name: 'Рельсотрон', category: 'hardpoint' },
  pa: { name: 'Плазменный ускоритель', category: 'hardpoint' },
  mr: { name: 'Ракетная установка', category: 'hardpoint' },
  amr: { name: 'Ракеты (улучшенные)', category: 'hardpoint' },
  axmr: { name: 'AX ракеты', category: 'hardpoint' },
  axmre: { name: 'AX ракеты (улучшенные)', category: 'hardpoint' },
  tp: { name: 'Торпедный пилон', category: 'hardpoint' },
  ntp: { name: 'Торпеды с нанитами', category: 'hardpoint' },
  nl: { name: 'Минный постановщик', category: 'hardpoint' },
  ml: { name: 'Добывающий лазер', category: 'hardpoint' },
  abl: { name: 'Абразивный бластер', category: 'hardpoint' },
  scl: { name: 'Сейсмический заряд', category: 'hardpoint' },
  sdm: { name: 'Подповерхностная ракета', category: 'hardpoint' },
  mvr: { name: 'Добывающий репитер', category: 'hardpoint' },
  gpc: { name: 'Стражи: плазменный заряжатель', category: 'hardpoint' },
  ggc: { name: 'Стражи: гаусс-пушка', category: 'hardpoint' },
  gsc: { name: 'Стражи: осколочная пушка', category: 'hardpoint' },
  tbsc: { name: 'Шоковая пушка', category: 'hardpoint' },
  tbem: { name: 'Ферментные ракеты', category: 'hardpoint' },
  tbrfl: { name: 'Флешетная установка', category: 'hardpoint' },
  mh: { name: 'Пустой пилон', category: 'hardpoint' },
  // Утилиты (класс 0)
  sb: { name: 'Усилитель щита', category: 'utility' },
  ch: { name: 'Отражатель (chaff)', category: 'utility' },
  ec: { name: 'РЭБ (ECM)', category: 'utility' },
  hs: { name: 'Теплоотвод', category: 'utility' },
  po: { name: 'Турель ПРО', category: 'utility' },
  cs: { name: 'Сканер манифеста', category: 'utility' },
  kw: { name: 'Сканер ордеров', category: 'utility' },
  ws: { name: 'Сканер следов FSD', category: 'utility' },
  pwa: { name: 'Импульсный анализатор', category: 'utility' },
  sfn: { name: 'Нейтрализатор поля', category: 'utility' },
  xs: { name: 'Ксено-сканер', category: 'utility' },
  csl: { name: 'Каустический теплоотвод', category: 'utility' },
};

function sourceDir() {
  const argument = process.argv[2];
  if (argument && existsSync(argument)) return { dir: argument, temporary: null };
  const dir = mkdtempSync(join(tmpdir(), 'coriolis-data-'));
  execFileSync('git', ['clone', '--depth', '1', '--quiet', REPO, dir], { stdio: 'inherit' });
  return { dir, temporary: dir };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Оставить только поля, нужные калькулятору и интерфейсу. */
function slim(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (DROP.has(key)) continue;
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  if (!out.name && record.ukName) out.name = record.ukName;
  return out;
}

function collectModules(dir) {
  const modules = {};
  for (const section of ['standard', 'internal', 'hardpoints']) {
    const base = join(dir, 'modules', section);
    for (const file of readdirSync(base)) {
      if (!file.endsWith('.json')) continue;
      const data = readJson(join(base, file));
      for (const [group, list] of Object.entries(data)) {
        if (!Array.isArray(list)) continue;
        // Топливный бак есть и в «основных», и в «опциональных» — это один
        // и тот же модуль, поэтому объединяем по id.
        const target = modules[group] ?? (modules[group] = []);
        const known = new Set(target.map((item) => item.id));
        for (const item of list) {
          if (known.has(item.id)) continue;
          target.push(slim(item));
        }
      }
    }
  }
  for (const list of Object.values(modules)) {
    list.sort((left, right) => (left.class - right.class) || String(left.rating).localeCompare(String(right.rating)));
  }
  return modules;
}

function collectShips(dir) {
  const ships = {};
  const base = join(dir, 'ships');
  for (const file of readdirSync(base)) {
    if (!file.endsWith('.json')) continue;
    const data = readJson(join(base, file));
    for (const [id, ship] of Object.entries(data)) {
      ships[id] = {
        id,
        properties: ship.properties,
        retailCost: ship.retailCost,
        bulkheads: (ship.bulkheads ?? []).map(slim),
        slots: ship.slots,
        defaults: ship.defaults,
      };
    }
  }
  return ships;
}

function main() {
  const { dir, temporary } = sourceDir();
  try {
    const modules = collectModules(dir);
    const ships = collectShips(dir);
    const blueprints = readJson(join(dir, 'modifications', 'blueprints.json'));
    const moduleBlueprints = readJson(join(dir, 'modifications', 'modules.json'));
    const specials = readJson(join(dir, 'modifications', 'specials.json'));
    const modifications = readJson(join(dir, 'modifications', 'modifications.json'));

    // Инженеры в обратную сторону: кто какой чертёж и до какого уровня может.
    const engineers = {};
    for (const [group, entry] of Object.entries(moduleBlueprints)) {
      for (const [blueprint, info] of Object.entries(entry.blueprints ?? {})) {
        for (const [grade, gradeInfo] of Object.entries(info.grades ?? {})) {
          for (const engineer of gradeInfo.engineers ?? []) {
            const person = engineers[engineer] ?? (engineers[engineer] = {});
            const key = `${group}:${blueprint}`;
            person[key] = Math.max(person[key] ?? 0, Number(grade));
          }
        }
      }
    }

    // Чертежи без описания составляющих: материалы нужны, названия — нет.
    const trimmedBlueprints = {};
    for (const [name, blueprint] of Object.entries(blueprints)) {
      const grades = {};
      for (const [grade, info] of Object.entries(blueprint.grades ?? {})) {
        grades[grade] = { features: info.features ?? {}, components: info.components ?? {} };
      }
      trimmedBlueprints[name] = { grades };
    }

    const trimmedSpecials = {};
    for (const [name, special] of Object.entries(specials)) {
      trimmedSpecials[name] = {
        name: special.name,
        description: special.description ?? '',
        features: special.features ?? {},
        components: special.components ?? {},
      };
    }

    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: 'EDCD/coriolis-data',
      groups: GROUPS,
      ships,
      modules,
      blueprints: trimmedBlueprints,
      moduleBlueprints,
      specials: trimmedSpecials,
      modifications,
      engineers,
    };

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(payload));
    const size = (readFileSync(OUT).length / 1024).toFixed(0);
    console.log(`Справочник верфи собран: ${OUT} (${size} КБ, кораблей ${Object.keys(ships).length}, групп модулей ${Object.keys(modules).length})`);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

main();
