import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColonisationEvents } from '../../src/lib/journalParser.ts';

const journal = [
  { timestamp: '2026-10-22T18:34:00Z', event: 'Location', StarSystem: 'Pleiades Sector IR-W d1-55' },
  {
    timestamp: '2026-10-22T18:35:00Z',
    event: 'CommunityGoal',
    CurrentGoals: [{
      CGID: 428,
      Title: 'Operation Andronicus',
      SystemName: 'Pleiades Sector IR-W d1-55',
      MarketName: 'The Oracle',
      Expiry: '2026-10-29T16:00:00Z',
      IsComplete: false,
      CurrentTotal: 2838230000,
      PlayerContribution: 123456,
      NumContributors: 408,
      TierReached: 'Tier 4',
      PlayerPercentileBand: 75,
      PlayerInTopRank: false,
    }],
  },
].map((event) => JSON.stringify(event)).join('\n');

test('parses private CMDR Community Goal reports from journal events', () => {
  const result = parseColonisationEvents(journal);
  assert.equal(result.communityGoalReports.length, 1);
  assert.deepEqual(result.communityGoalReports[0], {
    game_cg_id: 428,
    title: 'Operation Andronicus',
    system_name: 'Pleiades Sector IR-W d1-55',
    station_name: 'The Oracle',
    expiry_date: '2026-10-29T16:00:00Z',
    player_contribution: 123456,
    current_total: 2838230000,
    tier_reached: 4,
    tier_max: null,
    contributors_num: 408,
    percentile_band: 75,
    is_top_rank: false,
    is_complete: false,
    observed_at: '2026-10-22T18:35:00Z',
  });
});
