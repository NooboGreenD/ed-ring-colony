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
 * 5. Экспериментальные эффекты описаны у всех, применяются к модулю по
 *    правилам игры (проценты, сопротивления «от остатка», интервал вместо
 *    скорострельности) и попадают в сводку.
 * 6. Ссылка на сборку кодируется и раскодируется без потерь.
 * 7. Дерево инженеров связно: у всех наводок есть источник, циклов нет,
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
    "export * from '@/lib/outfitting/calc';\nexport * from '@/lib/outfitting/build';\nexport * from '@/lib/outfitting/specials';\nexport * from '@/lib/engineers/data';\n",
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

// ── 5. Экспериментальные эффекты ───────────────────────────────────────

test('у каждого эффекта есть ключ перевода, материалы и понятные поправки', () => {
  const ids = Object.keys(data.specials);
  assert.ok(ids.length >= 85, `эффектов должно быть не меньше 85, а их ${ids.length}`);

  const objectValued = new Set(['damagedist']);
  for (const [id, special] of Object.entries(data.specials)) {
    assert.ok(special.kind, `у эффекта ${id} нет ключа перевода`);
    assert.match(special.kind, /^[a-z][A-Za-z]*$/, `ключ перевода ${id} должен быть camelCase`);

    for (const [property, value] of Object.entries(special.features ?? {})) {
      if (objectValued.has(property)) {
        const shares = Object.values(value);
        assert.ok(shares.length > 0, `пустое распределение урона у ${id}`);
        const sum = shares.reduce((total, share) => total + share, 0);
        assert.ok(Math.abs(sum - 1) < 1e-6, `доли урона у ${id} должны давать единицу, а дают ${sum}`);
        continue;
      }
      assert.equal(typeof value, 'number', `поправка ${property} у ${id} должна быть числом`);
      assert.ok(Number.isFinite(value), `поправка ${property} у ${id} не число`);
      assert.ok(Math.abs(value) <= 3, `подозрительно большая поправка ${property}=${value} у ${id}`);
    }
  }

  // Эффекты без цифр — это боевые эффекты, у них обязателен `tag`.
  for (const [id, special] of Object.entries(data.specials)) {
    if (Object.keys(special.features ?? {}).length === 0) {
      assert.ok(special.tag, `у эффекта без цифр ${id} должен быть боевой эффект`);
    }
  }

  // Материалы в исходных данных есть не у всех: у пары старых записей
  // («Feedback Cascade» без охлаждения, «Plasma Slug» до разделения) их нет.
  // Такая запись допустима, только если тот же эффект есть в живом варианте.
  const withMaterials = new Set(
    Object.values(data.specials).filter((special) => Object.keys(special.components ?? {}).length > 0).map((special) => special.kind),
  );
  for (const [id, special] of Object.entries(data.specials)) {
    if (Object.keys(special.components ?? {}).length === 0) {
      assert.ok(withMaterials.has(special.kind), `у эффекта ${id} нет ни материалов, ни живого двойника`);
    }
  }
});

test('каждый эффект доступен хотя бы одной группе модулей', () => {
  const reachable = new Set();
  for (const entry of Object.values(data.moduleBlueprints)) {
    for (const id of entry.specials ?? []) reachable.add(id);
  }
  for (const id of reachable) assert.ok(data.specials[id], `группа ссылается на неизвестный эффект ${id}`);
  assert.ok(reachable.size >= 85, `в списках групп должно быть не меньше 85 эффектов, а их ${reachable.size}`);

  // Один и тот же эффект встречается под разными id (обычная и охлаждённая
  // версия «Plasma Slug»), но каждый вид должен где-то предлагаться — иначе
  // мы перевели название, которого игрок никогда не увидит.
  const shown = new Set([...reachable].map((id) => data.specials[id].kind));
  const hidden = [...new Set(Object.values(data.specials).map((special) => special.kind))].filter((kind) => !shown.has(kind));
  assert.deepEqual(hidden, [], `эти эффекты нельзя выбрать ни у одной группы: ${hidden.join(', ')}`);
});

