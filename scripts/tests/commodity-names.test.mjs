import test from 'node:test';
import assert from 'node:assert/strict';
import { commodityNames, constructionCommodityKeys, knownCommodityKey, localizedCommodityName } from '../../src/lib/commodityNames.ts';
import { commodityTranslations } from '../../src/lib/i18n/commodities.ts';
import { COMMODITY_LABELS_RU, INSTALLATIONS } from '../../src/lib/architect/catalogue.ts';
import { buildProjectLeaders, canonicalCommodity } from '../../src/lib/architect/projectLeaders.ts';
import { localizeLeaderCommodities } from '../../src/lib/architect/projectLeadersDisplay.ts';

test('game commodity names cover every recipe and normalize tokens, English and legacy Russian names', () => {
  const expected = {
    autofabricators: 'Автосинтезаторы', buildingfabricators: 'Строительные синтезаторы',
    agriculturalmedicines: 'Ветмедикаменты', mutomimager: 'Мюонное видеоустройство',
    cropharvesters: 'Уборочный комбайн', ceramiccomposites: 'Керамокомпозиты',
    structuralregulators: 'Конструкционные регуляторы', foodcartridges: 'Пищевые брикеты',
  };
  for (const [key, label] of Object.entries(expected)) {
    assert.equal(COMMODITY_LABELS_RU[key], label);
    assert.equal(localizedCommodityName(key, 'ru'), label);
  }
  for (const key of new Set(INSTALLATIONS.flatMap((i) => [...Object.keys(i.cargo), ...Object.keys(i.primary?.cargo ?? {})]))) {
    assert.ok(constructionCommodityKeys.includes(key), key);
    assert.match(commodityNames[key].ru, /[А-Яа-я]/, key);
    for (const locale of ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja']) {
      assert.ok(commodityTranslations[locale][`commodity.${key}`], `${locale}:${key}`);
    }
  }
  for (const raw of ['$AutoFabricators_Name;', 'Auto-Fabricators', 'Автофабрикаторы', 'Автосинтезаторы']) {
    assert.equal(knownCommodityKey(raw), 'autofabricators');
    assert.deepEqual(canonicalCommodity(raw), {key: 'autofabricators', label: expected.autofabricators});
  }
  assert.equal(localizedCommodityName('autoFabricators', 'en', 'Автофабрикаторы'), 'Auto-Fabricators');
  assert.equal(localizedCommodityName('powergenerators', 'ru', 'Power Generators'), 'Электрогенераторы');
  assert.equal(localizedCommodityName('tritium', 'ru'), 'Тритий');
  assert.equal(localizedCommodityName('Helium3', 'ru', 'Гелий-3'), 'Гелий-3');
  assert.equal(localizedCommodityName('Helium3', 'en', 'Гелий-3'), 'Helium-3');
  assert.equal(localizedCommodityName('Future Good', 'ru'), 'Future Good');
  assert.equal(localizedCommodityName('future', 'ru', 'Новый товар'), 'Новый товар');
});

export function leaderFixture() {
  return buildProjectLeaders({
    rows: ['Auto-Fabricators', 'Автофабрикаторы', 'Автосинтезаторы'].map((commodity) => ({
      user_id: 'pilot', target: 'site', commodity, tons: 100, ops: 1, system_name: 'Steel',
      market_id: '3900000001', station_name: 'Steel', first_at: null, last_at: null,
    })), activity: [], pilots: new Map([['pilot', {name: 'Steel', member: true, role: 'owner', hidden: false}]]),
    sites: new Map([['3900000001', {name: 'Steel', systemName: 'Steel'}]]), carriers: new Map(), viewerId: 'pilot',
  });
}

test('leaderboard localization covers commodity charts, legends, pilot details, sites and carriers without touching accounting', () => {
  const original = leaderFixture();
  original.carriers = [{carrierId: '1', name: 'Steel', tons: 10, ops: 1, pilots: [], commodities: [{key: 'autofabricators', label: 'Auto-Fabricators', tons: 10}]}];
  original.pilots[0].commodities.push({key: '__other', label: 'Остальные', tons: 1});
  const before = structuredClone(original);
  assert.equal(original.commodities.length, 1, 'legacy and game spellings must not split a good');
  assert.equal(original.commodities[0].tons, 300);
  for (const [locale, name, other] of [['ru', 'Автосинтезаторы', 'Остальные'], ['en', 'Auto-Fabricators', 'Others']]) {
    const view = localizeLeaderCommodities(original, locale, other);
    assert.equal(view.commodities[0].label, name);
    assert.equal(view.pilots[0].commodities[0].label, name);
    assert.equal(view.pilots[0].commodities[1].label, other);
    assert.equal(view.pilots[0].breakdown[0].commodityLabel, name);
    assert.equal(view.sites[0].commodities[0].label, name);
    assert.equal(view.carriers[0].commodities[0].label, name);
    assert.equal(view.pilots[0].name, 'Steel');
    assert.equal(view.sites[0].name, 'Steel');
    assert.equal(view.carriers[0].name, 'Steel');
    assert.deepEqual(view.totals, original.totals);
    assert.deepEqual(view.matrix, original.matrix);
  }
  assert.deepEqual(original, before);
});
