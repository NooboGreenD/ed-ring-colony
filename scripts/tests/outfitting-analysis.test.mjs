/**
 * Боевая аналитика верфи и обмен сборками.
 *
 * Проверяем ровно то, на что смотрит пользователь в правой панели и в окне
 * обмена — цифры, которые нельзя перепроверить на глаз:
 *
 * 1. Скорострельность и DPS орудий считаются по формулам игры, включая
 *    лучевые лазеры (у них урон уже в секунду) и очередные лазеры.
 * 2. Сводка атаки складывает орудия, делит урон по типам и честно говорит,
 *    сколько секунд можно стрелять без паузы при текущих пипках.
 * 3. Сводка защиты: усилители щита складываются мультипликативно и
 *    «затухают» после 30 %, эффективный запас больше сырого, броня и
 *    прочность модулей считаются отдельно.
 * 4. Кривые для графиков монотонны и начинаются там, где надо.
 * 5. Разбивка стоимости совпадает с общей сметой сборки.
 * 6. Код Coriolis переживает круг «сборка → код → сборка» без потерь.
 * 7. Внутренние имена Frontier собираются и разбираются обратно, а SLEF
 *    переносит сборку целиком.
 * 8. Список Merc Coin связан со справочником, а параметры модуля
 *    раскладываются по разделам фильтра.
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
  const dir = mkdtempSync(join(ROOT, '.tmp-outfitting-analysis-'));
  tempDirs.push(dir);
  const entry = join(dir, 'entry.ts');
  const bundle = join(dir, 'lib.mjs');
  writeFileSync(
    entry,
    [
      "export * from '@/lib/outfitting/calc';",
      "export * from '@/lib/outfitting/build';",
      "export * from '@/lib/outfitting/analysis';",
      "export * from '@/lib/outfitting/exchange';",
      "export * from '@/lib/outfitting/fdnames';",
      "export * from '@/lib/outfitting/symbols';",
      "export * from '@/lib/outfitting/merccoin';",
      "export * from '@/lib/outfitting/specs';",
      "export { issueText } from '@/lib/i18n/exchangeText';",
      '',
    ].join('\n'),
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: { '@': join(ROOT, 'src') },
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });
  return import(bundle);
}

const libPromise = esbuild ? loadLib() : null;
const data = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'outfitting.json'), 'utf8'));

const PIPS = { sys: 2, eng: 2, wep: 2 };

/** Поставить модуль в первый подходящий пилон указанного класса. */
function fitHardpoint(lib, build, group, moduleClass, mount) {
  const module = (data.modules[group] ?? []).find(
    (candidate) => candidate.class === moduleClass && (!mount || candidate.mount === mount),
  );
  assert.ok(module, `в справочнике нет ${group} класса ${moduleClass}`);
  const slots = lib.buildSlots(data, build);
  const slot = slots.find(
    (candidate) => candidate.section === 'hardpoints' && candidate.class >= moduleClass && !candidate.module,
  );
  assert.ok(slot, 'у корабля нет свободного пилона нужного размера');
  build.hardpoints[slot.index] = lib.moduleRef(module);
  return module;
}

// ── 1. Скорострельность и урон одного орудия ──────────────────────────

maybe('скорострельность считается по очереди и интервалу, у лучевых она равна единице', async () => {
  const { weaponMetrics, weaponRoF } = await libPromise;

  const beam = (data.modules.bl ?? []).find((module) => module.class === 1);
  assert.ok(beam, 'нужен лучевой лазер класса 1');
  assert.equal(beam.fireint, undefined, 'у лучевого лазера нет интервала выстрела');
  assert.equal(weaponRoF(beam), 1, 'лучевой лазер считается как урон в секунду');
  const beamMetrics = weaponMetrics(beam);
  assert.ok(Math.abs(beamMetrics.dps - Number(beam.damage)) < 1e-6, 'DPS лучевого равен его damage');
  assert.ok(beamMetrics.eps > 0, 'лучевой тратит заряд WEP');

  const burst = (data.modules.ul ?? []).find((module) => module.burst && module.burstrof && module.fireint);
  assert.ok(burst, 'нужен очередной лазер с описанной очередью');
  const expected = burst.burst / (((burst.burst - 1) / burst.burstrof) + burst.fireint);
  assert.ok(Math.abs(weaponRoF(burst) - expected) < 1e-9, 'очередь считается по формуле игры');

  const multiCannon = (data.modules.mc ?? []).find(
    (module) => module.clip && module.reload && module.fireint,
  );
  assert.ok(multiCannon, 'нужна мультипушка с обоймой');
  const metrics = weaponMetrics(multiCannon);
  assert.ok(metrics.sdps > 0 && metrics.sdps < metrics.dps, 'перезарядка снижает устойчивый урон');
  assert.ok(metrics.clipTime > 0, 'обойма расстреливается за конечное время');
});

