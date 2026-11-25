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
