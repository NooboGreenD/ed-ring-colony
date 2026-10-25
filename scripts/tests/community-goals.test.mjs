import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCommunityGoal, normalizeCommunityGoals } from '../../src/lib/inara/community-goals.mjs';

const inaraGoal = {
  communitygoalName: 'Operation Andronicus',
  starsystemName: 'Pleiades Sector IR-W d1-55',
  stationName: 'The Oracle',
  goalExpiry: '2026-11-09T16:00:00Z',
  tierReached: 4,
  tierMax: 6,
  contributorsNum: 408,
  contributionsTotal: 2838230000,
  isCompleted: false,
  lastUpdate: '2026-11-08T14:10:05Z',
  goalObjectiveText: 'Hand in Pilots Federation Combat Bonds',
  goalRewardText: 'Exclusive decal and credits',
  goalDescriptionText: 'Aegis is organizing a military operation.',
  inaraURL: 'https://inara.cz/elite/communitygoals/',
};

test('normalizes the documented Inara Community Goals response fields', () => {
  const row = normalizeCommunityGoal(inaraGoal);

  assert.equal(row.title, 'Operation Andronicus');
  assert.equal(row.system_name, 'Pleiades Sector IR-W d1-55');
  assert.equal(row.station_name, 'The Oracle');
  assert.equal(row.objective, 'Hand in Pilots Federation Combat Bonds');
  assert.equal(row.description, 'Aegis is organizing a military operation.');
  assert.equal(row.reward, 'Exclusive decal and credits');
  assert.equal(row.tier_current, 4);
  assert.equal(row.tier_max, 6);
  assert.equal(row.contributors, 408);
  assert.equal(row.contributions_total, 2838230000);
  assert.equal(row.is_complete, false);
  assert.equal(row.inara_url, 'https://inara.cz/elite/communitygoals/');
  assert.equal(row.source_updated_at, inaraGoal.lastUpdate);
  assert.deepEqual(row.raw_data, inaraGoal);
  assert.ok(Number.isInteger(row.cg_id) && row.cg_id > 0);
});

test('keeps an objective distinct from an absent description instead of inventing descriptive text', () => {
  const row = normalizeCommunityGoal({
    communitygoalName: 'Supply convoy',
    goalObjectiveText: 'Deliver medical supplies.',
  });
  assert.equal(row.objective, 'Deliver medical supplies.');
  assert.equal(row.description, null);
});

test('uses a stable numeric identity when Inara omits a Community Goal ID', () => {
  const first = normalizeCommunityGoal(inaraGoal);
  const sameGoal = normalizeCommunityGoal({ ...inaraGoal, contributionsTotal: 3000000000 });
  const distinctGoal = normalizeCommunityGoal({ ...inaraGoal, stationName: 'A different station' });

  assert.equal(first.cg_id, sameGoal.cg_id);
  assert.notEqual(first.cg_id, distinctGoal.cg_id);
});

test('supports legacy field aliases, tier strings, and colonisation detection', () => {
  const [row] = normalizeCommunityGoals([{
    cgID: 91,
    cgName: 'Colony Construction Initiative',
    objective: 'Deliver construction materials',
    tierReached: 'Tier 2',
    tierMax: 'Tier 5',
    contributors: 123,
    expiryDate: '2026-10-31T12:00:00Z',
    isCompleted: true,
  }]);

  assert.equal(row.cg_id, 91);
  assert.equal(row.tier_current, 2);
  assert.equal(row.tier_max, 5);
  assert.equal(row.contributors, 123);
  assert.equal(row.is_complete, true);
  assert.equal(row.is_colonisation_related, true);
});

test('drops malformed goals without a title', () => {
  assert.deepEqual(normalizeCommunityGoals([{}, { communitygoalName: '  ' }]), []);
});
