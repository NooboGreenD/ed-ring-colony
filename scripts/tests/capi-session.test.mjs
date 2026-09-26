import test from 'node:test';
import assert from 'node:assert/strict';
import { capiSession } from '../../src/lib/capi/session.ts';

/** Заглушка Supabase: запоминает, чем обновляли строку capi_tokens. */
function storeStub() {
  const updates = [];
  return {
    updates,
    from(table) {
      assert.equal(table, 'capi_tokens');
      return {
        update(values) {
          updates.push(values);
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
