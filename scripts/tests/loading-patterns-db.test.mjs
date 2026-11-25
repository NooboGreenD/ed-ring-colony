import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('loading migration: idempotent, service-only grants/RLS, constraints and owner deletion',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;`);
  const migration=readFileSync('supabase/migrations/20261128090000_carrier_loading_patterns.sql','utf8');
  await db.exec(migration);await db.exec(migration);
  const owner='11111111-2222-4333-8444-555555555555';await db.exec(`INSERT INTO auth.users VALUES ('${owner}');`);
  for(const role of ['anon','authenticated']){
   const grants=await db.query(`SELECT has_table_privilege('${role}','public.carrier_loading_patterns','SELECT') AS r,has_table_privilege('${role}','public.carrier_loading_patterns','INSERT') AS w`);assert.deepEqual(grants.rows,[{r:false,w:false}]);
   await db.exec(`SET ROLE ${role}`);await assert.rejects(()=>db.query('SELECT * FROM public.carrier_loading_patterns'),/permission denied/);await db.exec('RESET ROLE');
  }
  await db.exec('SET ROLE service_role');
  const result=await db.query(`INSERT INTO carrier_loading_patterns(owner_id,name,visibility,definition,catalogue_version) VALUES ($1,'Test','private','{}',4) RETURNING version`,[owner]);assert.equal(result.rows[0].version,1);
  await assert.rejects(()=>db.query(`INSERT INTO carrier_loading_patterns(owner_id,name,visibility,definition,catalogue_version) VALUES ($1,'Test','friends','{}',4)`,[owner]),/check constraint/);
  await assert.rejects(()=>db.query(`INSERT INTO carrier_loading_patterns(owner_id,name,visibility,definition,catalogue_version) VALUES ($1,'Test','private','[]',4)`,[owner]),/check constraint/);
  await db.exec('RESET ROLE');
  assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='carrier_loading_patterns'`)).rows[0].relrowsecurity,true);
  await db.query('DELETE FROM auth.users WHERE id=$1',[owner]);assert.equal((await db.query('SELECT * FROM carrier_loading_patterns')).rows.length,0);
 }finally{await db.close();}
});
