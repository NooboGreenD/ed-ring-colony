/**
 * Создание проекта Raven Colonial с сайта (Архитектор):
 * хранилище RCC-ключа (шифрование) и черновик `PUT /api/project`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptRavenKey, encryptRavenKey, maskRavenKey } from '../../src/lib/raven/keyVault.ts';
import { buildRavenProjectDraft } from '../../src/lib/architect/ravenCreate.ts';
import { createPlan, addSite, linkSiteToRaven } from '../../src/lib/architect/planner.ts';

const SECRET = 'test-secret-value-for-unit-tests';

test('ключ RCC шифруется и расшифровывается только с тем же секретом', () => {
  const cipher = encryptRavenKey('abcdef123456-key', SECRET);
  assert.ok(!cipher.includes('abcdef123456'), 'в шифротексте нет открытого ключа');
  assert.equal(decryptRavenKey(cipher, SECRET), 'abcdef123456-key');
  assert.equal(decryptRavenKey(cipher, 'другой-секрет'), null, 'чужой секрет не читает ключ');
  assert.equal(decryptRavenKey('мусор', SECRET), null);
});

test('без секрета ключ не сохраняется', () => {
  assert.throws(() => encryptRavenKey('abc', ''), /RAVEN_KEY_SECRET/);
});

test('в интерфейс уходит только маска ключа', () => {
  assert.equal(maskRavenKey('abcd1234efgh5678'), 'abcd…5678');
  assert.equal(maskRavenKey('short'), '••••');
});

function planWithSite(installationId = 'vulcan', bodyName = 'Architest 2') {
  const plan = addSite(createPlan('Architest', 'CMDR Tester'), bodyName, installationId, { note: 'первая' });
  return { plan, site: plan.sites[0] };
}

const BODY = { name: 'Architest 2', bodyId: 5 };

test('черновик содержит обязательные поля Raven и тип из каталога', () => {
  const { site } = planWithSite('vulcan');
  const result = buildRavenProjectDraft({
    site, body: BODY, systemName: 'Architest', systemAddress: 123, marketId: 3702, buildName: 'Аванпост',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, {
    marketId: 3702,
    systemAddress: 123,
    buildName: 'Аванпост',
    systemName: 'Architest',
    buildType: 'vulcan',
    bodyName: 'Architest 2',
    bodyNum: 5,
    notes: 'первая',
  });
});

test('без MarketID или адреса системы проект не уходит в Raven', () => {
  const { site } = planWithSite();
  const noMarket = buildRavenProjectDraft({ site, body: BODY, systemName: 'A', systemAddress: 1, marketId: 0, buildName: 'x' });
  assert.equal(noMarket.ok, false);
  assert.match(noMarket.error, /MarketID/);
  const noAddress = buildRavenProjectDraft({ site, body: BODY, systemName: 'A', systemAddress: 0, marketId: 2, buildName: 'x' });
  assert.equal(noAddress.ok, false);
  assert.match(noAddress.error, /SystemAddress/);
});

test('постройка, уже связанная с Raven, создаётся повторно только после явного решения: здесь — отказ', () => {
  const { plan, site } = planWithSite();
  const linked = linkSiteToRaven(plan, site.id, 'b-100').sites[0];
  const result = buildRavenProjectDraft({ site: linked, body: BODY, systemName: 'A', systemAddress: 1, marketId: 2, buildName: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /уже связана/);
});

test('неизвестный тип постройки не отправляется', () => {
  const site = { id: 's9', bodyName: 'A 1', installationId: 'not_a_building', status: 'plan' };
  const result = buildRavenProjectDraft({ site, body: null, systemName: 'A', systemAddress: 1, marketId: 2, buildName: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Неизвестная постройка/);
});

test('тело без BodyID не даёт bodyNum, но имя тела передаётся', () => {
  const { site } = planWithSite('vulcan', 'Architest 4');
  const result = buildRavenProjectDraft({
    site, body: { name: 'Architest 4', bodyId: null }, systemName: 'Architest', systemAddress: 1, marketId: 2, buildName: 'x',
  });
  assert.equal(result.ok, true);
  assert.equal('bodyNum' in result.draft, false);
  assert.equal(result.draft.bodyName, 'Architest 4');
});
