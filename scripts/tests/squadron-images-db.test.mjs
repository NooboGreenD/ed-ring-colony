import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(new URL('../../supabase/migrations/20261024120000_profile_squadron_images.sql', import.meta.url), 'utf8');
const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE squadrons (id bigint PRIMARY KEY);
  INSERT INTO squadrons VALUES (42);
  CREATE TABLE profile_avatars (user_id text PRIMARY KEY, bytes bytea, byte_size integer);
`);
// Fresh installation without Storage must work as well.
await db.exec(sql);
await db.exec(`CREATE SCHEMA storage; CREATE TABLE storage.buckets
  (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  INSERT INTO storage.buckets VALUES ('avatars','avatars',false,1048576,NULL);`);
await db.exec(sql);
test.after(() => db.close());

test('migration is repeatable, raises old bucket limit and creates squadron bucket', async () => {
  await db.exec(sql);
  const { rows } = await db.query('SELECT id, public, file_size_limit FROM storage.buckets ORDER BY id');
  assert.deepEqual(rows.map(r => [r.id, r.public, Number(r.file_size_limit)]), [['avatars', true, 5242880], ['squadron-media', true, 6291456]]);
});

test('avatar DB fallback accepts exactly 5 MiB and rejects larger or inconsistent sizes', async () => {
  await db.exec(`INSERT INTO profile_avatars VALUES ('a', decode(repeat('00',5242880),'hex'),5242880)`);
  await assert.rejects(db.exec(`INSERT INTO profile_avatars VALUES ('b', decode(repeat('00',5242881),'hex'),5242881)`), /profile_avatars_size_limit/);
  await assert.rejects(db.exec(`INSERT INTO profile_avatars VALUES ('c', decode('00','hex'),2)`), /profile_avatars_size_limit/);
});

test('squadron rows have size and MIME constraints, are service-only, and cascade on deletion', async () => {
  const insert = `INSERT INTO squadron_images(squadron_id,kind,mime,bytes,byte_size,checksum)
    VALUES (42,'logo','image/png',decode('00','hex'),1,repeat('a',64))`;
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(db.query('SELECT * FROM squadron_images'), /permission denied/);
      await assert.rejects(db.exec(insert), /permission denied/);
    } finally { await db.exec('RESET ROLE'); }
  }
  await db.exec('SET ROLE service_role');
  try {
    await db.exec(insert);
    assert.equal((await db.query('SELECT * FROM squadron_images')).rows.length, 1);
    await assert.rejects(db.exec(`UPDATE squadron_images SET byte_size=2`), /check constraint/);
    await assert.rejects(db.exec(`UPDATE squadron_images SET mime='image/svg+xml'`), /check constraint/);
    await assert.rejects(db.exec(`UPDATE squadron_images SET bytes=decode(repeat('00',2097153),'hex'), byte_size=2097153`), /check constraint/);
    await db.exec(`INSERT INTO squadron_images(squadron_id,kind,mime,bytes,byte_size,checksum)
      VALUES (42,'banner','image/png',decode(repeat('00',6291456),'hex'),6291456,repeat('b',64))`);
  } finally { await db.exec('RESET ROLE'); }
  await db.exec('DELETE FROM squadrons WHERE id=42');
  assert.equal((await db.query('SELECT * FROM squadron_images')).rows.length, 0);
});
