import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTALLATIONS, CATALOGUE_VERSION } from '../../src/lib/architect/catalogue.ts';
import { addLoadingExtra, setLoadingAllocation, loadingExtraTotal, parseLoadingPattern, loadingRequirements, loadingPatternView, loadingProgress, unassignedLoading, distributeLoadingRecipes } from '../../src/lib/architect/loadingPatterns.ts';

const outpost = INSTALLATIONS.find(i => i.buildClass === 'outpost' && i.primary);
function fullKits() {
  const buildings = [{installationId: outpost.id, count: 3, primary: true}];
  const carriers = [{carrierId:'123', name:'Personal', capacity:25000, recipeLimit:1}, {carrierId:'456', name:'Squadron', capacity:60000, recipeLimit:2}];
  return parseLoadingPattern({name:'Extras', visibility:'private', buildings, carriers, allocations:distributeLoadingRecipes(buildings, carriers)});
}
const sum = o => Object.values(o).reduce((a,b) => a+b,0);

test('loading extras: add 1 then 2 to every nonzero cell, preserve recipes and save/reopen exact targets', () => {
  const original = fullKits(); const before = structuredClone(original);
  const count = Object.values(original.allocations).reduce((n,rows) => n+Object.keys(rows).length,0);
  const first = addLoadingExtra(original,1);
  const result = addLoadingExtra(first.pattern,2);
  assert.deepEqual(result.shortages,[]); assert.equal(result.changedRows,count);
  assert.equal(loadingExtraTotal(result.pattern),count*3);
  assert.deepEqual(loadingRequirements(result.pattern.buildings),loadingRequirements(original.buildings));
  for (const [id, rows] of Object.entries(original.allocations)) for (const [good,qty] of Object.entries(rows)) {
    assert.equal(result.pattern.allocations[id][good],qty+3);
    assert.equal(result.pattern.extras[id][good],3);
  }
  assert.deepEqual(parseLoadingPattern(JSON.parse(JSON.stringify(result.pattern))),result.pattern);
  const view = loadingPatternView({definition:result.pattern,catalogue_version:CATALOGUE_VERSION,owner_id:'owner'},'owner');
  assert.equal(view.total,65505+count*3); assert.deepEqual(view.unassigned,{});
  assert.deepEqual(original,before);
});

test('loading extras: zero/missing cells stay zero, extras never cover unassigned base demand', () => {
  const p=fullKits();p.buildings[0].count=4;
  p.allocations={'123':{steel:2,water:0},'456':{titanium:3}};
  const outstanding=unassignedLoading(p);
  const result=addLoadingExtra(p,2);
  assert.equal(result.changedRows,2);
  assert.deepEqual(result.pattern.allocations,{'123':{steel:4,water:0},'456':{titanium:5}});
  assert.deepEqual(result.pattern.extras,{'123':{steel:2},'456':{titanium:2}});
  assert.deepEqual(unassignedLoading(result.pattern),outstanding);
  assert.deepEqual(addLoadingExtra({...p,allocations:{}},2),{pattern:{...p,allocations:{}},shortages:[],changedRows:0});
  for(const amount of [0,-1,0.5,NaN,Infinity,'2',60001])assert.throws(()=>addLoadingExtra(p,amount));
});

test('loading extras: capacity failure is atomic even when another carrier has plenty of space; exact fit allowed', () => {
  const p=fullKits();const id='456';const needed=Object.keys(p.allocations[id]).length*2;
  p.carriers[1].capacity=sum(p.allocations[id])+needed-1;
  const before=structuredClone(p);const result=addLoadingExtra(p,2);
  assert.equal(result.pattern,p);assert.equal(result.changedRows,0);
  assert.deepEqual(result.shortages,[{carrierId:id,name:'Squadron',needed,free:needed-1,shortfall:1}]);
  assert.deepEqual(p,before);
  p.carriers[1].capacity++;const fits=addLoadingExtra(p,2);
  assert.deepEqual(fits.shortages,[]);assert.equal(sum(fits.pattern.allocations[id]),p.carriers[1].capacity);
  assert.doesNotThrow(()=>parseLoadingPattern(fits.pattern));
});