maybe('урон раскладывается по типам, по умолчанию он термический', async () => {
  const { weaponMetrics, DAMAGE_TYPES } = await libPromise;

  const pulse = (data.modules.pl ?? []).find((module) => module.class === 1);
  const pulseMetrics = weaponMetrics(pulse);
  assert.ok(pulseMetrics.dpsByType.thermal > 0, 'импульсный лазер — термический');
  assert.equal(pulseMetrics.dpsByType.kinetic, 0);

  const plasma = (data.modules.pa ?? []).find((module) => module.damagedist);
  assert.ok(plasma, 'нужен плазменный ускоритель со смешанным уроном');
  const plasmaMetrics = weaponMetrics(plasma);
  const sum = DAMAGE_TYPES.reduce((total, type) => total + plasmaMetrics.dpsByType[type], 0);
  assert.ok(Math.abs(sum - plasmaMetrics.dps) < 1e-6, 'сумма по типам равна полному DPS');
  assert.ok(plasmaMetrics.dpsByType.absolute > 0, 'у плазмы есть абсолютная доля');
});

// ── 2. Сводка атаки ───────────────────────────────────────────────────

maybe('сводка атаки складывает орудия и считает время непрерывного огня', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'vulture');
  for (const slot of lib.buildSlots(data, build)) {
    if (slot.section === 'hardpoints' && slot.class > 0) build.hardpoints[slot.index] = null;
  }
  const beam = fitHardpoint(lib, build, 'bl', 3, 'F');
  const stats = lib.computeStats(data, build);

  const hot = lib.offenceSummary(data, build, stats, { sys: 0, eng: 2, wep: 0 });
  assert.ok(hot.dps > 0, 'DPS сборки больше нуля');
  assert.ok(Math.abs(hot.dps - Number(beam.damage)) < 1e-6, 'одно орудие — его же DPS');
  assert.ok(Number.isFinite(hot.sustainTime), 'без пипок WEP конденсатор кончается');

  const cool = lib.offenceSummary(data, build, stats, { sys: 0, eng: 0, wep: 4 });
  assert.ok(cool.sustainTime >= hot.sustainTime, 'пипки в WEP продлевают огонь');
  assert.equal(cool.wepRecharge > hot.wepRecharge, true, 'подкачка растёт с пипками');

  const empty = lib.offenceSummary(data, lib.strippedBuild(data, 'vulture'), stats, PIPS);
  assert.equal(empty.weapons.length, 0);
  assert.equal(empty.dps, 0);
  assert.equal(empty.sustainTime, Infinity, 'без орудий стрелять можно вечно');
});

// ── 3. Сводка защиты ──────────────────────────────────────────────────

