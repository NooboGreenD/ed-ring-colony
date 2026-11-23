import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { userShipPhotoObjectKey } from '../../src/lib/userShipPhotoStorage.ts';

const dir = mkdtempSync(join(tmpdir(),'edrc-security-routes-'));
const require = createRequire(import.meta.url);
const KEY = '__edrcSecurityRouteTest';
const USER = '00000000-0000-4000-8000-000000000001';
const photoUrl = `https://storage.example.test/storage/v1/object/public/ship-images/user-photos/${USER}/sidewinder/old.png`;
const state = {};
globalThis[KEY] = state;
after(() => { delete globalThis[KEY]; rmSync(dir,{recursive:true,force:true}); });

// Deliberately distinguish user/service clients, otherwise the old broken
// Storage upload path would pass a unit test with an overly permissive mock.
function client(service) {
  if (service) state.serviceCalls++;
  return {
    auth: { getUser: async () => ({ data:{user:state.user}, error:null }) },
    storage: { from: bucket => ({
      upload: async (path,buffer,opts) => {
        assert.equal(service,true); assert.equal(bucket,'ship-images');
        state.uploads.push({path,opts}); return { error:state.uploadError };
      },
      remove: async paths => {
        assert.equal(service,true); assert.equal(bucket,'ship-images');
        state.removals.push(paths); return { error:state.removeError };
      },
    }) },
    from: table => {
      const filters=[]; let op='read',values,head=false;
      const execute = () => {
        state.queries.push({table,op,service});
        let rows=(state.tables[table]||[]).filter(r => filters.every(([k,v])=>r[k]===v));
        if (head) return {count:rows.length,data:null,error:state.countError};
        if (op==='insert') {
          if (state.insertError) return {data:null,error:state.insertError};
          rows=[{id:'inserted',...values}];(state.tables[table]||=[]).push(...rows);
        }
        if (op==='delete') {
          state.tables[table]=(state.tables[table]||[]).filter(r=>!rows.includes(r));
        }
        return {data:rows,error:null};
      };
      const q={
        select: (_columns,opts) => {head=Boolean(opts?.head);return q;},
        eq: (k,v) => {filters.push([k,v]);return q;},
        order: ()=>q, limit:()=>q, lt:()=>q, or:()=>q, in:()=>q,
        insert: v=>{op='insert';values=v;return q;},
        delete: ()=>{op='delete';return q;},
        single: async()=>{const r=execute();return {...r,data:r.data?.[0]||null};},
        maybeSingle: async()=>{const r=execute();return {...r,data:r.data?.[0]||null};},
        then: (ok,bad)=>Promise.resolve().then(execute).then(ok,bad),
      };return q;
    },
  };
}
state.client=client;
const shim = (name,content) => { const path=join(dir,name+'.mjs');writeFileSync(path,content);return path; };
const alias={
  '@':resolve('src'),
  'next/server':shim('next', 'export const NextResponse={json:(body,init)=>Response.json(body,init)};'),
  '@/lib/supabaseServer':shim('supabase',`const s=globalThis.${KEY}; export const createClient=async()=>s.client(false);export const createServiceClient=()=>s.client(true);export const authFromRequest=async()=>({user:s.user,supabase:s.client(false)});`),
  '@/lib/squadronData':shim('membership',`export const getSquadronMembership=async()=>globalThis.${KEY}.membership;`),
  '@/lib/billing/subscriptionBonus':shim('perk',`export const userHasShipPhotoGallery=async()=>globalThis.${KEY}.perk;`),
  '@/lib/billing/auth':shim('errors',`export const errorResponse=(e,status=500)=>Response.json({error:'test error'},{status});`),
  '@/lib/i18n/apiT':shim('translate','export const apiTranslate=async()=>key=>key;'),
  '@/lib/supabaseUrl':shim('url',`export const getPublicStorageUrl=(bucket,path)=>'https://storage.example.test/storage/v1/object/public/'+bucket+'/'+path;`),
};
async function load(entry,name) {
  const outfile=join(dir,name+'.cjs');await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent',alias});return require(outfile);
}
const photos=await load('src/app/api/user/ships/photos/route.ts','photos');
const chat=await load('src/app/api/squadrons/[id]/chat/route.ts','chat');
const voice=await load('src/app/api/squadrons/[id]/voice/route.ts','voice');
const context={params:Promise.resolve({id:'10'})};
const privileges={can_manage_members:false,can_manage_projects:false,can_manage_ranks:false,can_edit_squadron:false};
beforeEach(()=>Object.assign(state,{
  user:{id:USER},perk:true,serviceCalls:0,queries:[],uploads:[],removals:[],
  uploadError:null,removeError:null,countError:null,insertError:null,
  membership:{id:1,rank_id:1,...privileges},
  tables:{user_ship_photos:[{id:'photo-1',user_id:USER,ship_id:'sidewinder',image_url:photoUrl}],
    squadron_members:[{id:1,squadron_id:10,user_id:USER,rank_id:1}],
    squadron_ranks:[{id:1,...privileges}],squadron_voice_rooms:[],squadron_chat_messages:[]},
}));
function upload(ship='sidewinder') {
  const form=new FormData();form.set('ship_id',ship);form.set('file',new File(['test png bytes'],'untrusted.html',{type:'image/png'}));
  return new Request('https://app.test/api/user/ships/photos',{method:'POST',body:form});
}
const deletion=()=>new Request('https://app.test/api/user/ships/photos?photo_id=photo-1',{method:'DELETE'});