test('loading extras: strict validation rejects forged metadata, unknown goods/carriers and capacity excess', () => {
  const p=fullKits();const id='123', good=Object.keys(p.allocations[id])[0];
  for(const change of [
    p=>p.extras=[],p=>p.extras=null,p=>p.extras={'999':{[good]:1}},p=>p.extras={[id]:{future:1}},
    p=>p.extras={[id]:{[good]:-1}},p=>p.extras={[id]:{[good]:0.5}},p=>p.extras={[id]:{[good]:60001}},
    p=>p.extras={[id]:{[good]:p.allocations[id][good]}},p=>p.extras={[id]:{water:1}},
  ]){const invalid=structuredClone(p);delete invalid.allocations[id].water;change(invalid);assert.throws(()=>parseLoadingPattern(invalid));}
  const over=addLoadingExtra(p,1).pattern;over.carriers[0].capacity=sum(over.allocations[id])-1;
  assert.throws(()=>parseLoadingPattern(over));
  const unmarked=structuredClone(p);unmarked.allocations[id][good]++;
  assert.throws(()=>parseLoadingPattern(unmarked),'surplus must be explicitly recorded');
});

test('loading extras: progress and Helper targets include extras, no negative unassigned or early completion', () => {
  const p=fullKits(), extra=addLoadingExtra(p,2).pattern;
  const stock=new Map(p.carriers.map(c=>[c.carrierId,{items:Object.entries(p.allocations[c.carrierId]).map(([commodity,quantity])=>({commodity,quantity})),baselineAt:'2026-11-23',updatedAt:'2026-11-23'}]));
  const before=loadingProgress(extra,stock);
  assert.equal(before.total,65505+loadingExtraTotal(extra));assert.equal(before.unassigned,0);
  assert.equal(before.loaded,65505);assert.equal(before.complete,false);
  for(const c of extra.carriers)stock.get(c.carrierId).items=Object.entries(extra.allocations[c.carrierId]).map(([commodity,quantity])=>({commodity,quantity}));
  const done=loadingProgress(extra,stock);assert.equal(done.complete,true);assert.equal(done.loaded,done.total);
  const unknown=loadingProgress(extra,new Map());assert.equal(unknown.unknown,unknown.assigned);assert.equal(unknown.complete,false);
  assert.equal(unknown.carriers[0].items[0].remaining,null);
  // Partial base allocation plus reserves must still report missing building goods.
  const partial=addLoadingExtra({...p,allocations:{'123':{steel:1}}},2).pattern;
  const progress=loadingProgress(partial,new Map());assert.equal(progress.unassigned,65504);
});

test('loading extras: manual zero clears reserve; re-auto distributes from unmodified recipe without extras', () => {
  const extra=addLoadingExtra(fullKits(),2).pattern;
  const good=Object.keys(extra.allocations['123'])[0];
  const edited=setLoadingAllocation(extra,'123',good,0);
  assert.equal(edited.allocations['123'][good],0);assert.equal(edited.extras['123'][good],undefined);
  assert.doesNotThrow(()=>parseLoadingPattern(edited));
  const small=setLoadingAllocation(extra,'123',good,1);
  assert.equal(small.extras['123'][good],undefined);
  const auto={...extra,extras:undefined,allocations:distributeLoadingRecipes(extra.buildings,extra.carriers)};
  assert.equal(loadingExtraTotal(auto),0);assert.equal(loadingProgress(parseLoadingPattern(auto),new Map()).total,65505);
});

test('loading extras: catalogue reconciliation trims only excess base, preserves valid reserve and drops obsolete goods',()=>{
 const p=fullKits();const goods=loadingRequirements(p.buildings);
 p.allocations={'123':{steel:goods.steel+22,obsolete:5}};
 p.extras={'123':{steel:2,obsolete:1}};p.carriers[0].capacity=60000;
 const before=structuredClone(p);
 const view=loadingPatternView({definition:p,catalogue_version:CATALOGUE_VERSION-1},null);
 assert.equal(view.allocationsAdjusted,true);
 assert.deepEqual(view.pattern.allocations['123'],{steel:goods.steel+2});
 assert.deepEqual(view.pattern.extras,{'123':{steel:2}});
 assert.deepEqual(view.pattern.allocations['456'],{});
 assert.doesNotThrow(()=>parseLoadingPattern(view.pattern));assert.deepEqual(p,before);
});

test('loading extras: controls and capacity messages are translated with matching placeholders in every locale',async()=>{
 const {loadingPatternTranslations:dict}=await import('../../src/lib/i18n/loadingPatterns.ts');
 const keys=['extraTonnes','addExtra','extraHint','extraCapacity','extraAdded','extraSummary','cellExtra','extraInvalid'];
 const placeholders=text=>[...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
 for(const locale of ['ru','en','de','it','ko','zh','ja'])for(const key of keys){
  const value=dict[locale]['lp.'+key];assert.ok(value,locale+':'+key);
  assert.deepEqual(placeholders(value),placeholders(dict.ru['lp.'+key]));
 }
});
