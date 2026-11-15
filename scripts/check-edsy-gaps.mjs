#!/usr/bin/env node
/**
 * Сверка справочника верфи с набором EDSY: что игра уже знает, а мы — нет.
 *
 * `public/data/outfitting.json` собирается из EDCD/coriolis-data, а он
 * отстаёт от игры на месяцы: после обновления «Operations» (Merc Coin) и
 * «Lynx Highliner» в наборе не было ни кабинетов Mk II, ни больших ангаров
 * SRV, ни внутренних имён Frontier для Mk II модулей. Из-за этого живой
 * `Loadout` в Атласе выглядел как «часть Loadout не распознана».
 *
 * Скрипт ничего не пишет: он показывает, что стоит добавить в
 * `scripts/data/ship-update-*.json` (корабли и модули) и в раздел `symbols`
 * того же файла (точные имена Frontier).
 *
 * Запуск:
 *   node scripts/check-edsy-gaps.mjs                 # клонирует EDSY во временный каталог
 *   node scripts/check-edsy-gaps.mjs /path/to/EDSY   # из локальной копии
 *
 * Код возврата: 0 — расхождений нет, 1 — есть (удобно для ручной проверки
 * после нового игрового обновления).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const REPO = 'https://github.com/taleden/EDSY.git';

/**
 * Предметы, которые игра пишет в `Loadout.Modules`, но модулями не являются:
 * грузовой люк закреплён за корпусом и в верфи не выбирается.
 */
const NOT_MODULES = new Set(['modularcargobaydoor']);

/** Объект из `eddb.js`: вырезаем литерал и разбираем его как данные. */
export function grabObject(source, key) {
  const start = source.indexOf(`\t${key} : {`);
  if (start < 0) throw new Error(`eddb.js: нет раздела ${key}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return eval(`(${source.slice(open, index + 1)})`); // eslint-disable-line no-eval
    }
  }
  throw new Error(`eddb.js: раздел ${key} не закрыт`);
}

/** Игровое имя корабля → идентификатор справочника (карта из `fdnames.ts`). */
function shipMap() {
  const source = readFileSync(join(ROOT, 'src', 'lib', 'outfitting', 'fdnames.ts'), 'utf8');
  const block = source.slice(source.indexOf('export const SHIP_FD_TO_CORIOLIS'),
    source.indexOf('const CORIOLIS_TO_SHIP_FD'));
  const map = {};
  for (const [, fd, id] of block.matchAll(/([a-z0-9_]+):\s*'([a-z0-9_]+)'/g)) map[fd] = id;
  return map;
}

function sourceDir(argument) {
  if (argument) return { dir: argument, temporary: null };
  const dir = mkdtempSync(join(tmpdir(), 'edsy-'));
  execFileSync('git', ['clone', '--depth', '1', '--quiet', REPO, dir], { stdio: 'inherit' });
  return { dir, temporary: dir };
}

function main() {
  const { dir, temporary } = sourceDir(process.argv[2]);
  try {
    const source = readFileSync(join(dir, 'eddb.js'), 'utf8');
    const modules = grabObject(source, 'module');
    const ships = grabObject(source, 'ship');
    const catalog = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'outfitting.json'), 'utf8'));

    const knownSymbols = new Set();
    for (const list of Object.values(catalog.modules)) {
      for (const module of list) if (module.symbol) knownSymbols.add(module.symbol.toLowerCase());
    }
    const missingModules = [];
    for (const entry of Object.values(modules)) {
      const symbol = String(entry.fdname ?? '');
      // `_Free` и hidden — заводские и архивные варианты для новых кораблей:
      // в верфи они не продаются, в справочнике им делать нечего.
      if (!symbol || symbol.endsWith('_Free') || entry.hidden) continue;
      if (NOT_MODULES.has(symbol.toLowerCase())) continue;
      if (knownSymbols.has(symbol.toLowerCase())) continue;
      missingModules.push(`${entry.name} ${entry.class}${entry.rating} → ${symbol}`);
    }

    const map = shipMap();
    const missingShips = [];
    for (const ship of Object.values(ships)) {
      const id = map[String(ship.fdname).toLowerCase()] ?? String(ship.fdname).toLowerCase();
      if (!catalog.ships[id]) missingShips.push(`${ship.name} (${ship.fdname}) → ${id}`);
    }

    const report = (title, rows) => {
      console.log(`\n${title}: ${rows.length}`);
      for (const row of rows.sort()) console.log(`  ${row}`);
    };
    report('Модули игры, которых нет в справочнике', missingModules);
    report('Корабли игры, которых нет в справочнике', missingShips);
    if (missingModules.length === 0 && missingShips.length === 0) console.log('\nСправочник догоняет игру.');
    process.exitCode = missingModules.length || missingShips.length ? 1 : 0;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

main();
