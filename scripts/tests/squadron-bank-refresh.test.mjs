import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
const {squadronBankSnapshot}=await import(await bundleFile({entry:'src/lib/capi/squadronBank.ts'}));
const at=new Date('2026-03-10T11:00:00Z');
const expected={callsign:'TEST',carrierId:'3713000111'};
const raw=()=>({tag:'TEST',squadronCarrier:{name:{callsign:'TEST'}},bank:{commodities:{All:[
 {name:'steel',qty:650,locName:'Steel'},{name:'water',qty:25}],
 '$squadron_bank_personal_account;':[{name:'steel',qty:9000}]}},members:[{secret:'not imported'}]});

test('Frontier shared bank is absolute stock, not orders, personal allocations or the visiting ship cargo',()=>{
 const result=squadronBankSnapshot(raw(),expected,at);
 assert.deepEqual(result,{items:[{commodity:'steel',qty:650,name_localised:'Steel'},{commodity:'water',qty:25}],observedAt:at.toISOString()});
 const empty=raw();empty.bank.commodities.All=[];
 assert.deepEqual(squadronBankSnapshot(empty,expected,at).items,[]);
 const timed={...raw(),timestamp:'2026-03-10T10:59:59Z'};
 assert.equal(squadronBankSnapshot(timed,expected,at).observedAt,'2026-03-10T10:59:59.000Z');
 const duringRequest={...raw(),timestamp:'2026-03-10T11:00:01Z'};
 assert.equal(squadronBankSnapshot(duringRequest,expected,at,new Date('2026-03-10T11:00:02Z')).observedAt,
  '2026-03-10T11:00:01.000Z','a provider timestamp generated during retrieval is not a future snapshot');
});
test('missing, malformed, over-capacity, redacted, stale and wrong-carrier replies never become an empty bank',()=>{
 const cases=[null,{}, {...raw(),bank:{}},{...raw(),tag:'ELSE'},
  {...raw(),squadronCarrier:{name:{callsign:'ELSE'}}},
  {...raw(),squadronCarrier:{name:{callsign:'TEST'},market:{id:999}}},
  {...raw(),timestamp:'2026-03-10T11:00:01Z'},{...raw(),timestamp:'2026-03-09T11:00:00Z'}];
 for(const rows of [null,{},[{name:'steel',qty:'650'}],[{name:'steel',qty:-1}],[{name:'steel',qty:1.5}],
  [{name:'unknown-new-item',qty:5}],[{name:'steel',qty:650},{name:'$steel_name;',qty:5}],
  [{name:'steel',qty:60000},{name:'water',qty:1}],[{name:'steel',qty:2,locName:'x'.repeat(121)}]]){
  const data=raw();data.bank.commodities.All=rows;cases.push(data);
 }
 for(const data of cases)assert.equal(squadronBankSnapshot(data,expected,at),null,JSON.stringify(data));
});

const {POST}=await import(await bundleFile({entry:'src/app/api/carriers/[id]/bank/refresh/route.ts',stubs:{
 'next/server':`export const NextResponse={json:(body,options={})=>({body,status:options.status||200,headers:options.headers})};`,
 '@/lib/helperAuth':`export const resolveRequestUser=async()=>globalThis.bankRefresh.user?{userId:'member'}:null;`,
 '@/lib/supabaseServer':`export const createServiceClient=()=>globalThis.bankRefresh.db;`,
 '@/lib/fleetCarrierStore':`export const viewerContext=async()=>({squadronIds:globalThis.bankRefresh.memberships});export const findCarrier=async()=>globalThis.bankRefresh.carrier;`,
 '@/lib/rateLimit':`export const checkRateLimit=()=>globalThis.bankRefresh.rate;`,
 '@/lib/capi/session':`export const capiSession=async()=>({run:async()=>{globalThis.bankRefresh.fetched++;if(globalThis.bankRefresh.failure)throw Error('secret token');return globalThis.bankRefresh.raw}});`,
}}));
function setup(){
 const state={user:true,memberships:[7],carrier:{carrier_id:expected.carrierId,carrier_type:'SquadronCarrier',squadron_id:7,callsign:'TEST'},
  rate:true,raw:raw(),token:{access_token:'secret-access',refresh_token:'secret-refresh',platform:'frontier'},calls:[],fetched:0};
 state.db={from(){return {select(){return this},eq(){return this},async maybeSingle(){return {data:state.token,error:null}}}},
  async rpc(name,params){state.calls.push({name,params});return {data:{ok:true,duplicate:false},error:state.rpcError??null}}};
 globalThis.bankRefresh=state;return state;
}
const post=()=>POST(new Request('https://example.test/api/',{method:'POST',body:JSON.stringify({items:[{commodity:'gold',qty:60000}],p_actor_id:'attacker'})}),{params:Promise.resolve({id:expected.carrierId})});
test('ordinary member can trigger only server-fetched CAPI inventory; response is private and contains no raw data',async()=>{
 const state=setup();const result=await post();assert.equal(result.status,200);
 assert.equal(result.body.total,675);assert.equal(result.headers['Cache-Control'],'private, no-store');
 assert.equal(state.calls.length,1);const {name,params}=state.calls[0];
 assert.equal(name,'sync_squadron_bank_from_capi');assert.equal(params.p_actor_id,'member');assert.equal(params.p_squadron_id,7);
 assert.equal(params.p_carrier_id,expected.carrierId);assert.equal(params.p_items[0].qty,650);
 assert.doesNotMatch(JSON.stringify(result),/secret|members|access_token|refresh_token|gold/);
});
test('refresh denies unauthorized, foreign, personal, unlinked and rate-limited requests without fetching or writing',async()=>{
 for(const [change,status] of [[{user:false},401],[{memberships:[]},403],[{carrier:null},403],
  [{carrier:{carrier_type:'FleetCarrier'}},403],[{token:null},409],[{token:{is_active:false}},409],
  [{token:{platform:'xbox'}},409],[{rate:false},429]]){
  const state=Object.assign(setup(),change);const result=await post();assert.equal(result.status,status);
  assert.equal(state.fetched,0);assert.equal(state.calls.length,0);
 }
});
test('upstream errors, unknown bank schema and concurrent rebindings do not leak data or overwrite stock',async()=>{
 for(const [change,status] of [[{failure:true},503],[{raw:{}},422],[{rpcError:{code:'42501'}},403],[{rpcError:{code:'P0001'}},409],[{rpcError:{code:'42P01'}},503]]){
  const state=Object.assign(setup(),change);const result=await post();assert.equal(result.status,status);
  assert.doesNotMatch(JSON.stringify(result),/secret|"members"|access_token|refresh_token/);
  if(status===422||change.failure)assert.equal(state.calls.length,0);
 }
});

const {CapiClient}=await import(await bundleFile({entry:'src/lib/capi/client.ts'}));
test('CAPI squadron fetch uses Live no-store and refuses partial, empty or malformed responses',async()=>{
 const saved=globalThis.fetch;
 try{
  for(const [status,body,ok] of [[200,JSON.stringify(raw()),true],[206,JSON.stringify(raw()),false],[204,null,false],[200,'{broken',false]]){
   globalThis.fetch=async(url,init)=>{
    assert.equal(url,'https://companion.orerve.net/squadron');assert.equal(init.cache,'no-store');
    assert.equal(init.headers.Authorization,'Bearer frontier-test-token');
    return new Response(body,{status});
   };
   const query=new CapiClient('frontier-test-token').getSquadron();
   if(ok)assert.deepEqual(await query,raw());else await assert.rejects(query);
  }
 }finally{globalThis.fetch=saved}
});
