import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { validBankInventory } from '../../src/lib/bankCorrection.ts';
const {GET,POST}=await import(await bundleFile({entry:'src/app/api/carriers/[id]/bank/correction/route.ts',stubs:{
 'next/server':`export const NextResponse={json:(body,options={})=>({body,status:options.status||200,headers:options.headers||{}})};`,
 '@/lib/helperAuth':`export const resolveRequestUser=async()=>globalThis.__correctionUser?{userId:globalThis.__correctionUser,via:'session'}:null;`,
 '@/lib/supabaseServer':`export const createServiceClient=()=>globalThis.__correctionDb;`,
 '@/lib/rateLimit':`export const checkRateLimit=()=>globalThis.__correctionRate!==false;`,
 '@/lib/i18n/apiT':`export const apiTranslate=async()=>key=>key;`,
}}));
const id='3713477376';
const payload=()=>({callsign:'DNHG',observedAt:'2026-03-10T11:00:00Z',reason:'Verified the complete bank in game',confirmComplete:true,
 items:[{commodity:'tritium',qty:1034},{commodity:'thargoidtitandrivecomponent',qty:4},{commodity:'drones',qty:2}]});
function setup(user='officer'){
 globalThis.__correctionUser=user;globalThis.__correctionRate=true;
 const state={rpcError:null,queryError:null,calls:[],tables:{
  squadron_members:[{squadron_id:7,user_id:'officer',rank_id:1},{squadron_id:7,user_id:'member',rank_id:2},{squadron_id:7,user_id:'leader',rank_id:2},{squadron_id:8,user_id:'stranger',rank_id:3}],
  squadron_ranks:[{id:1,squadron_id:7,can_edit_squadron:true},{id:2,squadron_id:7,can_edit_squadron:false}],
  squadrons:[{id:7,created_by:'leader'}],
  fleet_carriers:[{carrier_id:id,carrier_type:'SquadronCarrier',squadron_id:7,callsign:'DNHG',finance:{secret:123}}],
  squadron_bank_reconciliations:[{id:1,carrier_id:id,observed_at:'2026-03-01T00:00:00Z',recorded_at:'2026-03-01T01:00:00Z',reason:'Previous inventory correction',actor_id:'officer',items:[{commodity:'steel',qty:20}],previous_cargo:[{secret:1}],recorded_by:'service_role'}],
  public_profiles:[{id:'officer',cmdr_name:'Officer Name',email:'secret@example.test'}],
 }};
 globalThis.__correctionDb={from(table){state.calls.push({table});const filters=[];let limit=Infinity;const query={select(){return this},order(){return this},limit(n){limit=n;return this},eq(k,v){filters.push(row=>String(row[k])===String(v));return this},in(k,v){filters.push(row=>v.map(String).includes(String(row[k])));return this},
  async run(single=false){const data=(state.tables[table]??[]).filter(row=>filters.every(f=>f(row))).slice(0,limit);return {data:single?(data[0]??null):data,error:state.queryError?.table===table?state.queryError:null}},maybeSingle(){return this.run(true)},then(resolve,reject){return this.run().then(resolve,reject)}};return query},
 async rpc(name,params){state.calls.push({rpc:name,params});return {data:state.rpcError?null:{ok:true,id:2,duplicate:false},error:state.rpcError}}
 };return state;
}
const get=(carrier=id)=>GET(new Request('https://example.test/api/carriers/'+carrier+'/bank/correction'),{params:Promise.resolve({id:carrier})});
const post=(body=payload(),carrier=id)=>POST(new Request('https://example.test/api/carriers/'+carrier+'/bank/correction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({id:carrier})});

test('correction permission is derived from membership/rank; leader and officer can correct, regular members only read bank',async()=>{
 for(const [user,status,canCorrect] of [[null,401,false],['stranger',403,false],['member',200,false],['officer',200,true],['leader',200,true]]){
  const state=setup(user);const result=await get();assert.equal(result.status,status);assert.equal(result.body.canCorrect===true,canCorrect);assert.equal(result.headers['Cache-Control'],'private, no-store');
  const mutation=await post();assert.equal(mutation.status,canCorrect?200:status===401?401:403);
  assert.equal(state.calls.filter(call=>call.rpc).length,canCorrect?1:0);
  if(!canCorrect)assert.ok(!state.calls.some(call=>call.table==='squadron_bank_reconciliations'));
 }
});
test('correction GET is a minimal officer-only audit DTO with author, never cargo backups, identities or finance',async()=>{
 setup();const result=await get();assert.equal(result.status,200);assert.ok(Number.isFinite(Date.parse(result.body.serverNow)));
 assert.deepEqual(result.body.history,[{id:1,observedAt:'2026-03-01T00:00:00Z',recordedAt:'2026-03-01T01:00:00Z',reason:'Previous inventory correction',total:20,author:'Officer Name'}]);
 assert.doesNotMatch(JSON.stringify(result.body),/previous_cargo|secret|actor_id|email|finance|service_role/);
});
test('POST passes only validated inventory and server-derived actor/carrier/squadron values to the locked RPC',async()=>{
 const state=setup();const body={...payload(),p_actor_id:'attacker',p_squadron_id:99,actor_id:'attacker',squadronId:99,items:payload().items.map(item=>({...item,secret:'discard'}))};
 const result=await post(body);assert.equal(result.status,200);
 const call=state.calls.find(call=>call.rpc);assert.equal(call.rpc,'correct_squadron_bank_as_officer');
 assert.deepEqual(call.params,{p_actor_id:'officer',p_squadron_id:7,p_carrier_id:id,p_expected_callsign:'DNHG',p_observed_at:'2026-03-10T11:00:00.000Z',p_items:payload().items,p_reason:payload().reason});
 assert.deepEqual(result.body,{ok:true,id:2,duplicate:false});
});
test('POST rejects unconfirmed, wrong identity, malformed, future, fractional, duplicate, oversized and unknown inputs without writes',async()=>{
 const state=setup();
 for(const change of [{confirmComplete:false},{callsign:'OTHER'},{reason:'short'},{reason:'x'.repeat(1001)},{observedAt:''},{observedAt:'infinity'},
  {observedAt:'2026-03-10T11:00'},{observedAt:new Date(Date.now()+3600000).toISOString()},
  {items:[{commodity:'steel',qty:1.2}]},{items:[{commodity:'steel',qty:-1}]},{items:[{commodity:'steel',qty:'3'}]},
  {items:[{commodity:'steel',qty:60001}]},{items:[{commodity:'steel',qty:40000},{commodity:'water',qty:30000}]},
  {items:[{commodity:'steel',qty:1},{commodity:'steel',qty:2}]},{items:[{commodity:'unknown',qty:2}]},
  {items:[{commodity:'steel',qty:1,name_localised:'x'.repeat(121)}]},{items:Array(513).fill({commodity:'steel',qty:0})}])assert.equal((await post({...payload(),...change})).status,400,JSON.stringify(change).slice(0,150));
 for(const body of [null,[],{}])assert.equal((await post(body)).status,400);
 const oversized=new Request('https://example.test/',{method:'POST',body:'x'.repeat(128*1024+1)});
 assert.equal((await POST(oversized,{params:Promise.resolve({id})})).status,413);
 assert.equal((await POST(new Request('https://example.test/',{method:'POST',body:'{bad'}),{params:Promise.resolve({id})})).status,400);
 assert.equal(state.calls.filter(call=>call.rpc).length,0);
});
test('API rejects personal, unbound, wrong-squadron and invalid carrier references',async()=>{
 for(const change of [{carrier_type:'FleetCarrier'},{squadron_id:null},{squadron_id:8}]){const state=setup();Object.assign(state.tables.fleet_carriers[0],change);assert.equal((await post()).status,403);assert.ok(!state.calls.some(call=>call.rpc));}
 setup();assert.equal((await get('DNHG')).status,404);assert.equal((await post(payload(),'0')).status,403);
});
test('RPC reauthorization, conflicts, missing migrations and rate limits fail closed',async()=>{
 const state=setup();for(const [code,status,error] of [['42501',403,'bc.forbidden'],['P0001',409,'bc.conflict'],['PGRST202',503,'bc.unavailable']]){
  state.rpcError={code};const result=await post();assert.equal(result.status,status);assert.equal(result.body.error,error);
 }
 state.rpcError=null;globalThis.__correctionRate=false;assert.equal((await post()).status,429);
 globalThis.__correctionRate=true;state.queryError={table:'squadron_bank_reconciliations',code:'42P01'};assert.equal((await get()).status,503);
});
test('an explicitly confirmed empty inventory is supported; validation retains drones and Titan components',async()=>{
 setup();assert.equal((await post({...payload(),items:[]})).status,200);assert.ok(validBankInventory(payload().items));assert.ok(validBankInventory([]));assert.ok(!validBankInventory(null));
});

test('all seven locales provide the complete correction vocabulary with matching placeholders',async()=>{
 const {translations}=await import(await bundleFile({entrySource:`export {translations} from '@/lib/i18n/translations';`}));
 const keys=Object.keys(translations.ru).filter(key=>key.startsWith('bc.'));assert.ok(keys.length>=31);
 const placeholders=value=>[...value.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
 for(const locale of ['en','de','it','ko','zh','ja'])for(const key of keys){
  assert.ok(translations[locale][key]?.trim(),`${locale}: ${key}`);
  assert.deepEqual(placeholders(translations[locale][key]),placeholders(translations.ru[key]),`${locale}: ${key}`);
 }
});