maybe('эффект меняет характеристики модуля по правилам игры', async () => {
  const lib = await libPromise;

  // Проценты: «Увеличенный калибр» — +3 % урона и +5 % энергии.
  const cannon = data.modules.mc.find((module) => module.class === 2 && module.mount === 'F');
  assert.ok(cannon, 'в справочнике должна быть многоствольная пушка класса 2');
  const oversized = lib.effectiveModule(data, cannon, { special: 'special_weapon_damage' });
  assert.ok(Math.abs(oversized.damage - cannon.damage * 1.03) < 1e-9, 'урон должен вырасти на 3 %');
  assert.ok(Math.abs(oversized.power - cannon.power * 1.05) < 1e-9, 'энергия должна вырасти на 5 %');

  // Скорострельность хранится как поправка к интервалу между выстрелами.
  const servos = lib.effectiveModule(data, cannon, { special: 'special_weapon_rateoffire' });
  assert.ok(servos.fireint < cannon.fireint, 'интервал между выстрелами должен сократиться');
  assert.ok(Math.abs(1 / servos.fireint - 1 / cannon.fireint * 1.03) < 1e-3, 'выстрелов в секунду должно стать примерно на 3 % больше');

  // Сопротивления складываются «от остатка», а не напрямую.
  const generator = data.modules.sg.find((module) => module.class === 5 && module.rating === 'A');
  assert.ok(generator, 'в справочнике должен быть генератор щита 5A');
  const weave = lib.effectiveModule(data, generator, { special: 'special_shield_resistive' });
  const base = Number(generator.kinres ?? 0);
  assert.ok(Math.abs(weave.kinres - (base + 0.03 * (1 - base))) < 1e-9, 'сопротивление растёт от остатка');
  assert.ok(weave.kinres < base + 0.03, 'прибавка не должна складываться напрямую');

  // Распределение урона переписывается целиком.
  const incendiary = lib.effectiveModule(data, cannon, { special: 'special_incendiary_rounds' });
  assert.deepEqual(incendiary.damagedist, { K: 0.1, T: 0.9 });
});

maybe('эффект складывается с чертежом и виден в сводке', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'python');

  const plain = lib.computeStats(data, build);
  assert.equal(plain.experimental, 0, 'в заводской сборке эффектов нет');

  // «Толстое бронирование» на переборке: брони больше, сопротивлений меньше.
  const armoured = lib.computeStats(data, {
    ...build,
    bulkhead: 2,
    mods: { BH: { blueprint: 'Armour_HeavyDuty', grade: 5, quality: 1, special: 'special_armour_chunky' } },
  });
  const blueprintOnly = lib.computeStats(data, {
    ...build,
    bulkhead: 2,
    mods: { BH: { blueprint: 'Armour_HeavyDuty', grade: 5, quality: 1 } },
  });
  assert.equal(armoured.experimental, 1, 'эффект переборки должен попадать в счётчик');
  assert.equal(armoured.engineered, 1, 'чертёж переборки должен попадать в счётчик');
  assert.ok(armoured.armour > blueprintOnly.armour, 'толстая броня прочнее');
  assert.ok(armoured.armourResistances.kinetic < blueprintOnly.armourResistances.kinetic, 'толстая броня хуже держит кинетику');

  // «Повышенная ёмкость» на генераторе щита: щит крепче, энергии нужно больше.
  const shieldSlot = lib.buildSlots(data, build).find((slot) => slot.module?.grp === 'sg');
  assert.ok(shieldSlot, 'в заводской Python должен быть генератор щита');
  const hiCap = lib.computeStats(data, {
    ...build,
    mods: { [shieldSlot.key]: { special: 'special_shield_health' } },
  });
  assert.ok(hiCap.shield > plain.shield, 'щит должен стать крепче');
  assert.ok(hiCap.powerDeployed > plain.powerDeployed, 'энергии должно требоваться больше');
  assert.equal(hiCap.experimental, 1);
});

