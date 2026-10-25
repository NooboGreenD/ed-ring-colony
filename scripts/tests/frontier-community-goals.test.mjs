import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchFrontierPublicCommunityGoals,
  FRONTIER_PUBLIC_COMMUNITY_GOALS_URL,
  normalizeFrontierPublicCommunityGoals,
} from '../../src/lib/frontierCommunityGoals.mjs';

const initiative = {
  id: 9124,
  title: 'Operation Andronicus',
  bulletin: 'Aegis is organizing a military operation.',
  objective: 'Hand in Pilots Federation Combat Bonds.',
  qty: '2,838,230,000',
  target_qty: '3,500,000,000',
  expiry: '2026-11-09 16:00:00',
  starsystem_name: 'Pleiades Sector IR-W d1-55',
  market_name: 'The Oracle',
};

test('normalizes Frontier public initiative text and shared progress without commander-specific fields', () => {
  const [goal] = normalizeFrontierPublicCommunityGoals({ activeInitiatives: [initiative] }, '2026-11-08T14:10:05.000Z');

  assert.equal(goal.title, 'Operation Andronicus');
  assert.equal(goal.description, 'Aegis is organizing a military operation.');
  assert.equal(goal.objective, 'Hand in Pilots Federation Combat Bonds.');
  assert.equal(goal.contributions_total, 2_838_230_000);
  assert.equal(goal.contributions_target, 3_500_000_000);
  assert.equal(goal.expiry_date, '2026-11-09T16:00:00.000Z');
  assert.equal(goal.system_name, 'Pleiades Sector IR-W d1-55');
  assert.equal(goal.station_name, 'The Oracle');
  assert.equal(goal.game_cg_id, 9124);
  assert.equal(goal.source_updated_at, '2026-11-08T14:10:05.000Z');
  assert.equal('player_contribution' in goal, false);
  assert.equal('commander_reports' in goal, false);
});

test('rejects malformed records and quantities instead of inventing values', () => {
  const rows = normalizeFrontierPublicCommunityGoals({ activeInitiatives: [
    initiative,
    { ...initiative, title: 'Malformed quantities', qty: 'unknown', target_qty: -1 },
    null,
  ] }, '2026-11-08T14:10:05.000Z');

  assert.equal(rows.length, 2);
  assert.equal(rows[1].title, 'Malformed quantities');
  assert.equal(rows[1].contributions_total, null);
  assert.equal(rows[1].contributions_target, null);
});

test('fetches the unauthenticated Frontier website endpoint and validates its response shape', async () => {
  let requestUrl;
  let requestOptions;
  const payload = { activeInitiatives: [initiative] };
  const result = await fetchFrontierPublicCommunityGoals(async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  assert.equal(requestUrl, FRONTIER_PUBLIC_COMMUNITY_GOALS_URL);
  assert.equal(requestOptions.method, 'GET');
  assert.equal(requestOptions.headers.Accept, 'application/json');
  assert.equal('Authorization' in requestOptions.headers, false);
  assert.equal(result.activeInitiatives.length, 1);
  await assert.rejects(() => fetchFrontierPublicCommunityGoals(async () =>
    new Response(JSON.stringify({ initiatives: [] }), { status: 200 })), /no activeInitiatives list/);
  await assert.rejects(() => fetchFrontierPublicCommunityGoals(async () =>
    new Response('unavailable', { status: 503 })), /HTTP 503/);
});
