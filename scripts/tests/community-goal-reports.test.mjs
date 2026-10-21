import test from 'node:test';
import assert from 'node:assert/strict';

import { communityGoalIdentityKey, normalizeCommunityGoal } from '../../src/lib/inara/community-goals.mjs';
import { persistCommunityGoalReports } from '../../src/lib/communityGoalReports.ts';

const official = {
  communitygoalName: 'Operation Andronicus',
  starsystemName: 'Pleiades Sector IR-W d1-55',
  stationName: 'The Oracle',
  goalExpiry: '2026-10-29T16:00:00Z',
};

test('Inara and commander journal identities match despite case, spacing, and timestamp formatting', () => {
  const inara = normalizeCommunityGoal(official);
  const journalKey = communityGoalIdentityKey({
    title: ' operation  andronicus ',
    systemName: 'PLEIADES SECTOR IR-W D1-55',
    stationName: 'the oracle',
    expiryDate: '2026-10-29T19:00:00+03:00',
  });
  assert.equal(journalKey, inara.identity_key);
});

test('persisting reports binds identity to the authenticated account and never trusts a supplied user id', async () => {
  let rpcName;
  let payload;
  const svc = {
    async rpc(name, args) {
      rpcName = name;
      payload = args.p_rows;
      return { data: 1, error: null };
    },
  };
  const stored = await persistCommunityGoalReports(svc, 'authenticated-user-id', [{
    game_cg_id: 428,
    title: official.communitygoalName,
    system_name: official.starsystemName,
    station_name: official.stationName,
    expiry_date: official.goalExpiry,
    user_id: 'attacker-selected-user-id',
    player_contribution: 1234,
    current_total: 5000,
    tier_reached: 2,
    observed_at: '2026-10-22T18:34:00Z',
  }, {
    game_cg_id: 428,
    title: official.communitygoalName,
    system_name: official.starsystemName,
    station_name: official.stationName,
    expiry_date: official.goalExpiry,
    player_contribution: 2345,
    current_total: 6000,
    tier_reached: 3,
    observed_at: '2026-10-22T18:35:00Z',
  }], 'helper');

  assert.equal(rpcName, 'upsert_community_goal_commander_reports');
  assert.equal(stored, 1);
  assert.equal(payload[0].user_id, 'authenticated-user-id');
  assert.equal(payload[0].source, 'helper');
  assert.equal(payload[0].goal_key, normalizeCommunityGoal(official).identity_key);
  assert.equal(payload.length, 1, 'one game CG ID must appear only once per RPC batch');
  assert.equal(payload[0].player_contribution, 2345);
});

test('empty or malformed reports do not call the database', async () => {
  const svc = { rpc() { throw new Error('unexpected RPC'); } };
  assert.equal(await persistCommunityGoalReports(svc, 'user', [], 'helper'), 0);
  assert.equal(await persistCommunityGoalReports(svc, 'user', [{ game_cg_id: 'bad' }], 'helper'), 0);
});