maybe('инженерные усилители щита складываются мультипликативно и затухают после 30 %', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'anaconda');
  const stats = lib.computeStats(data, build);
  const summary = lib.defenceSummary(data, build, stats, PIPS);

  assert.ok(summary.shield.total >= summary.shield.generator, 'усилители не уменьшают щит');
  assert.ok(summary.armour.total > 0, 'броня корпуса учтена');
  for (const type of ['kinetic', 'thermal', 'explosive', 'caustic']) {
    const expected = summary.armour.total / (1 - summary.armour.resistances[type]);
    assert.ok(
      Math.abs(summary.armour.effective[type] - expected) < 1e-6,
      `эффективная броня по ${type} считается из сопротивления`,
    );
  }
  // У обычных сплавов сопротивление кинетике отрицательное: брони «меньше».
  assert.ok(summary.armour.resistances.kinetic < 0, 'лёгкий сплав хуже держит кинетику');
  assert.ok(summary.armour.effective.kinetic < summary.armour.total, 'минус в сопротивлении режет броню');

  const reactive = lib.defaultBuild(data, 'anaconda');
  reactive.bulkhead = 4;
  const reactiveSummary = lib.defenceSummary(data, reactive, lib.computeStats(data, reactive), PIPS);
  assert.ok(
    reactiveSummary.armour.resistances.kinetic > 0,
    'реактивная броня держит кинетику',
  );
  assert.ok(
    reactiveSummary.armour.effective.kinetic > reactiveSummary.armour.total,
    'положительное сопротивление увеличивает эффективную броню',
  );

  assert.ok(summary.totalEffective > 0, 'живучесть посчитана');

  // Базовый усилитель сопротивлений не даёт: они появляются только после
  // инженера, поэтому «затухание» проверяем на прокачанных усилителях.
  const booster = (data.modules.sb ?? []).find((module) => module.rating === 'A');
  assert.ok(booster, 'нужен усилитель щита рейтинга A');
  assert.equal(booster.kinres, 0, 'у заводского усилителя сопротивлений нет');

  const bare = lib.defaultBuild(data, 'anaconda');
  for (const slot of lib.buildSlots(data, bare)) {
    if (slot.section === 'hardpoints' && slot.class === 0) bare.hardpoints[slot.index] = null;
  }
  const bareSummary = lib.defenceSummary(data, bare, lib.computeStats(data, bare), PIPS);

  const boosted = { ...bare, hardpoints: [...bare.hardpoints], mods: { ...bare.mods } };
  let fitted = 0;
  for (const slot of lib.buildSlots(data, boosted)) {
    if (slot.section === 'hardpoints' && slot.class === 0) {
      boosted.hardpoints[slot.index] = lib.moduleRef(booster);
      boosted.mods[slot.key] = { blueprint: 'ShieldBooster_Kinetic', grade: 5, quality: 1 };
      fitted += 1;
    }
  }
  assert.ok(fitted >= 4, 'у Анаконды есть утилиты под усилители');

  const single = lib.effectiveModule(data, booster, { blueprint: 'ShieldBooster_Kinetic', grade: 5, quality: 1 });
  assert.ok(single.kinres > 0, 'чертёж даёт сопротивление кинетике');

  const boostedStats = lib.computeStats(data, boosted);
  const boostedSummary = lib.defenceSummary(data, boosted, boostedStats, PIPS);

  assert.ok(boostedSummary.shield.total > bareSummary.shield.total, 'усилители увеличивают запас щита');
  assert.ok(
    boostedSummary.shield.resistances.kinetic > bareSummary.shield.resistances.kinetic,
    'усилители увеличивают сопротивление',
  );

  const naive = 1 - (1 - bareSummary.shield.resistances.kinetic) * (1 - single.kinres) ** fitted;
  assert.ok(
    boostedSummary.shield.resistances.kinetic < naive,
    `затухание должно срезать сопротивление: ${boostedSummary.shield.resistances.kinetic} против ${naive}`,
  );
  assert.ok(
    boostedSummary.shield.effective.kinetic > boostedSummary.shield.total,
    'эффективный запас больше сырого',
  );

  const withPips = lib.defenceSummary(data, boosted, boostedStats, { sys: 4, eng: 1, wep: 1 });
  assert.ok(
    withPips.shield.effective.base > boostedSummary.shield.effective.base,
    'пипки SYS увеличивают эффективный щит',
  );
});

// ── 4. Кривые для графиков ────────────────────────────────────────────

maybe('кривые загрузки монотонны и начинаются от пустого корабля', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'type_6_transporter');
  const stats = lib.computeStats(data, build);

  const cargo = lib.cargoCurve(data, build, stats, 8);
  assert.equal(cargo.length, 9);
  assert.equal(cargo[0].cargo, 0);
  for (let index = 1; index < cargo.length; index += 1) {
    assert.ok(cargo[index].mass > cargo[index - 1].mass, 'груз увеличивает массу');
    assert.ok(cargo[index].jumpRange <= cargo[index - 1].jumpRange + 1e-9, 'прыжок не растёт от груза');
    assert.ok(cargo[index].speed <= cargo[index - 1].speed + 1e-9, 'скорость не растёт от груза');
  }

  const fuel = lib.fuelCurve(data, build, stats, 8);
  assert.equal(fuel[0].fuel, 0);
  assert.ok(fuel.at(-1).fuel > 0, 'последняя точка — полный бак');

  const engPips = lib.engPipCurve(stats);
  assert.equal(engPips.length, 5);
  assert.ok(engPips[4].speed > engPips[0].speed, 'пипки ENG ускоряют корабль');
  assert.ok(engPips[4].boost > engPips[4].speed, 'форсаж быстрее обычного хода');

  const sysPips = lib.sysPipCurve(1000, 0.2);
  assert.ok(sysPips[4].value > sysPips[0].value, 'пипки SYS увеличивают эффективный щит');
  assert.equal(lib.sysPipCurve(0, 0.2)[2].value, 0, 'без щита эффективного запаса нет');
});

