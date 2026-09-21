import test from 'node:test';
import assert from 'node:assert/strict';
import { compute, syncProgress } from '../lib/progress-sync.mjs';

function database({ hubs = [], route = [], upsertError = null, updateError = null } = {}) {
  const writes = [];
  return { writes, from(table) {
    const result = Promise.resolve({ data: table === 'hubs' ? hubs : route, error: null });
    result.order = () => result;
    return {
      select: () => result,
      upsert: async row => { writes.push({ table, row }); return { error: upsertError }; },
      update: row => ({ eq: async (_, id) => { writes.push({ table, row, id }); return { error: updateError }; } }),
    };
  } };
}

test('progress preserves remaining/required distinction and unknown totals', () => {
  assert.equal(compute({ commodities: { steel: 10 } }).progress, null);
  assert.equal(compute({ sumTotal: 100, sumNeed: 25 }).progress, 75);
  assert.equal(compute({ complete: true }).progress, 100);
});

test('same system updates both hub and route records with one upstream lookup', async () => {
  const db = database({ hubs: [{ id: 1, system_name: 'Sol' }], route: [{ id: 2, system_name: 'sol' }] });
  let calls = 0;
  const result = await syncProgress({ supabase: db, fetchSystemImpl: async system_name => {
    calls++; return { system_name, progress: 0, data: {}, updated_at: '2026-09-20' };
  } });
  assert.deepEqual(result, { ok: true, updated: 1, failed: 0, total: 1 });
  assert.equal(calls, 1);
  assert.equal(db.writes.filter(write => write.row.status === 'planned').length, 2);
});

test('upstream failures do not overwrite existing progress with null', async () => {
  const db = database({ hubs: [{ id: 1, system_name: 'Sol' }, { id: 2, system_name: 'Colonia' }] });
  const result = await syncProgress({ supabase: db, fetchSystemImpl: async system_name => {
    if (system_name === 'Sol') throw new Error('Raven HTTP 503');
    return { system_name, progress: 100, data: {} };
  } });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(result.updated, 1);
  assert.equal(db.writes.some(write => write.row.system_name === 'Sol'), false);
});

test('database write failures are visible to the scheduler', async () => {
  for (const errors of [{ upsertError: { message: 'db unavailable' } }, { updateError: { message: 'db unavailable' } }]) {
    const db = database({ hubs: [{ id: 1, system_name: 'Sol' }], ...errors });
    const result = await syncProgress({ supabase: db, fetchSystemImpl: async () => ({ progress: 50 }) });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 1);
  }
});
