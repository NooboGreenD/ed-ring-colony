import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const USER = '00000000-0000-4000-8000-000000000001';
const readMigration = name => readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');
before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${USER}'::uuid $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${USER}');
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit int,allowed_mime_types text[]);
    CREATE TABLE storage.objects(bucket_id text,name text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON storage.objects TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;`);
  await db.exec(readMigration('20261120010000_user_ship_photos.sql'));
  await db.exec(readMigration('20261123110000_ship_photo_server_writes.sql'));
  await db.exec(readMigration('20261123110000_ship_photo_server_writes.sql'));
});
after(async () => db.close());
const insert = (ship, primary = false, url = 'https://example.test/a.png') => db.query(
  'INSERT INTO user_ship_photos(user_id,ship_id,image_url,is_primary) VALUES($1,$2,$3,$4) RETURNING *', [USER,ship,url,primary]);

test('browser roles cannot bypass API perk/quota checks with direct metadata writes', async () => {
  for (const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(() => insert('sidewinder'), /permission denied/);
      await assert.rejects(() => db.query('UPDATE user_ship_photos SET is_primary=true'), /permission denied/);
      await assert.rejects(() => db.query('DELETE FROM user_ship_photos'), /permission denied/);
      await db.query('SELECT * FROM user_ship_photos');
      await assert.rejects(() => db.query("INSERT INTO storage.objects VALUES('ship-images','official.png')"), /row-level security/);
    } finally { await db.exec('RESET ROLE'); }
  }
});

test('server insert caps each ship at five, primary change is atomic, quota error leaves previous primary', async () => {
  await db.exec('SET ROLE service_role');
  try {
    const first = (await insert('sidewinder',true)).rows[0];
    const second = (await insert('sidewinder',true)).rows[0];
    assert.equal((await db.query('SELECT is_primary FROM user_ship_photos WHERE id=$1',[first.id])).rows[0].is_primary,false);
    for (let i=0;i<3;i++) await insert('sidewinder');
    await assert.rejects(() => insert('sidewinder',true), /quota exceeded/);
    assert.deepEqual((await db.query("SELECT id FROM user_ship_photos WHERE ship_id='sidewinder' AND is_primary")).rows,[{ id: second.id }]);
    await insert('cobra_mk_iii',true); // quota is per ship
    await db.query('DELETE FROM user_ship_photos WHERE id=$1',[first.id]);
    await insert('sidewinder'); // deletion frees a slot
  } finally { await db.exec('RESET ROLE'); }
});

test('insert failure rolls back demotion of the existing primary', async () => {
  const before = (await db.query("SELECT id,is_primary FROM user_ship_photos WHERE ship_id='cobra_mk_iii' ORDER BY id")).rows;
  await assert.rejects(() => insert('cobra_mk_iii',true,null), /not-null/);
  assert.deepEqual((await db.query("SELECT id,is_primary FROM user_ship_photos WHERE ship_id='cobra_mk_iii' ORDER BY id")).rows,before);
});
