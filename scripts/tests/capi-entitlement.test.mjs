import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCapiEntitlement, isNoEntitlementResponse } from '../../src/lib/capi/entitlement.ts';
import { normalizePlatform, platformSelection } from '../../src/lib/capi/platform.ts';
import { fetchFrontierIdentity, parseFrontierIdentity } from '../../src/lib/capi/oauth.ts';
import { CapiClient, needsCapiRelink } from '../../src/lib/capi/client.ts';

const PURCHASE = 'Please Visit the store to purchase Elite: Dangerous.';

for (const actual of ['epic', 'steam', 'frontier']) {
  test(`подтверждённый ${actual} + отказ CAPI в правах не требует нового OAuth`, () => {
    const advice = assessCapiEntitlement(actual, actual);
    assert.equal(advice.reason, 'entitlement_unavailable');
    assert.equal(advice.needsReauth, false);
    assert.match(advice.hint, /Авторизация сохранена/);
    assert.doesNotMatch(advice.hint, /войдите кнопкой|выйдите из|переподключ/i);
  });
}

test('переподключение только при подтверждённом несовпадении, не по выбору audience', () => {
  const mismatch = assessCapiEntitlement('EGS', 'frontier');
  assert.equal(mismatch.needsReauth, true);
  assert.equal(mismatch.reason, 'platform_not_entitled');
  assert.match(mismatch.hint, /auth\.frontierstore\.net/);
  for (const actual of [null, '', 'unknown']) {
    const unknown = assessCapiEntitlement('epic', actual);
    assert.equal(unknown.needsReauth, false);
    assert.equal(unknown.platform, null);
    assert.match(unknown.hint, /не доказательство/);
  }
  for (const actual of ['frontier', 'steam', 'epic']) {
    assert.equal(assessCapiEntitlement('frontier,steam,epic', actual).needsReauth, false);
  }
});

test('авто не превращается в первый элемент frontier после колбэка', () => {
  assert.equal(platformSelection('frontier,steam,epic'), 'auto');
  assert.equal(platformSelection('epic'), 'epic');
  assert.equal(platformSelection('EGS'), 'epic');
  assert.equal(platformSelection(null), 'auto');
  assert.equal(normalizePlatform('something'), null);
});

test('различаем сообщение о покупке и любой другой HTTP 400', () => {
  for (const body of [PURCHASE, JSON.stringify({ message: PURCHASE }), '{"error":"no_entitlement"}']) {
    assert.equal(isNoEntitlementResponse(body), true, body);
  }
  for (const body of ['', 'Bad Request', 'unknown query', 'Failed to purchase commodity', '<h1>400 Bad Request</h1>']) {
    assert.equal(isNoEntitlementResponse(body), false, body);
  }
});

test('CAPI сохраняет реальный ответ и хост, а не обвиняет платформу по коду 400', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('Bad Request: token private-access, wrong query', { status: 400 });
  try {
    await assert.rejects(() => new CapiClient('private-access').getProfile(), (err) => {
      assert.equal(err.kind, 'server');
      assert.equal(err.status, 400);
      assert.equal(needsCapiRelink(err), false);
      assert.equal(err.host, 'https://companion.orerve.net');
      assert.match(err.detail, /wrong query/);
      assert.doesNotMatch(err.detail, /private-access/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('разбор /me и /decode принимает usr и алиасы, но не выдумывает платформу', () => {
  assert.deepEqual(parseFrontierIdentity({ usr: { customer_id: 777, platform: 'EGS' } }), {
    frontierId: '777', email: null, platform: 'epic',
  });
  assert.equal(parseFrontierIdentity({ customer_id: 777 }).platform, null);
  for (const body of [null, {}, [], 'text', { usr: null }, { platform: 'unknown' }, { platform: ['epic'] }, { platform: { toString: 1 } }]) {
    assert.equal(parseFrontierIdentity(body), null);
  }
});

test('если /me неполон, платформа подтверждается через GET /decode с Bearer', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = String(url).endsWith('/me')
      ? { customer_id: 777 }
      : { usr: { customer_id: 777, platform: 'epic' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const identity = await fetchFrontierIdentity('private-access');
    assert.equal(identity.platform, 'epic');
    assert.equal(identity.frontierId, '777');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.method || 'GET', 'GET');
    assert.equal(calls[1].init.body, undefined);
    assert.equal(calls[1].init.headers.Authorization, 'Bearer private-access');
  } finally {
    globalThis.fetch = original;
  }
});

test('полный /me не вызывает лишний /decode; данные разных владельцев не смешиваются', async () => {
  const original = globalThis.fetch;
  let complete = true;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(String(url).endsWith('/me')
      ? { customer_id: 777, ...(complete ? { platform: 'epic' } : {}) }
      : { usr: { customer_id: 888, platform: 'steam' } }), { status: 200 });
  };
  try {
    assert.equal((await fetchFrontierIdentity('a')).platform, 'epic');
    assert.equal(calls.length, 1);
    complete = false;
    const identity = await fetchFrontierIdentity('a');
    assert.equal(identity.platform, null);
    assert.equal(identity.frontierId, '777');
  } finally {
    globalThis.fetch = original;
  }
});
