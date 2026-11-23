import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createSquadronJournalFixture } from './helpers/squadron-journal-fixture.mjs';

const { db, PILOT, OTHER, createSquadron, apply, membersOf } = await createSquadronJournalFixture([
  '20261118010000_squadron_transfer_fix.sql',
  '20261123100000_squadron_transfer_atomic.sql',
  '20261123100000_squadron_transfer_atomic.sql', // retry is safe
]);
after(async () => db.close());

test('full destination keeps the previous membership and rank; a free destination transfers in one call', async () => {
  const old = await createSquadron('OLD TEST WING');
  assert.equal((await apply(PILOT, { name: 'OLD TEST WING', at: '2026-11-20T00:00:00Z' })).joined, true);
  const before = (await membersOf(old))[0];
  const full = await createSquadron('FULL TEST WING', { memberLimit: 1 });
  await db.query('INSERT INTO squadron_members(squadron_id,user_id) VALUES($1,$2)', [full,OTHER]);
  const refused = await apply(PILOT, { name: 'FULL TEST WING', at: '2026-11-21T00:00:00Z' });
  assert.equal(refused.reason,'full');
  assert.equal(refused.joined,false);
  assert.equal((await membersOf(old))[0].rank_id,before.rank_id);
  assert.equal((await membersOf(full)).length,1);

  const next = await createSquadron('NEXT TEST WING');
  const moved = await apply(PILOT, { name: 'NEXT TEST WING', at: '2026-11-22T00:00:00Z' });
  assert.equal(moved.reason,'transferred');
  assert.equal(moved.joined,true);
  assert.equal((await membersOf(old)).length,0);
  assert.equal((await membersOf(next)).length,1);
  assert.equal((await membersOf(next))[0].can_manage_members,false);

  const repeat = await apply(PILOT, { name: 'NEXT TEST WING', at: '2026-11-22T00:00:00Z' });
  assert.equal(repeat.member,true);
  assert.equal((await membersOf(next)).length,1);
  assert.equal((await apply(PILOT, { name: 'OLD TEST WING', at: '2026-11-20T01:00:00Z' })).skipped,'stale');
  assert.equal((await membersOf(next)).length,1);
});

test('failed insert rolls back old membership deletion and profile update', async () => {
  const before = (await db.query('SELECT * FROM squadron_members WHERE user_id=$1',[PILOT])).rows;
  const profile = (await db.query('SELECT * FROM profiles WHERE id=$1',[PILOT])).rows;
  const broken = await createSquadron('BROKEN TEST WING');
  await db.exec(`CREATE FUNCTION fail_test_join() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.squadron_id = ${broken} THEN RAISE EXCEPTION 'synthetic insert failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_test_join BEFORE INSERT ON squadron_members FOR EACH ROW EXECUTE FUNCTION fail_test_join();`);
  try {
    await assert.rejects(() => apply(PILOT, { name: 'BROKEN TEST WING', at: '2026-11-23T00:00:00Z' }), /synthetic insert failure/);
    assert.deepEqual((await db.query('SELECT * FROM squadron_members WHERE user_id=$1',[PILOT])).rows,before);
    assert.deepEqual((await db.query('SELECT * FROM profiles WHERE id=$1',[PILOT])).rows,profile);
  } finally { await db.exec('DROP TRIGGER fail_test_join ON squadron_members; DROP FUNCTION fail_test_join()'); }
});

test('join=false never moves a member and service-only execution is preserved', async () => {
  const before = (await db.query('SELECT * FROM squadron_members WHERE user_id=$1',[PILOT])).rows;
  await apply(PILOT, { name: 'OLD TEST WING', join:false, at:'2026-11-23T01:00:00Z' });
  assert.deepEqual((await db.query('SELECT * FROM squadron_members WHERE user_id=$1',[PILOT])).rows,before);
  for (const role of ['anon','authenticated']) {
    const { rows } = await db.query("SELECT has_function_privilege($1,'public.apply_pilot_squadron(uuid,bigint,text,text,integer,text,timestamptz,text,boolean)','EXECUTE') AS allowed",[role]);
    assert.equal(rows[0].allowed,false);
  }
});
