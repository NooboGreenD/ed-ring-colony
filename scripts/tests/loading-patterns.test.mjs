import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTALLATIONS } from '../../src/lib/architect/catalogue.ts';
import { parseLoadingPattern, loadingRequirements, distributeLoading, unassignedLoading, loadingProgress } from '../../src/lib/architect/loadingPatterns.ts';

const make = () => ({name:'Two carriers',visibility:'private',buildings:[{installationId:INSTALLATIONS[0].id,count:2,primary:false}],carriers:[{carrierId:'123',name:'Alpha',capacity:25000},{carrierId:'456',name:'Beta',capacity:1}]});
test('loading: catalogue aggregation uses counts and primary costs',()=>{
 const p=make(); const requirements=loadingRequirements(p.buildings);
 assert.deepEqual(requirements,Object.fromEntries(Object.entries(INSTALLATIONS[0].cargo).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,v*2])));
 const primary=INSTALLATIONS.find(i=>i.primary);assert.ok(primary);
 assert.deepEqual(loadingRequirements([{installationId:primary.id,count:1,primary:true}]),Object.fromEntries(Object.entries(primary.primary.cargo).sort(([a],[b])=>a.localeCompare(b))));
});
test('loading: deterministic whole tonne allocation retains overflow',()=>{
 const p=make();p.carriers[0].capacity=3;p.carriers[1].capacity=2;
 assert.deepEqual(distributeLoading({steel:4,titanium:3},p.carriers),{'123':{steel:3},'456':{steel:1,titanium:1}});
 const parsed=parseLoadingPattern(p);assert.equal(Object.values(unassignedLoading(parsed)).reduce((a,b)=>a+b,0),Object.values(loadingRequirements(p.buildings)).reduce((a,b)=>a+b,0)-5);
});
test('loading: strict shape rejects duplicate carriers, unknown goods, quantities, variants and oversized input',()=>{
 for(const change of [p=>p.carriers.push(p.carriers[0]),p=>p.carriers[0].carrierId='invalid',p=>p.carriers[0].capacity=60001,p=>p.carriers[0].capacity=1.5,p=>p.buildings[0].count=0,p=>p.buildings[0].count=101,p=>p.buildings[0].installationId='unknown',p=>p.visibility='friends',p=>p.visibility=['private'],p=>p.allocations={'123':{notagood:1}},p=>p.allocations={'777':{}},p=>p.name=' ',p=>p.name='x'.repeat(101),p=>p.buildings=[],p=>p.carriers=[]]) {
  const p=make();change(p);assert.throws(()=>parseLoadingPattern(p));
 }
 const item=INSTALLATIONS.find(i=>!i.primary);const p=make();p.buildings=[{installationId:item.id,count:1,primary:true}];assert.throws(()=>parseLoadingPattern(p));
});
test('loading: both per-carrier capacity and cross-carrier commodity target enforced',()=>{
 const p=make(); const goods=loadingRequirements(p.buildings),good=Object.keys(goods)[0];
 p.allocations={'123':{[good]:goods[good]+1}};assert.throws(()=>parseLoadingPattern(p));
 p.allocations={'456':{[good]:2}};assert.throws(()=>parseLoadingPattern(p));
 p.allocations={'123':{[good]:goods[good]},'456':{[good]:1}};assert.throws(()=>parseLoadingPattern(p));
 p.allocations={'123':{[good]:-1}};assert.throws(()=>parseLoadingPattern(p));
 p.allocations={'123':{[good]:NaN}};assert.throws(()=>parseLoadingPattern(p));
});
test('loading: progress caps excess, keeps inaccessible/partial stock unknown and never substitutes ship cargo',()=>{
 const p=parseLoadingPattern(make());const entries=Object.entries(p.allocations['123']);assert.ok(entries.length);
 const [good,required]=entries[0];
 const unknown=loadingProgress(p,new Map());assert.equal(unknown.loaded,0);assert.equal(unknown.unknown,unknown.assigned);assert.equal(unknown.complete,false);assert.equal(unknown.carriers[0].items[0].remaining,null);
 const partial=loadingProgress(p,new Map([['123',{items:[{commodity:good,quantity:required+100}],updatedAt:'2026-11-23T12:00:00Z'}]]));
 assert.equal(partial.carriers[0].items.find(i=>i.commodity===good).loaded,required);
 assert.ok(partial.unknown>0);assert.equal(partial.complete,false);
 const full=new Map(p.carriers.map(c=>[c.carrierId,{items:Object.entries(p.allocations[c.carrierId]).map(([commodity,quantity])=>({commodity,quantity})),updatedAt:'2026-11-23T12:00:00Z',baselineAt:'2026-11-23T12:00:00Z'}]));
 const complete=loadingProgress(p,full);assert.equal(complete.complete,complete.total===complete.assigned);assert.equal(complete.unknown,0);
});
test('loading: zero stock with commodity observation is known, absent unobserved commodity is not',()=>{
 const p=parseLoadingPattern(make());const good=Object.keys(p.allocations['123'])[0];
 const result=loadingProgress(p,new Map([['123',{items:[],observations:{[good]:'2026-11-23T12:00:00Z'},updatedAt:'2026-11-23T12:00:00Z'}]]));
 const row=result.carriers[0].items.find(i=>i.commodity===good);assert.equal(row.loaded,0);assert.equal(row.remaining,row.required);assert.ok(row.observedAt);
});