test('photo upload is authenticated/perk-gated before privileged storage access',async()=>{
  state.user=null;assert.equal((await photos.POST(upload())).status,401);assert.equal(state.serviceCalls,0);
  state.user={id:USER};state.perk=false;assert.equal((await photos.POST(upload())).status,403);assert.equal(state.serviceCalls,0);
});
test('photo upload uses server Storage with MIME-derived extension and owner-bound key',async()=>{
  const res=await photos.POST(upload());assert.equal(res.status,201);
  assert.match(state.uploads[0].path,new RegExp(`^user-photos/${USER}/sidewinder/[a-f0-9-]+\\.png$`));
  assert.equal(state.tables.user_ship_photos[1].user_id,USER);
  assert.ok(state.queries.filter(q=>q.op==='insert').every(q=>q.service));
});
test('photo upload rejects path segments, fails closed on quota errors and cleans up after concurrent quota rejection',async()=>{
  assert.equal((await photos.POST(upload('../official'))).status,400);assert.equal(state.uploads.length,0);
  state.countError={message:'offline'};assert.equal((await photos.POST(upload())).status,503);assert.equal(state.uploads.length,0);
  state.countError=null;state.insertError={code:'23514'};assert.equal((await photos.POST(upload())).status,400);
  assert.deepEqual(state.removals,[[state.uploads[0].path]]);
});
test('photo delete uses bucket-relative owner key; a Storage failure preserves metadata for retry',async()=>{
  state.removeError={message:'offline'};assert.equal((await photos.DELETE(deletion())).status,502);
  assert.deepEqual(state.removals,[[`user-photos/${USER}/sidewinder/old.png`]]);assert.equal(state.tables.user_ship_photos.length,1);
  state.removeError=null;assert.equal((await photos.DELETE(deletion())).status,200);assert.equal(state.tables.user_ship_photos.length,0);
});
test('photo delete cannot target another user, official object, or forged metadata path',async()=>{
  state.tables.user_ship_photos[0].user_id='other';assert.equal((await photos.DELETE(deletion())).status,404);assert.equal(state.serviceCalls,0);
  state.tables.user_ship_photos[0].user_id=USER;state.tables.user_ship_photos[0].image_url='https://storage.test/storage/v1/object/public/ship-images/official.png';
  assert.equal((await photos.DELETE(deletion())).status,409);assert.equal(state.removals.length,0);
});
test('legacy public/gateway URLs parse; encoded traversal, cross-owner and malformed paths do not',()=>{
  assert.equal(userShipPhotoObjectKey(photoUrl,USER),`user-photos/${USER}/sidewinder/old.png`);
  assert.equal(userShipPhotoObjectKey(photoUrl.replace('/storage/v1','/api/supabase/storage/v1'),USER),`user-photos/${USER}/sidewinder/old.png`);
  for(const url of [photoUrl.replace(USER,'someone-else'),photoUrl.replace('old.png','%2e%2e%2fofficial.png'),photoUrl+'/%',photoUrl.replace('old.png','%2fother.png')]) assert.equal(userShipPhotoObjectKey(url,USER),null);
});
test('officer chat GET/POST share permission checks; general chat and officers continue working',async()=>{
  const get=type=>chat.GET(new Request('https://app.test/chat?type='+type),context);
  const post=type=>chat.POST(new Request('https://app.test/chat',{method:'POST',body:JSON.stringify({content:'test',chat_type:type})}),context);
  assert.equal((await get('officer')).status,403);assert.equal((await post('officer')).status,403);
  assert.equal((await get('general')).status,200);assert.equal((await get('unknown')).status,400);
  state.membership.can_manage_members=true;assert.equal((await get('officer')).status,200);assert.equal((await post('officer')).status,200);
  state.membership=null;assert.equal((await get('general')).status,403);
});
test('voice GET cannot use service read model for a foreign or officer-only room',async()=>{
  state.tables.squadron_voice_rooms=[{id:20,squadron_id:20,is_officer_only:false}];
  assert.equal((await voice.GET(new Request('https://app.test/voice?roomId=20'),context)).status,404);assert.equal(state.serviceCalls,0);
  state.tables.squadron_voice_rooms=[{id:20,squadron_id:10,is_officer_only:true}];
  assert.equal((await voice.GET(new Request('https://app.test/voice?roomId=20'),context)).status,403);assert.equal(state.serviceCalls,0);
  state.tables.squadron_voice_rooms[0].is_officer_only=false;
  assert.equal((await voice.GET(new Request('https://app.test/voice?roomId=20'),context)).status,200);assert.equal(state.serviceCalls,1);
});
