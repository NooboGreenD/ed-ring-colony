import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { INSTALLATIONS } from '../../src/lib/architect/catalogue.ts';
const stubs={
 'next/server':`export const NextResponse={json:(body,options={})=>({body,status:options.status||200,headers:options.headers||{}})};`,
 '@/lib/helperAuth':`export const resolveRequestUser=async()=>globalThis.lpUser?{userId:globalThis.lpUser,via:'api_token'}:null;`,
 '@/lib/supabaseServer':`export const createServiceClient=()=>globalThis.lpDb;`,
 '@/lib/rateLimit':`export const checkRateLimit=()=>globalThis.lpRate!==false;`,
 '@/lib/i18n/apiT':`export const apiTranslate=async()=>key=>key;`,
 '@/lib/fleetCarrierStore':`export const viewerContext=async()=>({squadronIds:[7],officerSquadronIds:[7]});export const buildViews=async(svc,rows)=>{globalThis.lpViewed=rows;return rows.map(row=>({carrierId:String(row.carrier_id),cargo:row.cargo}));};`,
};
const collection=await import(await bundleFile({entry:'src/app/api/architect/loading-patterns/route.ts',stubs}));
const detail=await import(await bundleFile({entry:'src/app/api/architect/loading-patterns/[id]/route.ts',stubs}));
const membersApi=await import(await bundleFile({entry:'src/app/api/architect/loading-patterns/[id]/members/route.ts',stubs}));
const id='11111111-2222-4333-8444-555555555555';
const pattern=()=>({name:'Plan',visibility:'private',buildings:[{installationId:INSTALLATIONS[0].id,count:1,primary:false}],carriers:[{carrierId:'123',name:'Alpha',capacity:25000}]});
function setup(user='owner'){
 globalThis.lpUser=user;globalThis.lpRate=true;globalThis.lpViewed=[];
 const state={error:false,tables:{carrier_loading_patterns:[{id,owner_id:'owner',author_name:'Owner',definition:pattern(),visibility:'private',version:1,updated_at:'2026-11-23T12:00:00Z'}],public_profiles:[{id:'owner',cmdr_name:'Owner'}],fleet_carriers:[]},writes:[],reads:[]};
 globalThis.lpDb={from(table){const filters=[];let action='select',patch=null;
 const q={select(){return this},order(){return this},limit(){return this},eq(k,v){filters.push(r=>r[k]===v);return this},ilike(k,v){const needle=v.replace(/\\([\\%_])/g,'$1').toLowerCase();filters.push(r=>String(r[k]).toLowerCase()===needle);return this},in(k,values){filters.push(r=>values.map(String).includes(String(r[k])));return this},
 upsert(value){action='upsert';patch=value;return this},insert(value){action='insert';patch=value;return this},update(value){action='update';patch=value;return this},delete(){action='delete';return this},
 async run(single=false){if(state.error)return{data:null,error:{message:'missing table'}};
 state.reads.push(table);const rows=state.tables[table]??=[];let data=rows.filter(r=>filters.every(f=>f(r)));
 if(action==='upsert'){const old=rows.find(r=>r.pattern_id===patch.pattern_id&&r.user_id===patch.user_id);if(old){Object.assign(old,patch);data=[old];}else{rows.push(patch);data=[patch];}state.writes.push(patch);}
 if(action==='insert'){const row={id,version:1,updated_at:'2026-11-23T12:00:00Z',...patch};rows.push(row);data=[row];state.writes.push(patch);}
 if(action==='update'){for(const row of data)Object.assign(row,patch);state.writes.push(patch);}
 if(action==='delete'){state.tables[table]=rows.filter(r=>!data.includes(r));state.writes.push('delete');}
 return{data:single?(data[0]??null):data,error:null};},single(){return this.run(true)},maybeSingle(){return this.run(true)},then(resolve,reject){return this.run().then(resolve,reject)}};return q;}};
 return state;
}
const req=(method='GET',body,path='')=>new Request('https://example.test/api/architect/loading-patterns'+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const params={params:Promise.resolve({id})};
test('loading API: anonymous sees only public, private list requires authentication, no-store on all responses',async()=>{
 const state=setup(null);let result=await collection.GET(req());assert.equal(result.status,401);
 result=await collection.GET(req('GET',undefined,'?scope=public'));assert.equal(result.body.patterns.length,0);
 state.tables.carrier_loading_patterns[0].visibility='public';state.tables.carrier_loading_patterns[0].definition.visibility='public';
 result=await collection.GET(req('GET',undefined,'?scope=public'));assert.equal(result.body.patterns.length,1);assert.equal(result.body.patterns[0].canEdit,false);assert.equal(result.headers['Cache-Control'],'private, no-store');assert.ok(!JSON.stringify(result.body).includes('owner_id'));
});
test('loading API: private ID invisible to stranger; public progress never discloses other pilot stock',async()=>{
 const state=setup('stranger');assert.equal((await detail.GET(req(),params)).status,404);
 const row=state.tables.carrier_loading_patterns[0];row.visibility='public';row.definition.visibility='public';
 state.tables.fleet_carriers=[{carrier_id:'123',owner_id:'owner',squadron_id:8,cargo:{items:[{commodity:'steel',quantity:12345}],updatedAt:'2026-11-23'}}];
 const result=await detail.GET(req(),params);assert.equal(result.status,200);assert.deepEqual(globalThis.lpViewed,[]);assert.ok(!JSON.stringify(result.body).includes('12345'));assert.equal(result.body.progress.loaded,0);assert.ok(result.body.progress.unknown>0);
});
test('loading API: private ID available to owner with accessible observed stock only',async()=>{
 const state=setup();state.tables.fleet_carriers=[{carrier_id:'123',owner_id:'owner',cargo:{items:[],observations:{},updatedAt:'2026-11-23'}}];
 const result=await detail.GET(req(),params);assert.equal(result.status,200);assert.equal(result.body.pattern.canEdit,true);assert.equal(globalThis.lpViewed.length,1);assert.ok(result.body.progress.unknown>0);
});
test('loading API: anonymous public detail never queries stock',async()=>{
 const state=setup(null);state.tables.carrier_loading_patterns[0].visibility='public';const result=await detail.GET(req(),params);assert.equal(result.status,200);assert.equal(globalThis.lpViewed.length,0);
});
test('loading API: owner and author cannot be spoofed, server recomputes requirements',async()=>{
 const state=setup();const result=await collection.POST(req('POST',{...pattern(),owner_id:'attacker',author_name:'Spoof',requirements:{steel:1}}));
 assert.equal(result.status,201);assert.equal(state.writes[0].owner_id,'owner');assert.equal(state.writes[0].author_name,'Owner');assert.ok(result.body.pattern.total>1);assert.equal(result.body.pattern.canEdit,true);
});
test('loading API: third parties cannot edit/delete public patterns and cannot spoof version',async()=>{
 const state=setup('stranger');state.tables.carrier_loading_patterns[0].visibility='public';
 for(const method of ['PATCH','DELETE']){const result=await detail[method](req(method,{...pattern(),version:1}),params);assert.equal(result.status,404);}
 assert.deepEqual(state.writes,[]);
});
test('loading API: optimistic concurrency prevents lost updates and stale deletion',async()=>{
 setup();let result=await detail.PATCH(req('PATCH',{...pattern(),name:'Updated',version:1}),params);assert.equal(result.status,200);assert.equal(result.body.pattern.version,2);
 result=await detail.PATCH(req('PATCH',{...pattern(),version:1}),params);assert.equal(result.status,409);
 result=await detail.DELETE(req('DELETE',{version:1}),params);assert.equal(result.status,409);
 result=await detail.DELETE(req('DELETE',{version:2}),params);assert.equal(result.status,200);
});
test('loading API: validation, size bound, auth, rate limit and database failures',async()=>{
 setup(null);assert.equal((await collection.POST(req('POST',pattern()))).status,401);
 setup();assert.equal((await collection.POST(req('POST',{...pattern(),name:'x'.repeat(140000)}))).status,400);
 assert.equal((await detail.PATCH(req('PATCH',{...pattern(),version:0}),params)).status,400);
 globalThis.lpRate=false;assert.equal((await collection.POST(req('POST',pattern()))).status,429);
 const state=setup();state.error=true;assert.equal((await collection.GET(req())).status,503);assert.equal((await collection.POST(req('POST',pattern()))).status,503);
});


test('loading API: catalogue v4 primary templates list/open safely and only explicit save persists v5',async()=>{
 const state=setup();const row=state.tables.carrier_loading_patterns[0];
 row.catalogue_version=4;
 row.definition={...pattern(),buildings:[{installationId:'nemesis',count:1,primary:true}],allocations:{'123':{steel:3500,battleweapons:35}}};
 const before=structuredClone(row);
 const list=await collection.GET(req());assert.equal(list.status,200);assert.equal(list.body.patterns[0].total,21835);
 const result=await detail.GET(req(),params);assert.equal(result.status,200);
 assert.equal(result.body.pattern.catalogueUpdated,true);assert.equal(result.body.pattern.allocationsAdjusted,true);
 assert.equal(result.body.pattern.requirements.aluminium,500);assert.equal(result.body.progress.unassigned,21835-3500);
 assert.deepEqual(row,before);assert.deepEqual(state.writes,[]);
 const bad=await detail.PATCH(req('PATCH',{...row.definition,catalogue_version:4,version:1}),params);assert.equal(bad.status,400);
 const saved=await detail.PATCH(req('PATCH',{...result.body.pattern.pattern,version:1}),params);
 assert.equal(saved.status,200);assert.equal(saved.body.pattern.catalogueUpdated,false);assert.equal(row.catalogue_version,5);
});

const pilotId='aaaaaaaa-2222-4333-8444-555555555555';
const loaderId='bbbbbbbb-2222-4333-8444-555555555555';
function teamFixture() {
 const state=setup('owner');
 state.tables.public_profiles.push({id:pilotId,cmdr_name:'Cargo_Pilot'},{id:loaderId,cmdr_name:'Loader'});
 state.tables.carrier_loading_pattern_members=[
  {pattern_id:id,user_id:pilotId,cmdr_name:'Cargo_Pilot',accepted_at:null,shared_carrier_ids:[]},
  {pattern_id:id,user_id:loaderId,cmdr_name:'Loader',accepted_at:'2026-11-23',shared_carrier_ids:[]},
 ];
 state.tables.fleet_carriers=[{carrier_id:'123',owner_id:pilotId,squadron_id:8,cargo_updated_at:'2026-11-23T12:00:00Z',finance:{balance:9999999}}];
 state.tables.fleet_carrier_cargo=[{carrier_id:'123',commodity:'aluminium',quantity:123456,observed_at:'2026-11-23T12:00:00Z',updated_at:'2026-11-23T12:00:00Z'}];
 return state;
}
test('loading team: only author invites, exact CMDR lookup, no auto-consent and duplicate protection',async()=>{
 const state=setup();state.tables.public_profiles.push({id:pilotId,cmdr_name:'Cargo_Pilot'});
 let result=await membersApi.POST(req('POST',{cmdr:'cargo_pilot'}),params);
 assert.equal(result.status,200);const member=state.tables.carrier_loading_pattern_members[0];
 assert.equal(member.user_id,pilotId);assert.equal(member.accepted_at,null);assert.deepEqual(member.shared_carrier_ids,[]);
 assert.equal((await membersApi.POST(req('POST',{cmdr:'Cargo_Pilot'}),params)).status,409);
 assert.equal((await membersApi.POST(req('POST',{cmdr:'Cargo%'}),params)).status,404);
 globalThis.lpUser=pilotId;assert.equal((await membersApi.POST(req('POST',{cmdr:'Owner'}),params)).status,404);
 globalThis.lpUser='stranger';assert.equal((await membersApi.POST(req('POST',{cmdr:'Owner'}),params)).status,404);
 globalThis.lpUser=null;assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:[]}),params)).status,401);
});
test('loading team: invited private templates appear in mine/Helper, cannot edit assignments',async()=>{
 teamFixture();globalThis.lpUser=pilotId;
 const list=await collection.GET(req());assert.equal(list.status,200);assert.equal(list.body.patterns.length,1);assert.equal(list.body.patterns[0].canEdit,false);
 const detailResult=await detail.GET(req(),params);assert.equal(detailResult.status,200);assert.equal(detailResult.body.collaboration.self.accepted,false);
 for(const method of ['PATCH','DELETE'])assert.equal((await detail[method](req(method,{...pattern(),version:1}),params)).status,404);
});
test('loading team: only owner of selected carrier consents; forged identity, unassigned IDs and officer access rejected',async()=>{
 const state=teamFixture();
 assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123'],userId:pilotId}),params)).status,403);
 globalThis.lpUser=loaderId;
 assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123']}),params)).status,403);
 globalThis.lpUser=pilotId;
 assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['999']}),params)).status,400);
 assert.equal((await membersApi.PATCH(req('PATCH',{accept:false,sharedCarrierIds:[]}),params)).status,400);
 assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123','123']}),params)).status,400);
 assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123']}),params)).status,200);
 assert.ok(state.tables.carrier_loading_pattern_members[0].accepted_at);
});
test('loading team: consent opens capped assigned coverage for author and accepted loaders, not entire bank/finance/public',async()=>{
 const state=teamFixture();let result=await detail.GET(req(),params);
 assert.equal(result.body.progress.loaded,0);assert.ok(!state.reads.includes('fleet_carrier_cargo'));
 globalThis.lpUser=pilotId;await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123']}),params);
 for(const user of ['owner',loaderId]) {
  globalThis.lpUser=user;result=await detail.GET(req(),params);assert.equal(result.status,200);
  const steel=result.body.progress.carriers[0].items.find(item=>item.commodity==='aluminium');
  assert.ok(steel.loaded>0);assert.equal(steel.loaded,steel.required);
  assert.ok(!JSON.stringify(result.body).includes('123456'));assert.ok(!JSON.stringify(result.body).includes('9999999'));
 }
 state.tables.carrier_loading_patterns[0].visibility='public';
 for(const user of ['stranger',null]) {
  globalThis.lpUser=user;result=await detail.GET(req(),params);assert.equal(result.body.progress.loaded,0);assert.equal(result.body.collaboration,null);
 }
 state.tables.carrier_loading_pattern_members[1].accepted_at=null;
 globalThis.lpUser=loaderId;result=await detail.GET(req(),params);assert.equal(result.body.progress.loaded,0);
});
test('loading team: accepting as loader requires no carrier or disclosure; owner can separately opt into sharing',async()=>{
 const state=teamFixture();globalThis.lpUser=pilotId;
 await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123']}),params);
 globalThis.lpUser=loaderId;
 assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:[]}),params)).status,200);
 assert.ok((await detail.GET(req(),params)).body.progress.loaded>0);
 globalThis.lpUser='owner';state.tables.fleet_carriers[0].owner_id='owner';
 assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123']}),params)).status,200);
 const ownMember=state.tables.carrier_loading_pattern_members.find(row=>row.user_id==='owner');assert.deepEqual(ownMember.shared_carrier_ids,['123']);
});
test('loading team: consent revocation, current ownership and participant removal take effect on next read',async()=>{
 const state=teamFixture();globalThis.lpUser=pilotId;await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123']}),params);
 globalThis.lpUser=loaderId;assert.ok((await detail.GET(req(),params)).body.progress.loaded>0);
 state.tables.fleet_carriers[0].owner_id='new-owner';assert.equal((await detail.GET(req(),params)).body.progress.loaded,0);
 state.tables.fleet_carriers[0].owner_id=pilotId;
 globalThis.lpUser=pilotId;await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:[]}),params);
 globalThis.lpUser=loaderId;assert.equal((await detail.GET(req(),params)).body.progress.loaded,0);
 assert.equal((await membersApi.DELETE(req('DELETE',{userId:pilotId}),params)).status,404);
 assert.equal((await membersApi.DELETE(req('DELETE',{}),params)).status,200);
 assert.equal((await detail.GET(req(),params)).status,404);assert.equal((await collection.GET(req())).body.patterns.length,0);
 globalThis.lpUser='owner';assert.equal((await membersApi.DELETE(req('DELETE',{userId:pilotId}),params)).status,200);
 globalThis.lpUser=pilotId;assert.equal((await membersApi.PATCH(req('PATCH',{accept:true,sharedCarrierIds:['123']}),params)).status,404);
});