maybe('разбивка стоимости и энергии совпадает со сводкой', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'python');
  const stats = lib.computeStats(data, build);

  const cost = lib.costBreakdown(data, build);
  const total = cost.reduce((sum, entry) => sum + entry.value, 0);
  assert.ok(Math.abs(total - stats.cost) < 1, `смета ${total} против сводки ${stats.cost}`);
  assert.ok(cost.some((entry) => entry.key === 'hull'), 'корпус отдельной строкой');

  const power = lib.powerBreakdown(data, build);
  const draw = power.reduce((sum, entry) => sum + entry.value, 0);
  assert.ok(draw > 0, 'сборка что-то потребляет');
  assert.ok(draw <= stats.powerDeployed + 1e-6, 'разбивка не больше полного потребления');
});

// ── 5. Обмен с Coriolis ───────────────────────────────────────────────

maybe('код Coriolis переживает круг «сборка → код → сборка»', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'python');
  build.bulkhead = 3;

  const code = lib.toCoriolisCode(data, build);
  assert.match(code, /^A3/, 'версия и переборка в начале кода');

  const result = lib.fromCoriolisCode(data, 'python', code);
  assert.ok(result.build, 'код разобрался');
  assert.equal(result.build.bulkhead, 3);
  assert.deepEqual(result.build.standard, build.standard);
  assert.deepEqual(result.build.hardpoints, build.hardpoints);
  assert.deepEqual(result.build.internal, build.internal);
  assert.ok(
    result.issues.some((issue) => /инженери/i.test(lib.issueText(issue, 'ru'))),
    'пользователя предупредили, что инженерия не переносится',
  );

  const url = lib.coriolisUrl(data, build);
  const parsed = lib.parseCoriolisUrl(url);
  assert.equal(parsed.ship, 'python');
  assert.equal(parsed.code, code);

  // Пустые слоты обозначаются двумя дефисами и возвращаются пустыми.
  const stripped = lib.strippedBuild(data, 'eagle');
  const strippedBack = lib.fromCoriolisCode(data, 'eagle', lib.toCoriolisCode(data, stripped));
  assert.deepEqual(strippedBack.build.hardpoints, stripped.hardpoints);
});

maybe('разбор вставленного текста узнаёт ссылки и отказывается от EDSY понятным образом', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'asp');

  const fromCoriolis = lib.parseImport(data, lib.coriolisUrl(data, build));
  assert.equal(fromCoriolis.format, 'coriolis');
  assert.equal(fromCoriolis.build.ship, 'asp');

  const fromNative = lib.parseImport(data, `https://example.com/outfitting?b=${lib.encodeBuild(build)}`);
  assert.equal(fromNative.format, 'native');
  assert.deepEqual(fromNative.build.internal, build.internal);

  const fromEdsy = lib.parseImport(data, 'https://edsy.org/#/L=Jl00000H4C0S00,Jpq8-');
  assert.equal(fromEdsy.build, null);
  // Сообщение приходит кодом, текст подставляет интерфейс на своём языке.
  assert.equal(fromEdsy.issues[0].code, 'exchange.edsyLink');
  const edsyText = lib.issueText(fromEdsy.issues[0], 'ru');
  assert.match(edsyText, /EDSY/);
  assert.match(edsyText, /SLEF/);
  assert.match(lib.issueText(fromEdsy.issues[0], 'en'), /EDSY/);

  assert.equal(lib.parseImport(data, '').issues[0].level, 'error');
});

// ── 6. Внутренние имена Frontier и SLEF ───────────────────────────────

