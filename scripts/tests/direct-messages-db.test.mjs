import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('DM attachment migration is repeatable, keeps legacy text rows and blocks broad browser Storage access',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint);
      CREATE TABLE storage.objects(id serial,bucket_id text,name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY old_broad_policy ON storage.objects FOR ALL TO anon,authenticated USING(true) WITH CHECK(true);
      GRANT USAGE ON SCHEMA storage TO anon,authenticated;
      GRANT SELECT ON storage.objects TO anon,authenticated;
      CREATE TABLE public.messages(id serial PRIMARY KEY,content text NOT NULL);
      INSERT INTO messages(content) VALUES('old text');
      INSERT INTO storage.objects(bucket_id,name) VALUES('direct-message-files','secret'),('avatars','public');`);
    const migration=readFileSync(new URL('../../supabase/migrations/20261125090000_direct_message_attachments.sql',import.meta.url),'utf8');
    await db.exec(migration);await db.exec(migration);
    assert.deepEqual((await db.query('SELECT attachments FROM messages')).rows[0].attachments,[]);
    assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='direct-message-files'")).rows[0].public,false);
    for(const role of ['anon','authenticated']){
      await db.exec(`SET ROLE ${role}`);
      assert.deepEqual((await db.query('SELECT name FROM storage.objects')).rows.map(row=>row.name),['public']);
      await db.exec('RESET ROLE');
    }
    await assert.rejects(db.query('INSERT INTO messages(content,attachments) VALUES($1,$2::jsonb)',['',JSON.stringify(Array(6).fill({}))]));
    await assert.rejects(db.query('INSERT INTO messages(content,attachments) VALUES($1,$2::jsonb)',['','{}']));
  }finally{await db.close()}
});