test('loading recipes: personal 1 + squadron 2 primary outposts match the 21835 / 43670 example', async () => {
 const {distributeLoadingRecipes}=await import('../../src/lib/architect/loadingPatterns.ts');
 const outpost=INSTALLATIONS.find(i=>i.buildClass==='outpost' && i.primary);
 const buildings=[{installationId:outpost.id,count:3,primary:true}];
 const carriers=[{carrierId:'123',name:'Personal',capacity:25000,recipeLimit:1},{carrierId:'456',name:'Squadron',capacity:60000,recipeLimit:2}];
 const allocations=distributeLoadingRecipes(buildings,carriers);
 const sum=values=>Object.values(values).reduce((a,b)=>a+b,0);
 assert.equal(sum(allocations['123']),21835);assert.equal(sum(allocations['456']),43670);
 for(const [good,qty] of Object.entries(outpost.primary.cargo)) {assert.equal(allocations['123'][good],qty);assert.equal(allocations['456'][good],qty*2);}
 const p=parseLoadingPattern({name:'Kits',visibility:'private',buildings,carriers,allocations});
 assert.deepEqual(unassignedLoading(p),{});assert.equal(p.carriers[1].recipeLimit,2);
 assert.deepEqual(parseLoadingPattern(p),p);
});

test('loading recipes: no splitting, no inference from capacity, respect explicit limits and retain overflow', async () => {
 const {distributeLoadingRecipes}=await import('../../src/lib/architect/loadingPatterns.ts');
 const outpost=INSTALLATIONS.find(i=>i.buildClass==='outpost' && i.primary);
 const buildings=[{installationId:outpost.id,count:4,primary:true}];
 for (const [capacity,limit,expected] of [[60000,1,21835],[60000,2,43670],[43669,2,21835],[21834,2,0],[0,1,0],[60000,undefined,21835]]) {
  const carriers=[{carrierId:'123',name:'Carrier',capacity,...(limit?{recipeLimit:limit}:{})}];
  const allocations=distributeLoadingRecipes(buildings,carriers);
  assert.equal(Object.values(allocations['123']).reduce((a,b)=>a+b,0),expected);
  assert.equal(Object.values(unassignedLoading({buildings,carriers,allocations})).reduce((a,b)=>a+b,0),21835*4-expected);
 }
 for(const recipeLimit of [0,3,1.5,'2',null]) { const p=make();p.carriers[0].recipeLimit=recipeLimit;assert.throws(()=>parseLoadingPattern(p)); }
 assert.ok(!Object.hasOwn(parseLoadingPattern(make()).carriers[0],'recipeLimit'));
});

test('loading recipes: mixed recipes/primary variants, later small kit can fit and inputs remain unchanged', async () => {
 const {distributeLoadingRecipes}=await import('../../src/lib/architect/loadingPatterns.ts');
 const small=INSTALLATIONS.find(i=>i.buildClass==='outpost' && i.primary);
 const large=INSTALLATIONS[0];
 const buildings=[{installationId:large.id,count:1,primary:false},{installationId:small.id,count:2,primary:false},{installationId:small.id,count:1,primary:true}];
 const carriers=[{carrierId:'123',name:'A',capacity:25000,recipeLimit:2},{carrierId:'456',name:'B',capacity:25000,recipeLimit:1},{carrierId:'789',name:'C',capacity:25000,recipeLimit:1}];
 const before=JSON.stringify({buildings,carriers});
 const allocations=distributeLoadingRecipes(buildings,carriers);
 assert.deepEqual(allocations['123'],small.cargo);assert.deepEqual(allocations['456'],small.cargo);assert.deepEqual(allocations['789'],small.primary.cargo);
 assert.equal(JSON.stringify({buildings,carriers}),before);
 assert.doesNotThrow(()=>parseLoadingPattern({name:'Mixed',visibility:'private',buildings,carriers,allocations}));
});