maybe('имена Frontier собираются и разбираются обратно', async () => {
  const lib = await libPromise;
  const { moduleSymbol, parseSymbol, shipFdName, shipCoriolisId, bulkheadSymbol, bulkheadIndex } = lib;

  assert.equal(
    moduleSymbol({ grp: 'pp', class: 6, rating: 'A' }),
    'Int_Powerplant_Size6_Class5',
  );
  assert.equal(
    moduleSymbol({ grp: 'bsg', class: 5, rating: 'C' }),
    'Int_ShieldGenerator_Size5_Class3_Fast',
  );
  assert.equal(
    moduleSymbol({ grp: 'pl', class: 2, rating: 'F', mount: 'G' }),
    'Hpt_PulseLaser_Gimbal_Medium',
  );
  assert.equal(moduleSymbol({ grp: 'ft', class: 5, rating: 'C' }), 'Int_FuelTank_Size5_Class3');
  assert.equal(moduleSymbol({ grp: 'ss', class: 1, rating: 'I' }), 'Int_DetailedSurfaceScanner_Tiny');

  assert.deepEqual(parseSymbol('Int_Powerplant_Size6_Class5'), { group: 'pp', class: 6, rating: 'A' });
  assert.deepEqual(parseSymbol('Int_ShieldGenerator_Size5_Class3_Strong'), { group: 'psg', class: 5, rating: 'C' });
  assert.deepEqual(parseSymbol('Hpt_BeamLaser_Turret_Large'), { group: 'bl', class: 3, rating: 'E', mount: 'T' });
  assert.equal(parseSymbol('Hpt_SomethingNobodyKnows_Fixed_Small'), null);

  assert.equal(shipFdName('federal_corvette'), 'federation_corvette');
  assert.equal(shipCoriolisId('typex_3'), 'alliance_challenger');
  assert.equal(shipCoriolisId('anaconda'), 'anaconda');
  assert.equal(bulkheadIndex(bulkheadSymbol('python', 4)), 4);

  // Справочник хранит настоящие имена Frontier, поэтому круг проверяем по
  // индексу: «имя → тот же модуль». Правило (`parseSymbol`) остаётся запасным
  // путём для имён, которых в справочнике нет.
  let checked = 0;
  for (const [group, list] of Object.entries(data.modules)) {
    for (const module of list) {
      if (!module.symbol) continue;
      if (module.rating === 'Z' || module.info) continue;
      const match = lib.moduleBySymbol(data, module.symbol);
      if (!match) {
        // Один символ у нескольких записей (заводские варианты и MercGear) —
        // это ожидаемо: разбор выбирает обычный модуль сам.
        assert.ok(module.preEngineered || module.merc, `имя ${module.symbol} (${group}:${module.id}) не находится`);
        continue;
      }
      assert.equal(match.group, group, `${module.symbol}: группа поехала`);
      if (match.module.id !== module.id) {
        // Общий символ у базового и заводского варианта: индекс обязан отдать
        // обычный модуль, а не «предзаряженный» двойник.
        assert.ok(module.preEngineered || module.merc, `${module.symbol}: вернулся другой модуль`);
        assert.equal(match.module.preEngineered, undefined);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 400, `индекс должен покрывать сотни модулей, а покрыл ${checked}`);

  // Журнальная обёртка и регистр не мешают опознанию.
  assert.equal(lib.moduleBySymbol(data, '$int_powerplant_size6_class5_name;')?.module.rating, 'A');
  assert.equal(lib.moduleBySymbol(data, '') ?? null, null);
});

maybe('Lynx Highliner: Mk II каюты и большой ангар SRV узнаются по имени Frontier', async () => {
  const lib = await libPromise;
  const ship = data.ships.lynx_highliner;
  assert.ok(ship, 'Lynx Highliner должен быть в справочнике');
  assert.equal(ship.properties.hullMass, 260);
  // Три отсека зарезервированы под обычные каюты, остальные — под что угодно.
  const passenger = ship.slots.internal.filter((slot) => typeof slot === 'object' && slot.name === 'Passenger');
  assert.equal(passenger.length, 3, 'у Lynx три пассажирских отсека');
  assert.deepEqual(Object.keys(passenger[0].eligible).sort(), ['pce', 'pci'], 'только эконом и бизнес');

  const build = lib.defaultBuild(data, 'lynx_highliner');
  assert.ok(build.standard.every(Boolean), 'все основные слоты заполнены заводскими модулями');
  const slots = lib.buildSlots(data, build);
  // Mk II каюты ставит только Lynx.
  const lynxCabins = lib.modulesForSlot(data, data.ships.lynx_highliner, slots.find((slot) => slot.section === 'internal' && slot.class === 6))
    .filter((module) => /Mk II/.test(module.name ?? '') && /Passenger/.test(module.name ?? ''));
  assert.ok(lynxCabins.length >= 2, 'Lynx видит каюты Mk II');
  const anacondaCabin = lib.modulesForSlot(data, data.ships.anaconda,
    lib.buildSlots(data, lib.defaultBuild(data, 'anaconda')).find((slot) => slot.section === 'internal' && slot.class === 6))
    .filter((module) => /Mk II/.test(module.name ?? '') && /Passenger/.test(module.name ?? ''));
  assert.deepEqual(anacondaCabin, [], 'другим кораблям каюты Mk II недоступны');

  // Заводская сборка Lynx переживает круг SLEF → Loadout без предупреждений.
  const exported = JSON.parse(lib.toSlef(data, build, 'test').text);
  const back = lib.fromSlef(data, exported, { strict: true });
  assert.ok(back.build, 'сборка собирается обратно');
  assert.deepEqual(back.issues, [], `предупреждений быть не должно: ${back.issues.map((issue) => lib.issueText(issue, 'ru')).join('; ')}`);
  assert.equal(back.build.ship, 'lynx_highliner');

  // Каюты Mk II и ангар SRV ставятся по точному имени Frontier.
  const cabin = data.modules.pce.find((module) => module.id === 'mk2_5d');
  const hangar = data.modules.pv.find((module) => module.id === 'large_2f');
  assert.ok(cabin && hangar);
  assert.equal(cabin.symbol, 'Int_MkII_PassengerCabin_Size5_Class1');
  assert.equal(hangar.symbol, 'Int_LargeBuggyBay_Size2_Class3');
  assert.equal(lib.moduleBySymbol(data, cabin.symbol)?.module.id, 'mk2_5d');
  assert.equal(lib.moduleBySymbol(data, hangar.symbol)?.module.id, 'large_2f');
  assert.equal(cabin.passengers, 24, 'каюта Mk II вмещает в полтора раза больше');
  assert.equal(lib.moduleSymbol(cabin), cabin.symbol, 'выгрузка пишет то же имя, что игра');

  // Ангар SRV ограничен корпусами из набора EDSY, а не «для всех».
  assert.ok(hangar.ships?.includes('anaconda') && !hangar.ships?.includes('sidewinder'));

  // Корабль из журнала узнаётся по игровому имени (`Loadout.Ship`).
  assert.equal(lib.shipCoriolisId('MediumTransport01'), 'lynx_highliner');
  assert.equal(lib.shipCoriolisId('AnacondaMkII'), 'anaconda_mk_ii');
  assert.equal(lib.shipCoriolisId('LakonMiner'), 'type_11_prospector');
  assert.equal(lib.shipCoriolisId('SmallCombat01_NX'), 'kestrel');
});

maybe('SLEF переносит корабль и его модули', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'cobra_mk_iii');
  build.bulkhead = 2;
  build.name = 'Проверка';

  const exported = lib.toSlef(data, build, '0.0.0-test');
  const payload = JSON.parse(exported.text);
  assert.equal(payload[0].data.event, 'Loadout');
  assert.equal(payload[0].data.Ship, 'cobramkiii');
  assert.ok(payload[0].data.Modules.some((module) => module.Slot === 'PowerPlant'));
  assert.ok(payload[0].data.Modules.some((module) => /Hardpoint/.test(module.Slot)));

  const back = lib.fromSlef(data, payload);
  const strictBack = lib.fromSlef(data, payload, { strict: true });
  assert.deepEqual(strictBack.issues, [], `точный режим должен однозначно восстановить типы модулей: ${strictBack.issues.map((issue) => lib.issueText(issue, 'ru')).join('; ')}`);
  assert.ok(back.build, 'SLEF разобрался');
  assert.equal(back.build.ship, 'cobra_mk_iii');
  assert.equal(back.build.bulkhead, 2);
  assert.equal(back.name, 'Проверка');

  // Основные слоты обязаны встать на свои места — они жёстко заданы.
  assert.deepEqual(back.build.standard, build.standard);

  const fitted = back.build.hardpoints.filter(Boolean).length;
  const expected = build.hardpoints.filter(Boolean).length;
  assert.ok(fitted >= expected - 1, `перенеслось ${fitted} орудий из ${expected}`);

  const broken = lib.fromSlef(data, { event: 'Loadout', Ship: 'unknown_ship_42', Modules: [] });
  assert.equal(broken.build, null);
  assert.equal(broken.issues[0].level, 'error');
});

