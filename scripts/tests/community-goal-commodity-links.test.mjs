import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCommunityGoalObjective } from '../../src/lib/communityGoalCommodityLinks.ts';
import { atlasSystemHref } from '../../src/lib/systemIdentity.ts';

test('splits exact in-game commodity names out of a CG objective for Atlas links', () => {
  const parts = splitCommunityGoalObjective(
    'Deliver 10 units of Bromellite, 5 units of Power Generators and Tritium.',
  );

  assert.deepEqual(parts.filter((part) => part.commodity).map((part) => part.commodity), [
    'Bromellite',
    'Power Generators',
    'Tritium',
  ]);
  assert.equal(parts.map((part) => part.text).join(''),
    'Deliver 10 units of Bromellite, 5 units of Power Generators and Tritium.');
});

test('matches longer goods and word boundaries, without linking partial words', () => {
  const objective = 'Supply Power Transfer Bus, H.E. Suits and Goldfish.';
  const parts = splitCommunityGoalObjective(objective);

  assert.deepEqual(parts.filter((part) => part.commodity).map((part) => part.commodity), [
    'Power Transfer Bus',
    'H.E. Suits',
  ]);
  assert.equal(parts.map((part) => part.text).join(''), objective);
});

test('Atlas market link carries both the CG system and selected commodity', () => {
  assert.equal(
    atlasSystemHref('Pleiades Sector IR-W d1-55', { tab: 'market', commodity: 'Power Generators' }),
    '/atlas?tab=market&system=Pleiades+Sector+IR-W+d1-55&commodity=Power+Generators',
  );
});
