/**
 * Зависимости экономик от тел, торговые рынки и связи построек
 * (`src/lib/architect/economy.ts` + `installationLinks` из каталога).
 *
 * Проверяет ровно то, что просили в задаче: экономика постройки зависит от
 * тела (добыча — на кольцах/металлах, сельское хозяйство — на землеподобных),
 * у каждой экономики есть ориентировочный рынок, а связи построек
 * (предшественник → постройка → что открывает) согласованы с каталогом.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_TRAIT_LABELS_RU,
  ECONOMY_AFFINITY,
  ECONOMY_MARKET,
  bodyBoostedEconomies,
  bodyTraits,
  economyBodyFit,
} from '../../src/lib/architect/economy.ts';
import { ECONOMY_LABELS_RU, installationLinks } from '../../src/lib/architect/catalogue.ts';

const EMPTY_SIGNALS = {
  bio: 0, geo: 0, human: 0, thargoid: 0, guardian: 0, other: 0, genuses: [],
};

function body(overrides = {}) {
  return {
    name: 'Test A',
    bodyId: 1,
    kind: 'planet',
    subType: 'Rocky body',
    distanceLs: 100,
    radiusKm: 3000,
    gravity: 0.5,
    tempK: 200,
    landable: true,
    terraformable: false,
    hasAtmosphere: false,
    volcanism: false,
    hasRings: false,
    signals: { ...EMPTY_SIGNALS },
    features: [],
    ...overrides,
  };
}

test('bodyTraits: подтип и флаги превращаются в признаки', () => {
  const ringed = bodyTraits(body({ subType: 'High metal content world', hasRings: true, volcanism: true }));
  assert.ok(ringed.has('rings'));
  assert.ok(ringed.has('hmc'));
  assert.ok(ringed.has('volcanism'));

  const earth = bodyTraits(body({ subType: 'Earth-like world', hasAtmosphere: true, terraformable: true }));
  assert.ok(earth.has('earthlike'));
  assert.ok(earth.has('atmosphere'));
  assert.ok(earth.has('terraformable'));

  // «Rocky ice world» — ледяное, а не каменистое.
  const ice = bodyTraits(body({ subType: 'Rocky ice world' }));
  assert.ok(ice.has('icy'));
  assert.ok(!ice.has('rocky'));
});

test('economyBodyFit: добыча усиливается кольцами, но не на голом камне', () => {
  const onRings = economyBodyFit('extraction', body({ subType: 'Icy body', hasRings: true }));
  assert.equal(onRings.level, 'boost');
  assert.ok(onRings.matched.includes('rings'));

  const bare = economyBodyFit('extraction', body({ subType: 'Rocky body' }));
  assert.equal(bare.level, 'weak');
  assert.match(bare.reason, /подошл/);
});

test('economyBodyFit: сельское хозяйство любит землеподобные и терраформируемые', () => {
  assert.equal(economyBodyFit('agriculture', body({ subType: 'Earth-like world' })).level, 'boost');
  assert.equal(economyBodyFit('agriculture', body({ terraformable: true })).level, 'boost');
  assert.equal(economyBodyFit('agriculture', body({ subType: 'Icy body' })).level, 'weak');
});

test('economyBodyFit: независимые от тела экономики всегда нейтральны', () => {
  for (const economy of ['military', 'colony', 'service']) {
    assert.equal(economyBodyFit(economy, body({ subType: 'Rocky body' })).level, 'neutral');
    assert.equal(ECONOMY_AFFINITY[economy].bodyDependent, false);
  }
  // «none» — постройка без экономики.
  assert.equal(economyBodyFit('none', body()).level, 'neutral');
});

test('bodyBoostedEconomies: тело с кольцами усиливает добычу/переработку/туризм', () => {
  const boosted = bodyBoostedEconomies(body({ subType: 'Metal-rich body', hasRings: true }));
  assert.ok(boosted.includes('extraction'));
  assert.ok(boosted.includes('refinery'));
  // На ледяном теле без колец/атмосферы/геологии — ничего не усиливается.
  assert.deepEqual(bodyBoostedEconomies(body({ subType: 'Icy body' })), []);
});

test('ECONOMY_MARKET и ECONOMY_AFFINITY заданы для всех экономик', () => {
  const economies = Object.keys(ECONOMY_LABELS_RU);
  for (const economy of economies) {
    assert.ok(ECONOMY_MARKET[economy], `нет рынка для ${economy}`);
    assert.ok(ECONOMY_AFFINITY[economy], `нет affinity для ${economy}`);
    assert.ok(Array.isArray(ECONOMY_MARKET[economy].produces));
    assert.ok(Array.isArray(ECONOMY_MARKET[economy].imports));
  }
  // Профильные экономики реально что-то продают.
  assert.ok(ECONOMY_MARKET.agriculture.produces.length > 0);
  assert.ok(ECONOMY_MARKET.extraction.produces.length > 0);
});

test('BODY_TRAIT_LABELS_RU покрывает все усиливающие признаки', () => {
  for (const affinity of Object.values(ECONOMY_AFFINITY)) {
    for (const trait of affinity.boost) {
      assert.ok(BODY_TRAIT_LABELS_RU[trait], `нет подписи признака ${trait}`);
    }
  }
});

test('installationLinks: предшественник ↔ зависимая ↔ что открывает', () => {
  // Спутник (hermes) — предшественник турпоселений и открывает их как сервис.
  const hermes = installationLinks('hermes');
  assert.ok(hermes.enables.some((entry) => entry.id === 'tourist-settlement'));
  const requiredIds = hermes.requiredBy.map((ref) => ref.id);
  assert.ok(requiredIds.length > 0, 'у спутника должны быть зависимые постройки');
  // Все зависимые постройки действительно объявляют спутник предшественником.
  for (const id of requiredIds) {
    const links = installationLinks(id);
    assert.ok(links.requires.some((req) => req.options.some((option) => option.id === 'hermes')));
  }

  // Турпоселение (aergia) требует спутник.
  const aergia = installationLinks('aergia');
  assert.equal(aergia.requires.length, 1);
  assert.equal(aergia.requires[0].preReq, 'satellite');
  assert.ok(aergia.requires[0].options.some((option) => option.id === 'hermes'));
});

test('installationLinks: самостоятельная постройка без связей', () => {
  // Кориолис (no_truss) — порт без предшественника; связей-предшественников нет.
  const coriolis = installationLinks('no_truss');
  assert.equal(coriolis.requires.length, 0);
});
