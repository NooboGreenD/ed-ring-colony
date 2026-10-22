import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCommunityGoal, isCommunityGoalModerationStatus } from '../../src/lib/communityGoalAdmin.ts';

test('moderator overrides affect displayed goal fields but preserve source identity and moderation metadata', () => {
  const source = {
    id: 7,
    cg_id: 123,
    title: 'Inara title',
    system_name: 'Sol',
    identity_key: '["inara identity"]',
    moderation_status: 'hidden',
    manual_overrides: {
      title: 'Corrected title',
      system_name: 'Alpha Centauri',
      moderation_status: 'approved',
      created_by: 'not-an-editable-field',
    },
  };
  const effective = effectiveCommunityGoal(source);
  assert.equal(effective.title, 'Corrected title');
  assert.equal(effective.system_name, 'Alpha Centauri');
  assert.equal(effective.identity_key, source.identity_key);
  assert.equal(effective.moderation_status, 'hidden');
  assert.equal(effective.created_by, undefined);
  assert.equal(source.title, 'Inara title', 'input row is not mutated');
});

test('moderation status validation allows only explicit workflow states', () => {
  assert.equal(isCommunityGoalModerationStatus('approved'), true);
  assert.equal(isCommunityGoalModerationStatus('hidden'), true);
  assert.equal(isCommunityGoalModerationStatus('rejected'), true);
  assert.equal(isCommunityGoalModerationStatus('pending'), false);
  assert.equal(isCommunityGoalModerationStatus({}), false);
});
