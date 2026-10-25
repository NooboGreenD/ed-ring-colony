import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init = {}) => new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json' },
  }),
};
export class NextRequest extends Request {}
`;

const SUPABASE_STUB = `
export const state = {
  user: { id: '11111111-1111-4111-8111-111111111111' },
  friends: [],
  profiles: [{ id: '11111111-1111-4111-8111-111111111111' }],
};

class Query {
  constructor(table) {
    this.table = table;
    this.action = 'select';
    this.filters = [];
    this.values = null;
  }
  select() { return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  or() { return this; }
  update(values) { this.action = 'update'; this.values = values; return this; }
  delete() { this.action = 'delete'; return this; }
  matches(row) { return this.filters.every(([column, value]) => row[column] === value); }
  async execute(single = false) {
    const rows = state[this.table] || [];
    const matches = rows.filter((row) => this.matches(row));
    if (this.action === 'update') {
      for (const row of matches) Object.assign(row, this.values);
      return { data: single ? matches[0] || null : matches, error: null };
    }
    if (this.action === 'delete') {
      state[this.table] = rows.filter((row) => !this.matches(row));
      return { data: null, error: null };
    }
    return { data: single ? matches[0] || null : matches, error: null };
  }
  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

export function createServiceClient() {
  return { from: (table) => new Query(table) };
}
export async function authFromRequest() {
  return { user: state.user, supabase: { from: (table) => new Query(table) } };
}
`;

const bundle = await bundleFile({
  entrySource: `
import * as route from '@/app/api/friends/route';
export { route };
export { state } from '@/lib/supabaseServer';
`,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
  },
  platform: 'node',
});
const mod = await import(bundle);
const { route, state } = mod;

const REQUESTER = '11111111-1111-4111-8111-111111111111';
const ADDRESSEE = '22222222-2222-4222-8222-222222222222';

function setPendingFriend(userId = REQUESTER, friendId = ADDRESSEE) {
  state.user = { id: userId };
  state.friends = [{
    id: 71,
    user_id: userId,
    friend_id: friendId,
    status: 'pending',
    created_at: '2026-10-26T10:00:00.000Z',
  }];
}

function request(method, body) {
  return new Request('https://colony.test/api/friends', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('accepting a pending request by row ID works with the deployed legacy column names', async () => {
  setPendingFriend(REQUESTER, ADDRESSEE);
  state.user = { id: ADDRESSEE };
  const response = await route.PATCH(request('PATCH', { id: 71, status: 'accepted' }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.friend.status, 'accepted');
  assert.equal(state.friends[0].status, 'accepted');
});

test('cancelling an outgoing request by row ID works with the deployed legacy column names', async () => {
  setPendingFriend(REQUESTER, ADDRESSEE);
  const response = await route.DELETE(request('DELETE', { id: 71 }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(state.friends.length, 0);
});