maybe('игровой Loadout различает обычный FSD и SCO-вариант по Frontier symbol', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'anaconda');
  const sco = data.modules.fsd.find((module) => module.class === 6 && module.rating === 'A' && module.name === 'Frame Shift Drive (SCO)');
  assert.ok(sco);
  build.standard[2] = `fsd:${sco.id}`;
  const payload = JSON.parse(lib.toSlef(data, build, 'test').text);
  const fsd = payload[0].data.Modules.find((module) => module.Slot === 'FrameShiftDrive');
  assert.match(fsd.Item, /Hyperdrive_Overcharge/);
  const imported = lib.fromSlef(data, payload, { strict: true });
  assert.equal(imported.build.standard[2], `fsd:${sco.id}`);
  assert.deepEqual(imported.issues, []);
});

maybe('живой Loadout: общий Misc-чертёж, косметика и незнакомый модуль не ломают разбор', async () => {
  const lib = await libPromise;
  const build = lib.defaultBuild(data, 'anaconda');
  const scoop = data.modules.fs.find((module) => module.class === 5 && module.rating === 'A');
  assert.ok(scoop, 'нужен топливозаборник 5A');
  const withScoop = lib.buildSlots(data, build)
    .find((slot) => slot.section === 'internal' && !slot.module && slot.class >= 5);
  assert.ok(withScoop, 'у Anaconda должен быть свободный отсек под 5A');
  build.internal[withScoop.index] = lib.moduleRef(scoop);

  const payload = JSON.parse(lib.toSlef(data, build, 'test').text);
  const modules = payload[0].data.Modules;
  const lifeSupport = modules.find((module) => module.Slot === 'LifeSupport');
  assert.ok(lifeSupport, 'в SLEF есть жизнеобеспечение');
  // Игра присылает общий чертёж как есть: у `ls` в справочнике он называется
  // `LifeSupport_LightWeight`, и без алиаса масса считалась бы неточно.
  lifeSupport.Engineering = { BlueprintName: 'Misc_LightWeight', Level: 5, Quality: 1 };
  const fuelScoop = modules.find((module) => lib.parseSymbol(String(module.Item))?.group === 'fs');
  assert.ok(fuelScoop, 'в SLEF есть топливозаборник');
  // «Scoop rate enhanced» есть в игре, но отсутствует в наборе Coriolis.
  fuelScoop.Engineering = { BlueprintName: 'FuelScoop_Efficiency', Level: 5, Quality: 1 };
  // Косметика лежит в том же списке модулей и не имеет ни массы, ни слота.
  modules.push({ Slot: 'PaintJob', Item: 'PaintJob_Anaconda_Default', On: true, Priority: 1 });
  modules.push({ Slot: 'Decal1', Item: 'Decal_Explorer', On: true, Priority: 1 });
  // Модуль, которого нет в справочнике: это предупреждение, а не отказ.
  modules.push({ Slot: 'TinyHardpoint9', Item: 'Hpt_NoSuchModule_Unknown', On: true, Priority: 1 });

  const baselinePayload = JSON.parse(lib.toSlef(data, build, 'test').text);
  const baseline = lib.fromSlef(data, baselinePayload);
  const imported = lib.fromSlef(data, payload, { strict: true });
  assert.ok(imported.build, 'сборка собирается несмотря на предупреждения');
  assert.deepEqual(imported.issues.filter((issue) => issue.level === 'error'), []);

  // Общий чертёж встал на семейный идентификатор и реально облегчил модуль.
  const lightweight = Object.values(imported.build.mods).map((mod) => mod.blueprint);
  assert.ok(lightweight.includes('LifeSupport_LightWeight'), `ожидался алиас LifeSupport_LightWeight, получено ${lightweight.join(', ')}`);
  assert.ok(lightweight.includes('FuelScoop_Efficiency'), 'чертёж топливозаборника должен распознаваться');
  assert.ok(lib.computeStats(data, imported.build).jumpRange > lib.computeStats(data, baseline.build).jumpRange,
    'облегчённое жизнеобеспечение должно прибавлять дальность');

  // Эффект чертежа топливозаборника: +50 % к скорости заправки и +15 % к питанию.
  const engineered = lib.effectiveModule(data, scoop, { blueprint: 'FuelScoop_Efficiency', grade: 5, quality: 1 });
  assert.ok(Math.abs(Number(engineered.rate) - Number(scoop.rate) * 1.5) < 1e-6, 'скорость заправки +50 %');
  assert.ok(Math.abs(Number(engineered.power) - Number(scoop.power) * 1.15) < 1e-6, 'потребление +15 %');

  const texts = imported.issues.map((issue) => lib.issueText(issue, 'ru')).join('; ');
  assert.doesNotMatch(texts, /PaintJob|Decal/, 'косметика не должна попадать в отчёт');
  assert.doesNotMatch(texts, /Misc_LightWeight|FuelScoop_Efficiency/, `распознанные чертежи не должны ругаться: ${texts}`);
  assert.match(texts, /модуль не распознан/, 'незнакомый модуль обязан остаться в отчёте');
  assert.ok(imported.issues.every((issue) => issue.level === 'warn'), 'незнакомый модуль — предупреждение');
});

