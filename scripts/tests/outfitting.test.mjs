/**
 * Тесты верфи (`src/lib/outfitting`) и дерева инженеров (`src/lib/engineers`).
 *
 * Проверяем то, что пользователь увидит как «неправильные цифры» или
 * «сломанную ссылку»:
 *
 * 1. Справочник `public/data/outfitting.json` цел: корабли, модули, чертежи
 *    на месте, слоты и заводские комплектации разбираются.
 * 2. Заводская сборка реально собирается: у Sidewinder и Anaconda заполнены
 *    все основные слоты, а «снять всё» ничего не оставляет в орудиях.
 * 3. Формулы совпадают с игрой: прыжок Sidewinder и Anaconda в заводской
 *    комплектации, масса, энергобаланс, рост дальности от облегчения.
 * 4. Инженерия применяется в нужную сторону: дальнобойный FSD увеличивает
 *    optmass и дальность, чем выше уровень — тем больше.
 * 5. Ссылка на сборку кодируется и раскодируется без потерь.
 * 6. Дерево инженеров связно: у всех наводок есть источник, циклов нет,
 *    имена совпадают со справочником верфи (включая опечатки в исходных
 *    данных), у каждого корабельного инженера есть чертежи.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены
}
const maybe = esbuild ? test : test.skip;

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function loadLib() {
  const dir = mkdtempSync(join(ROOT, '.tmp-outfitting-'));
  tempDirs.push(dir);
  const entry = join(dir, 'entry.ts');
  const bundle = join(dir, 'lib.mjs');
  writeFileSync(
    entry,
    "export * from '@/lib/outfitting/calc';\nexport * from '@/lib/outfitting/build';\nexport * from '@/lib/engineers/data';\n",
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: { '@': join(ROOT, 'src') },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });
  return import(bundle);
}

const libPromise = esbuild ? loadLib() : null;
const data = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'outfitting.json'), 'utf8'));

// ── 1. Справочник ──────────────────────────────────────────────────────

test('справочник верфи содержит корабли, модули и чертежи', () => {
  assert.ok(Object.keys(data.ships).length >= 35, 'кораблей должно быть не меньше 35');
  assert.ok(Object.keys(data.blueprints).length >= 70, 'чертежей должно быть не меньше 70');
  for (const group of ['pp', 't', 'fsd', 'ls', 'pd', 's', 'ft']) {
    assert.ok((data.modules[group] ?? []).length > 0, `нет модулей группы ${group}`);
  }
  const anaconda = data.ships.anaconda;
  assert.equal(anaconda.slots.standard.length, 7, 'основных слотов всегда семь');
  assert.equal(anaconda.bulkheads.length, 5, 'переборок всегда пять');
  assert.ok(anaconda.properties.hullMass > 0);
});

maybe('сборка любого корабля покрывает ровно его слоты', async () => {
  const lib = await libPromise;
  // В исходных данных Coriolis у части новых кораблей заводские списки короче
  // или длиннее набора слотов — сборка обязана это пережить и дать ровно
  // столько записей, сколько слотов у корпуса.
  for (const [id, ship] of Object.entries(data.ships)) {
    const build = lib.defaultBuild(data, id);
    assert.equal(build.standard.length, ship.slots.standard.length, `${id}: основные`);
    assert.equal(build.hardpoints.length, ship.slots.hardpoints.length, `${id}: орудия`);
    assert.equal(build.internal.length, ship.slots.internal.length, `${id}: отсеки`);
    const stats = lib.computeStats(data, build);
    assert.ok(stats.unladenMass > 0, `${id}: нулевая масса`);
    assert.ok(stats.jumpRange > 0, `${id}: нулевой прыжок`);
    assert.ok(stats.powerCapacity > 0, `${id}: нет реактора`);
  }
});

// ── 2. Сборки ──────────────────────────────────────────────────────────

maybe('заводская сборка заполняет основные слоты, «снять всё» очищает орудия', async () => {
  const lib = await libPromise;
  for (const id of ['sidewinder', 'anaconda', 'python']) {
    const build = lib.defaultBuild(data, id);
    assert.equal(build.standard.length, data.ships[id].slots.standard.length);
    assert.ok(build.standard.every((ref) => typeof ref === 'string'), `${id}: пустой основной слот`);
  }
  const stripped = lib.strippedBuild(data, 'anaconda');
  assert.ok(stripped.hardpoints.every((ref) => ref === null), 'орудия должны сниматься');
  assert.deepEqual(stripped.mods, {}, 'инженерия должна сбрасываться');
});

maybe('слоты сборки знают свой класс, секцию и модуль', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'python');
  const slots = lib.buildSlots(data, build);
  assert.equal(
    slots.length,
    data.ships.python.slots.standard.length
      + data.ships.python.slots.hardpoints.length
      + data.ships.python.slots.internal.length,
  );
  const fsd = slots.find((slot) => slot.section === 'standard' && slot.index === 2);
  assert.equal(fsd.module.grp, 'fsd', 'третий основной слот — это FSD');
  assert.ok(slots.every((slot) => new Set([slot.key]).size === 1));
  assert.equal(new Set(slots.map((slot) => slot.key)).size, slots.length, 'ключи слотов уникальны');
});

// ── 3. Формулы ─────────────────────────────────────────────────────────

maybe('сводка заводской Sidewinder похожа на игровую', async () => {
  const lib = await libPromise;
  const stats = lib.computeStats(data, lib.defaultBuild(data, 'sidewinder'));
  assert.ok(stats.unladenMass > 20 && stats.unladenMass < 50, `масса ${stats.unladenMass}`);
  assert.ok(stats.jumpRange > 5 && stats.jumpRange < 12, `прыжок ${stats.jumpRange}`);
  assert.ok(stats.totalRange >= stats.jumpRange, 'полный радиус не меньше одного прыжка');
  assert.ok(stats.shield > 0, 'у заводской Sidewinder есть щит');
  assert.ok(stats.armour > 0);
  assert.ok(stats.powerCapacity > 0 && stats.powerRetracted > 0);
  assert.ok(stats.cost > 0);
});

maybe('заводская Anaconda тяжелее и дальнобойнее Sidewinder', async () => {
  const lib = await libPromise;
  const small = lib.computeStats(data, lib.defaultBuild(data, 'sidewinder'));
  const big = lib.computeStats(data, lib.defaultBuild(data, 'anaconda'));
  assert.ok(big.unladenMass > small.unladenMass * 10);
  assert.ok(big.jumpRange > small.jumpRange, 'Anaconda прыгает дальше');
  assert.ok(big.cargo > small.cargo);
});

maybe('облегчение увеличивает дальность прыжка', async () => {
  const lib = await libPromise;
  const heavy = lib.defaultBuild(data, 'anaconda');
  const light = lib.strippedBuild(data, 'anaconda');
  const heavyStats = lib.computeStats(data, heavy);
  const lightStats = lib.computeStats(data, light);
  assert.ok(lightStats.unladenMass < heavyStats.unladenMass, 'снятие модулей облегчает корабль');
  assert.ok(lightStats.jumpRange > heavyStats.jumpRange, 'лёгкий корабль прыгает дальше');
});

maybe('тяжёлые переборки прибавляют массу и броню', async () => {
  const lib = await libPromise;
  const base = lib.defaultBuild(data, 'python');
  const light = lib.computeStats(data, base);
  const heavy = lib.computeStats(data, { ...base, bulkhead: 4 });
  assert.ok(heavy.unladenMass > light.unladenMass, 'военные переборки тяжелее');
  assert.ok(heavy.armour > light.armour, 'военные переборки крепче');
  assert.ok(heavy.jumpRange < light.jumpRange, 'и дальность из-за них падает');
});

// ── 4. Инженерия ───────────────────────────────────────────────────────

maybe('дальнобойный FSD увеличивает дальность, и чем выше уровень — тем сильнее', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'anaconda');
  const key = 'S2';
  const base = lib.computeStats(data, build).jumpRange;
  const grade3 = lib.computeStats(data, {
    ...build,
    mods: { [key]: { blueprint: 'FSD_LongRange', grade: 3, quality: 1 } },
  }).jumpRange;
  const grade5 = lib.computeStats(data, {
    ...build,
    mods: { [key]: { blueprint: 'FSD_LongRange', grade: 5, quality: 1 } },
  }).jumpRange;
  assert.ok(grade3 > base, 'третий уровень уже даёт прибавку');
  assert.ok(grade5 > grade3, 'пятый уровень сильнее третьего');
  assert.ok(grade5 < base * 2, 'но не вдвое — иначе формула завышена');
});

maybe('качество доработки двигает результат между минимумом и максимумом', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'anaconda');
  const withQuality = (quality) => lib.computeStats(data, {
    ...build,
    mods: { 'S2': { blueprint: 'FSD_LongRange', grade: 5, quality } },
  }).jumpRange;
  assert.ok(withQuality(0) < withQuality(0.5), 'минимальное качество слабее среднего');
  assert.ok(withQuality(0.5) < withQuality(1), 'среднее слабее максимального');
});

maybe('усиленный чертёж реактора прибавляет мощность', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'python');
  const base = lib.computeStats(data, build).powerCapacity;
  const boosted = lib.computeStats(data, {
    ...build,
    mods: { 'S0': { blueprint: 'PowerPlant_Boosted', grade: 5, quality: 1 } },
  }).powerCapacity;
  assert.ok(boosted > base, `реактор должен усиливаться: ${base} → ${boosted}`);
});

// ── 5. Ссылка на сборку ────────────────────────────────────────────────

maybe('сборка переживает кодирование в ссылку', async () => {
  const lib = await libPromise;
  const build = {
    ...lib.defaultBuild(data, 'python'),
    name: 'Грузовик колонии',
    bulkhead: 2,
    mods: { 'S2': { blueprint: 'FSD_LongRange', grade: 5, quality: 0.8 } },
  };
  const decoded = lib.decodeBuild(lib.encodeBuild(build));
  assert.deepEqual(decoded, build);
  assert.equal(lib.decodeBuild('не-код'), null, 'кривой код не должен ронять страницу');
  assert.equal(lib.decodeBuild(''), null);
});

// ── 6. Дерево инженеров ────────────────────────────────────────────────

maybe('дерево инженеров связно и без циклов', async () => {
  const lib = await libPromise;
  const ids = new Set(lib.ENGINEERS.map((engineer) => engineer.id));
  assert.equal(ids.size, lib.ENGINEERS.length, 'идентификаторы уникальны');
  for (const engineer of lib.ENGINEERS) {
    for (const parent of engineer.from) {
      assert.ok(ids.has(parent), `${engineer.id}: нет наставника ${parent}`);
      assert.equal(
        lib.ENGINEER_BY_ID.get(parent).branch,
        engineer.branch,
        `${engineer.id}: наставник из другой ветки`,
      );
    }
    const path = lib.pathTo(engineer.id);
    assert.equal(path[path.length - 1].id, engineer.id);
    assert.equal(new Set(path.map((step) => step.id)).size, path.length, `${engineer.id}: цикл в дереве`);
  }
  assert.ok(lib.rootsOf('ship').length >= 5, 'корабельных инженеров первой линии пятеро');
  assert.ok(lib.rootsOf('odyssey').length >= 6);
  assert.equal(lib.ENGINEERS.filter((engineer) => engineer.branch === 'ship').length, 25);
});

maybe('у каждого корабельного инженера есть чертежи в справочнике верфи', async () => {
  const lib = await libPromise;
  for (const engineer of lib.ENGINEERS.filter((item) => item.branch === 'ship')) {
    const names = lib.lookupNames(engineer);
    const merged = names.flatMap((name) => Object.entries(data.engineers[name] ?? {}));
    assert.ok(merged.length > 0, `${engineer.name}: нет чертежей — разошлись имена`);
    for (const [key, grade] of merged) {
      const [group, blueprint] = key.split(':');
      assert.ok(data.groups[group] || group === 'bh', `${engineer.name}: неизвестная группа ${group}`);
      assert.ok(data.blueprints[blueprint], `${engineer.name}: неизвестный чертёж ${blueprint}`);
      assert.ok(grade >= 1 && grade <= 5, `${engineer.name}: уровень ${grade}`);
    }
  }
});

maybe('ссылка из верфи открывает нужного инженера по имени', async () => {
  const lib = await libPromise;
  // В справочнике верфи инженеры записаны именами — ссылка из окна доработки
  // должна открывать карточку, а не пустую страницу.
  for (const name of Object.keys(data.engineers)) {
    const engineer = lib.resolveEngineer(name);
    assert.ok(engineer, `имя из справочника не нашлось в дереве: ${name}`);
    assert.ok(lib.lookupNames(engineer).includes(name), `${name} → ${engineer.name}`);
  }
  assert.equal(lib.resolveEngineer('farseer').id, 'farseer', 'идентификатор тоже работает');
  assert.equal(lib.resolveEngineer('нет такого'), null);
  assert.equal(lib.resolveEngineer(null), null);
});

maybe('у инженеров Одиссеи описаны умения, а условия доступа заполнены у всех', async () => {
  const lib = await libPromise;
  for (const engineer of lib.ENGINEERS) {
    assert.ok(engineer.unlock.length > 5, `${engineer.name}: не описано приглашение`);
    assert.ok(engineer.system && engineer.station, `${engineer.name}: не указано место`);
    assert.ok(engineer.focus.length > 5, `${engineer.name}: не описана специализация`);
    if (engineer.branch === 'odyssey') {
      assert.ok((engineer.skills ?? []).length >= 3, `${engineer.name}: мало умений`);
    }
  }
});
