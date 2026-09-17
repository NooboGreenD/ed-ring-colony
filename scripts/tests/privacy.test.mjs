import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRIVACY,
  PRIVACY_KEYS,
  maskCapiProfile,
  maskPilotStats,
  privacyForViewer,
  privacyPayload,
  resolvePrivacy,
} from '../../src/lib/privacy.ts';

test('отсутствующие настройки означают «показывать»', () => {
  // Профили, созданные до миграции, не должны внезапно «погаснуть».
  for (const raw of [null, undefined, {}, '', 'не-json', 42, []]) {
    assert.deepEqual(resolvePrivacy(raw), DEFAULT_PRIVACY, String(raw));
  }
  for (const key of PRIVACY_KEYS) assert.equal(DEFAULT_PRIVACY[key], true, key);
});

test('явные выключенные переключатели сохраняются, неизвестные игнорируются', () => {
  const settings = resolvePrivacy({ balance: false, ranks: false, whatever: false, location: 'false' });
  assert.equal(settings.balance, false);
  assert.equal(settings.ranks, false);
  assert.equal(settings.location, false);
  assert.equal(settings.cargo, true);
  assert.equal(settings.deliveries, true);
  assert.equal('whatever' in settings, false);
});

test('строка JSONB разбирается так же, как объект', () => {
  assert.equal(resolvePrivacy('{"balance":false}').balance, false);
});

test('владелец досье видит всё, даже если сам всё скрыл', () => {
  const raw = { balance: false, ranks: false, cargo: false, deliveries: false, location: false };
  const stranger = privacyForViewer(raw, 'user-2', 'user-1');
  assert.equal(stranger.balance, false);
  assert.equal(stranger.location, false);

  const owner = privacyForViewer(raw, 'user-1', 'user-1');
  assert.deepEqual(owner, DEFAULT_PRIVACY);

  // Анонимный посетитель — точно не владелец.
  assert.equal(privacyForViewer(raw, null, 'user-1').cargo, false);
});

test('скрытые числа не уходят в браузер вовсе', () => {
  const stats = {
    credits: 1_500_000,
    arx: 400,
    mercenary_coins: 12,
    bio_value_cr: 900,
    combat_rank: 5,
    trade_rank: 4,
    explore_rank: 8,
    empire_rank: 2,
    federation_rank: 3,
    mercenary_rank: 4,
    exobiologist_rank: 6,
    current_ship: 'Python MK II',
    current_system: 'Delta Velorum',
    current_station: 'Ditceford Hub',
    first_mapped_count: 1200,
  };
  const masked = maskPilotStats(stats, {
    balance: false,
    ranks: false,
    location: false,
    cargo: true,
    deliveries: true,
  });

  for (const field of ['credits', 'arx', 'mercenary_coins', 'bio_value_cr']) {
    assert.equal(masked[field], null, field);
  }
  for (const field of ['combat_rank', 'trade_rank', 'explore_rank', 'empire_rank', 'federation_rank', 'mercenary_rank', 'exobiologist_rank']) {
    assert.equal(masked[field], null, field);
  }
  for (const field of ['current_ship', 'current_system', 'current_station']) {
    assert.equal(masked[field], null, field);
  }
  // Не связанное с приватностью поле остаётся: исследования публичны.
  assert.equal(masked.first_mapped_count, 1200);
  // Исходный объект не мутируется.
  assert.equal(stats.credits, 1_500_000);
});

test('маска CAPI-профиля повторяет те же правила', () => {
  const profile = {
    cmdr_name: 'Test',
    credits: 9000,
    combat_rank: 3,
    current_ship: 'Cobra Mk III',
    current_system: 'Sol',
    current_station: 'Daedalus',
  };
  const masked = maskCapiProfile(profile, {
    balance: false,
    ranks: false,
    location: false,
    cargo: true,
    deliveries: true,
  });
  assert.equal(masked.credits, null);
  assert.equal(masked.combat_rank, null);
  assert.equal(masked.current_ship, null);
  assert.equal(masked.cmdr_name, 'Test');
  assert.equal(maskCapiProfile(null, DEFAULT_PRIVACY), null);
});

test('payload для записи содержит только известные ключи', () => {
  assert.deepEqual(privacyPayload({ balance: false, nope: true }), { balance: false });
  assert.deepEqual(privacyPayload({}), {});
});
