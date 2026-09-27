import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capiProfileRow,
  isBlankProfile,
  normalizeCapiProfile,
  normalizeShips,
  pilotStatsRow,
} from '../../src/lib/capi/profile.ts';

/* ──────────────────────────────────────────────────────────────────────────
   Ответ `/profile` в том виде, в каком его отдаёт Frontier: кредиты, долг и
   ранги лежат ВНУТРИ `commander`, система — в `lastSystem`, станция — в
   `lastStarport`, корабль — в `ship`. Именно на этом расхождении ломалась
   привязка: код читал поля верхнего уровня, которых не существует, и в
   `capi_profiles` уходили одни NULL.
   ────────────────────────────────────────────────────────────────────────── */
const LIVE_PROFILE = {
  commander: {
    id: 1234567,
    name: 'Nova',
    credits: 2153938,
    debt: 500,
    currentShipId: 4,
    alive: true,
    docked: true,
    onfoot: false,
    rank: {
      combat: 5, trade: 3, explore: 6, crime: 0, service: 0,
      empire: 2, federation: 1, power: 0, cqc: 1, soldier: 4, exobiologist: 2,
    },
  },
  lastSystem: { id: 3238296097059, name: 'Colonia', faction: 'independent' },
  lastStarport: { id: 128667761, name: 'Jaques Station', faction: 'independent' },
  ship: {
    id: 4,
    name: 'CobraMkIII',
    shipName: 'Peaceful Pancake',
    shipID: 'EE-224',
    value: { hull: 174498, modules: 1962114, cargo: 17326, total: 2153938 },
    station: { id: 128667761, name: 'Jaques Station' },
    starsystem: { id: 3238296097059, name: 'Colonia', systemaddress: 3238296097059 },
  },
  ships: {
    4: { id: 4, name: 'CobraMkIII', shipName: 'Peaceful Pancake', shipID: 'EE-224', value: { total: 2153938 } },
    7: { id: 7, name: 'Python', shipName: 'Mule', shipID: 'MU-01', value: { total: 56000000 } },
  },
};

test('профиль Frontier разбирается из commander/lastSystem/ship, а не из корня', () => {
  const profile = normalizeCapiProfile(LIVE_PROFILE);

  assert.equal(profile.cmdrName, 'Nova');
  assert.equal(profile.commander.id, '1234567');
  assert.equal(profile.credits, 2153938);
  assert.equal(profile.loan, 500);
  assert.equal(profile.ranks.combat, 5);
  assert.equal(profile.ranks.trade, 3);
  assert.equal(profile.ranks.explore, 6);
  assert.equal(profile.ranks.empire, 2);
  assert.equal(profile.ranks.federation, 1);
  assert.equal(profile.ranks.cqc, 1);
  assert.equal(profile.ranks.soldier, 4);
  assert.equal(profile.ranks.exobiologist, 2);
  assert.equal(profile.currentSystem?.name, 'Colonia');
  assert.equal(profile.currentSystem?.systemAddress, 3238296097059);
  assert.equal(profile.currentStation?.name, 'Jaques Station');
  assert.equal(profile.currentShip, 'Peaceful Pancake');
  assert.equal(profile.currentShipType, 'CobraMkIII');
  assert.equal(profile.currentShipIdent, 'EE-224');
  assert.equal(profile.docked, true);
  assert.equal(profile.ships.length, 2);
});

test('ships приходит и словарём, и массивом', () => {
  const asDict = normalizeShips({ 4: { id: 4, name: 'CobraMkIII' }, 7: { id: 7, name: 'Python' } });
  const asArray = normalizeShips([{ id: 0, name: 'Sidewinder' }]);
  assert.deepEqual(asDict.map((s) => s.shipType), ['CobraMkIII', 'Python']);
  assert.deepEqual(asArray.map((s) => s.shipType), ['Sidewinder']);
  assert.deepEqual(normalizeShips(undefined), []);
});

test('станция показывается только при стыковке', () => {
  const flying = normalizeCapiProfile({
    ...LIVE_PROFILE,
    commander: { ...LIVE_PROFILE.commander, docked: false },
  });
  assert.equal(flying.currentStation, null, 'в полёте «текущей станции» нет');
  assert.equal(flying.lastStarport?.name, 'Jaques Station', 'последняя станция сохраняется');
});

test('пустые строки Frontier не превращаются в пустые значения полей', () => {
  const profile = normalizeCapiProfile({
    commander: { name: 'Solo', docked: false, rank: {} },
    lastSystem: { name: 'Sol' },
    lastStarport: { name: '', faction: '' },
  });
  assert.equal(profile.currentStation, null);
  assert.equal(profile.lastStarport, null);
  assert.equal(profile.currentSystem?.name, 'Sol');
  assert.equal(profile.ranks.combat, null, 'нет ранга — null, а не 0');
});

test('мусор вместо ответа не роняет разбор', () => {
  for (const input of [null, undefined, 'error', 42, []]) {
    const profile = normalizeCapiProfile(input);
    assert.equal(profile.cmdrName, null);
    assert.equal(isBlankProfile(profile), true);
  }
});

test('строка capi_profiles заполняется реальными значениями', () => {
  const row = capiProfileRow('user-1', normalizeCapiProfile(LIVE_PROFILE), { now: new Date('2026-09-27T10:00:00Z') });

  assert.equal(row.user_id, 'user-1');
  assert.equal(row.cmdr_name, 'Nova');
  assert.equal(row.frontier_id, '1234567');
  assert.equal(row.credits, 2153938);
  assert.equal(row.loan, 500);
  assert.equal(row.combat_rank, 5);
  assert.equal(row.cqc_rank, 1);
  assert.equal(row.mercenary_rank, 4);
  assert.equal(row.exobiologist_rank, 2);
  assert.equal(row.current_system, 'Colonia');
  assert.equal(row.current_station, 'Jaques Station');
  assert.equal(row.current_ship, 'Peaceful Pancake');
  assert.equal(row.last_updated, '2026-09-27T10:00:00.000Z');
  assert.equal(Array.isArray(row.ships), true);
});

test('имя командира не затирается пустым ответом CAPI', () => {
  const blank = normalizeCapiProfile({ commander: {} });
  const row = capiProfileRow('user-1', blank, { cmdrNameFallback: 'Nova' });
  assert.equal(row.cmdr_name, 'Nova');
});

test('pilot_stats получает только то, что реально пришло', () => {
  const row = pilotStatsRow('user-1', normalizeCapiProfile({
    commander: { name: 'Nova', credits: 10, rank: { combat: 3 } },
  }));

  assert.equal(row.credits, 10);
  assert.equal(row.combat_rank, 3);
  assert.equal('trade_rank' in row, false, 'отсутствующий ранг не затирает данные журналов');
  assert.equal('current_system' in row, false);
});