maybe('игровой Loadout переносит чертёж, качество и экспериментальный эффект', async () => {
  const lib = await libPromise;
  const sourceBuild = lib.defaultBuild(data, 'anaconda');
  const payload = JSON.parse(lib.toSlef(data, sourceBuild, 'test').text);
  const fsd = payload[0].data.Modules.find((module) => module.Slot === 'FrameShiftDrive');
  fsd.Engineering = { BlueprintName: 'FSD_LongRange', Level: 5, Quality: 1 };
  fsd.ExperimentalEffect = 'MassManager';
  const baseline = lib.fromSlef(data, JSON.parse(lib.toSlef(data, sourceBuild, 'test').text));
  const imported = lib.fromSlef(data, payload);
  assert.ok(imported.build);
  assert.equal(imported.build.standard[2], sourceBuild.standard[2]);
  assert.deepEqual(imported.build.mods.S2, {
    blueprint: 'FSD_LongRange', grade: 5, quality: 1, special: 'special_fsd_heavy',
  });
  const stats = lib.computeStats(data, imported.build);
  assert.ok(stats.jumpRange > lib.computeStats(data, baseline.build).jumpRange, 'инженерный Loadout должен прибавлять дальность');
});

// ── 7. Merc Coin и параметры модулей ──────────────────────────────────