maybe('список изменений эффекта показывает проценты в удобную сторону', async () => {
  const lib = await libPromise;

  const rows = lib.specialFeatures(data, data.specials.special_weapon_rateoffire);
  const rof = rows.find((row) => row.property === 'rof');
  assert.ok(rof, 'у «Многосервоприводов» должна быть строка скорострельности');
  assert.ok(rof.value > 0 && rof.better, 'скорострельность показывается как рост, а не как падение интервала');
  const power = rows.find((row) => row.property === 'power');
  assert.ok(power && !power.better, 'рост потребления энергии — это минус');

  // Сопротивления помечены отдельно: их нельзя читать как обычные проценты.
  const resistive = lib.specialFeatures(data, data.specials.special_shield_resistive);
  assert.ok(resistive.some((row) => row.kind === 'resistance'), 'сопротивления должны иметь свой тип');

  // Чисто боевой эффект не даёт ни одной числовой строки.
  assert.deepEqual(lib.specialFeatures(data, data.specials.special_thermal_vent), []);

  // Эффекты предлагаются только тем группам, у которых они есть.
  const weaponSpecials = lib.specialsForGroup(data, 'mc');
  assert.ok(weaponSpecials.includes('special_weapon_damage'));
  assert.ok(!weaponSpecials.includes('special_shield_health'), 'щитовой эффект не должен предлагаться пушке');
  assert.deepEqual(lib.specialsForGroup(data, 'нет-такой-группы'), []);
});

// ── 6. Ссылка на сборку ────────────────────────────────────────────────

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

// ── 7. Дерево инженеров ────────────────────────────────────────────────

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

// ── 5. Распределитель питания («Пипки») и сравнение модулей ───────────

maybe('пипки SYS увеличивают эффективную ёмкость щита, а ENG влияют на скорость', async () => {
  const lib = await libPromise;

  // 1. SYS сопротивление
  assert.equal(lib.sysDamageResistance(0), 0);
  const res4 = lib.sysDamageResistance(4);
  assert.ok(res4 > 0.55 && res4 <= 0.6, `сопротивление на 4 SYS должно быть ~58-60%, получено ${res4}`);

  const rawShield = 1000;
  const eff0 = lib.pipEffectiveShield(rawShield, 0);
  const eff4 = lib.pipEffectiveShield(rawShield, 4);
  assert.equal(eff0, 1000);
  assert.ok(eff4 > 2300 && eff4 <= 2500, `эффективный щит на 4 SYS должен быть ~2.4-2.5x, получено ${eff4}`);

  // 2. ENG скорость
  const baseSpeed = 300;
  const speed4 = lib.pipAdjustedSpeed(baseSpeed, 0.125, 4);
  const speed2 = lib.pipAdjustedSpeed(baseSpeed, 0.125, 2);
  const speed0 = lib.pipAdjustedSpeed(baseSpeed, 0.125, 0);
  assert.equal(speed4, 300);
  assert.equal(speed2, 225);
  assert.equal(speed0, 150);

  // 3. Восстановление
  assert.equal(lib.pipRechargeRate(4.0, 4), 4.0);
  assert.equal(lib.pipRechargeRate(4.0, 2), 2.0);
  assert.equal(lib.pipRechargeRate(4.0, 0), 0.0);
});

maybe('computeModuleDelta корректно вычисляет разницу характеристик при смене модуля', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'sidewinder');
  const slots = lib.buildSlots(data, build);
  const fsdSlot = slots.find((s) => s.group === 'fsd');
  assert.ok(fsdSlot, 'FSD слот Sidewinder');

  // Кандидат: лучший FSD 2A
  const fsd2A = data.modules.fsd.find((m) => m.class === 2 && m.rating === 'A');
  assert.ok(fsd2A, 'FSD 2A модуль');

  const delta = lib.computeModuleDelta(data, build, fsdSlot, fsd2A);
  assert.ok(delta.jumpRangeDelta > 0, 'прыжок должен вырасти с 2A FSD');
  assert.ok(delta.costDelta > 0, 'цена сборки должна вырасти');
});
