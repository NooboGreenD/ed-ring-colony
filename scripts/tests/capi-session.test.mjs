import test from 'node:test';
import assert from 'node:assert/strict';
import { capiSession, CapiSession } from '../../src/lib/capi/session.ts';

/**
 * Заглушка Supabase: запоминает, чем обновляли строку capi_tokens, и умеет
 * отвечать на чтение строки (для сверки при параллельных обновлениях).
 */
function storeStub({ stored = null } = {}) {
  const updates = [];
  const state = { row: stored };
  return {
    updates,
    state,
    from(table) {
      assert.equal(table, 'capi_tokens');
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: state.row, error: null }),
              };
            },
          };
        },
        update(values) {
          updates.push(values);
          state.row = { ...(state.row ?? {}), ...values };
          return { eq: async () => ({}) };
        },
      };
    },
  };
}


function refreshStub(seen = []) {
  return async (token) => {
    seen.push(token);
    return { access_token: 'fresh', refresh_token: 'r2', expires_in: 14400 };
  };
}

test('session refreshes proactively when the token is about to expire', async () => {
  const store = storeStub();
  const seen = [];
  const session = await capiSession(store, 'u1', {
    access_token: 'stale',
    refresh_token: 'r1',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }, refreshStub(seen));
  assert.deepEqual(seen, ['r1']);
  assert.equal(session.token, 'fresh');
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0].access_token, 'fresh');
  assert.equal(store.updates[0].refresh_token, 'r2');
});

test('a valid token is used as is', async () => {
  const store = storeStub();
  const session = await capiSession(store, 'u1', {
    access_token: 'good',
    refresh_token: 'r1',
    expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
  }, refreshStub());
  assert.equal(session.token, 'good');
  assert.equal(store.updates.length, 0);
});

test('run() retries the call once after UNAUTHORIZED', async () => {
  const store = storeStub();
  const session = await capiSession(store, 'u1', {
    access_token: 'expired',
    refresh_token: 'r1',
    expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
  }, refreshStub());
  let attempt = 0;
  const result = await session.run(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('UNAUTHORIZED');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempt, 2);
  assert.equal(session.token, 'fresh');
  assert.equal(store.updates.length, 1);
});

test('run() does not swallow other errors', async () => {
  const store = storeStub();
  const session = await capiSession(store, 'u1', {
    access_token: 'good',
    refresh_token: 'r1',
    expires_at: null,
  }, refreshStub());
  await assert.rejects(
    () => session.run(async () => { throw new Error('CAPI /profile: 500'); }),
    /500/,
  );
});

/* ── Гонка за одноразовый refresh-токен ────────────────────────────── */

test('параллельные обновления сериализуются: один запрос к Frontier, второй принимает свежую пару', async () => {
  // refresh-токен Frontier одноразовый: два параллельных обновления по r1
  // без сериализации гарантированно ломают одно из них. Вторая сессия
  // перечитывает строку и видит уже r2 — и НЕ дёргает Frontier повторно.
  const store = storeStub({
    stored: { access_token: 'stale', refresh_token: 'r1', expires_at: new Date(Date.now() + 60_000).toISOString() },
  });
  const seen = [];
  const refresh = refreshStub(seen);

  const first = await capiSession(store, 'u-race', {
    access_token: 'stale', refresh_token: 'r1', expires_at: new Date(Date.now() + 60_000).toISOString(),
  }, refresh);
  const second = await capiSession(store, 'u-race', {
    access_token: 'stale', refresh_token: 'r1', expires_at: new Date(Date.now() + 60_000).toISOString(),
  }, refresh);

  assert.deepEqual(seen, ['r1'], 'второе обновление не должно дёргать Frontier по потраченному токену');
  assert.equal(first.token, 'fresh');
  assert.equal(second.token, 'fresh', 'вторая сессия приняла свежую пару из базы');
  assert.equal(second.tokens.refresh_token, 'r2');
});

test('refresh отказал, а строка изменилась — сессия принимает чужую пару вместо ошибки', async () => {
  // Другой обработчик (другой процесс) успел обновить токен между нашим
  // чтением и запросом: наш refresh падает (токен уже потрачен), но перечитывание
  // видит свежую пару — привязка жива, сессия продолжает с ней работать.
  const store = storeStub({
    stored: { access_token: 'stale', refresh_token: 'r1', expires_at: new Date(Date.now() + 60_000).toISOString() },
  });
  const failingRefresh = async () => {
    // К моменту запроса строка уже другая: чужой процесс обновился первым.
    store.state.row = {
      access_token: 'theirs',
      refresh_token: 'r9',
      expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
    };
    const err = new Error('Frontier token error: 400 invalid_grant');
    err.status = 400;
    throw err;
  };

  const session = await capiSession(store, 'u-adopt', {
    access_token: 'stale', refresh_token: 'r1', expires_at: new Date(Date.now() + 60_000).toISOString(),
  }, failingRefresh);

  assert.equal(session.token, 'theirs', 'сессия приняла свежую пару другого обработчика');
  assert.equal(session.tokens.refresh_token, 'r9');
  assert.equal(store.updates.length, 0, 'своя (мёртвая) пара в базу не пишется');
});

test('refresh отказал при неизменной строке — ошибка пробрасывается (нужна повторная авторизация)', async () => {
  const store = storeStub({
    stored: { access_token: 'stale', refresh_token: 'r1', expires_at: new Date(Date.now() + 60_000).toISOString() },
  });
  const deadRefresh = async () => {
    const err = new Error('Frontier token error: 400 invalid_grant');
    err.status = 400;
    throw err;
  };

  const session = new CapiSession(store, 'u-dead', 'stale', 'r1', deadRefresh);
  await assert.rejects(() => session.refresh(), /invalid_grant/);
  assert.equal(session.token, 'stale', 'токен не подменяется при отказе');
});

test('сбой чтения строки не роняет обновление', async () => {
  // Заглушка без select (старый контракт) — обновление идёт по-старому.
  const updates = [];
  const store = {
    from() {
      return {
        update(values) {
          updates.push(values);
          return { eq: async () => ({}) };
        },
      };
    },
  };
  const seen = [];
  const session = new CapiSession(store, 'u-noselect', 'stale', 'r1', refreshStub(seen));
  await session.refresh();
  assert.deepEqual(seen, ['r1']);
  assert.equal(session.token, 'fresh');
  assert.equal(updates.length, 1);
});