maybe('список Merc Coin связан со справочником верфи', async () => {
  const { MERC_COIN_ITEMS, mercEntryFor, mercEntryForRef, mercCoinCost, mercUpgradeCost } = await libPromise;

  assert.ok(MERC_COIN_ITEMS.length >= 10, 'в списке должен быть весь набор MercGear');

  for (const entry of MERC_COIN_ITEMS) {
    if (!entry.ref) continue;
    const [group, id] = entry.ref.split(':');
    const module = (data.modules[group] ?? []).find((candidate) => candidate.id === id);
    assert.ok(module, `${entry.name}: в справочнике нет модуля ${entry.ref}`);
    assert.equal(mercEntryFor(group, id).id, entry.id, 'запись ищется по группе и id');
  }

  const cargoRack = mercEntryForRef('cr:7X');
  assert.ok(cargoRack, 'расширенный грузовой отсек есть в списке');
  assert.equal(cargoRack.coins, 550);
  assert.equal(mercUpgradeCost(cargoRack, 5), 15 + 20 + 40 + 50);
  assert.equal(mercUpgradeCost(cargoRack, 3), 15 + 20);

  assert.equal(mercCoinCost(['cr:7X', 'cr:7Y', null, 'pp:0A']), 1100);
  assert.equal(mercCoinCost([]), 0);
  assert.equal(mercEntryForRef(null), null);
});

maybe('параметры модуля раскладываются по разделам фильтра', async () => {
  const { moduleSpecValues, specName, specFor, MODULE_SPECS } = await libPromise;

  const generator = (data.modules.sg ?? []).find((module) => module.class === 5 && module.rating === 'A');
  assert.ok(generator, 'нужен генератор щита 5A');
  const format = (value, digits) => value.toFixed(digits);

  const all = moduleSpecValues(generator, 'ru', format);
  assert.ok(all.length > 5, 'у генератора много полей');
  assert.ok(all.some((value) => value.key === 'optmass'), 'оптимальная масса показана');
  assert.ok(!all.some((value) => value.key === 'grp'), 'служебные поля скрыты');

  const massOnly = moduleSpecValues(generator, 'ru', format, ['mass']);
  assert.ok(massOnly.length > 0);
  assert.ok(massOnly.every((value) => value.section === 'mass'), 'фильтр отдаёт только свой раздел');

  const priceOnly = moduleSpecValues(generator, 'ru', format, ['price']);
  assert.deepEqual(priceOnly.map((value) => value.key), ['cost']);

  // Порядок полей задан словарём, а не порядком ключей в JSON.
  const order = all.map((value) => value.key);
  const known = order.filter((key) => specFor(key));
  const reference = MODULE_SPECS.map((spec) => spec.key).filter((key) => known.includes(key));
  assert.deepEqual(known, reference, 'поля идут в объявленном порядке');

  assert.equal(specName('ru', 'optmass'), 'Оптимальная масса');
  assert.equal(specName('en', 'optmass'), 'Optimal mass');
  assert.equal(specName('fr', 'optmass'), 'Optimal mass', 'неизвестный язык откатывается на английский');
  assert.equal(specName('ru', 'какое_то_поле'), 'какое_то_поле', 'незнакомое поле показывается как есть');
});
