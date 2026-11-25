import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATALOGUE_VERSION, INSTALLATIONS } from '../../src/lib/architect/catalogue.ts';
import { siteCargo, planToStructures, createPlan, addSite } from '../../src/lib/architect/planner.ts';
import { loadingRequirements, loadingPatternView, parseLoadingPattern, loadingProgress } from '../../src/lib/architect/loadingPatterns.ts';

// Independent snapshot of the pinned Raven source, not generated from the catalogue.
const source = JSON.parse(readFileSync(new URL('./fixtures/raven-primary-port-cargo.json', import.meta.url), 'utf8'));
const find = id => INSTALLATIONS.find(item => item.id === id);
const sum = cargo => Object.values(cargo).reduce((a,b) => a+b,0);
const groups = {
  'orbital-outpost-primary':['plutus','vulcan','dysnomia','vesta','prometheus','nemesis'],
  'coriolis-primary':['no_truss'], 'asteroid-primary':['asteroid'],
  'ocellus-primary':['ocellus'], 'orbis-primary':['apollo'], 'dodec-primary':['dodec'],
};

test('primary recipes match every commodity in the pinned Raven table, not a multiplier',()=>{
 assert.equal(CATALOGUE_VERSION,5);
 for(const [recipe, ids] of Object.entries(groups)) for(const id of ids){
  const item=find(id);
  assert.deepEqual(item.primary.cargo,source.recipes[recipe],id);
  assert.equal(item.primary.approximate,false,id);
  assert.equal(item.primary.sourceUrl,source.source);
  assert.ok(source.typeMap[recipe].includes(id+' (primary)'));
  assert.equal(item.primary.noteParams.tons,sum(source.recipes[recipe]));
 }
 assert.equal(sum(find('nemesis').primary.cargo),21835);
 assert.equal(find('nemesis').primary.cargo.aluminium,500);
 assert.equal(find('nemesis').primary.cargo.battleweapons,undefined);
 assert.equal(find('no_truss').primary.cargo.steel,19436);
 assert.equal(sum(find('dodec').primary.cargo),269924);
});

test('fixed primary recipes reach planner, structures and loading totals; regular recipes stay unchanged',()=>{
 for(const [recipe, ids] of Object.entries(groups)) for(const id of ids){
  const expected=source.recipes[recipe];
  assert.deepEqual(siteCargo({installationId:id,primary:true}).cargo,expected);
  assert.deepEqual(loadingRequirements([{installationId:id,count:2,primary:true}]),Object.fromEntries(Object.entries(expected).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,v*2])));
  const plan=addSite(createPlan('Test'),'Test A',id,{primary:true});
  assert.equal(planToStructures(plan)[0].requiredTons,sum(expected));
  assert.deepEqual(siteCargo({installationId:id,primary:false}).cargo,find(id).cargo);
 }
 assert.equal(sum(find('no_truss').cargo),53723);
 assert.equal(sum(find('nemesis').cargo),10080);
 assert.equal(sum(find('dodec').cargo),236304);
 // No primary planetary-port recipe exists in Raven: keep the legacy estimate
 // explicitly separate rather than relabelling it as a fixed Raven value.
 assert.equal(find('zeus').primary.approximate,true);
 assert.equal(find('zeus').primary.sourceUrl,undefined);
});

const legacy = (id='nemesis') => ({id:'template',owner_id:'owner',author_name:'Pilot',version:1,catalogue_version:4,
 definition:{name:'Old template',visibility:'private',buildings:[{installationId:id,count:1,primary:true}],
 carriers:[{carrierId:'123',name:'Alpha',capacity:60000},{carrierId:'456',name:'Beta',capacity:60000}],
 allocations:{'123':{steel:3500,battleweapons:35,titanium:2800},'456':{steel:0}}}});

test('catalogue v4 templates remain readable: obsolete goods removed, new demand unassigned, no DB mutation',()=>{
 const row=legacy();const before=structuredClone(row);
 const view=loadingPatternView(row,'owner');
 assert.equal(view.catalogueUpdated,true);assert.equal(view.allocationsAdjusted,true);
 assert.deepEqual(view.pattern.allocations['123'],{steel:3500,titanium:2800});
 assert.equal(view.requirements.aluminium,500);assert.equal(view.unassigned.aluminium,500);
 assert.equal(view.total,21835);assert.deepEqual(row,before);
 const progress=loadingProgress(view.pattern,new Map());
 assert.ok(progress.unassigned>0);assert.ok(progress.assigned<=progress.total);assert.equal(progress.complete,false);
 assert.doesNotThrow(()=>parseLoadingPattern(view.pattern));
});

test('lowered primary requirements capped across carriers in order; assignments never moved or increased',()=>{
 const row=legacy('dodec');row.definition.allocations={'123':{cmmcomposite:50000},'456':{cmmcomposite:8000}};
 const view=loadingPatternView(row,'owner');
 assert.equal(view.pattern.allocations['123'].cmmcomposite,50000);
 assert.equal(view.pattern.allocations['456'].cmmcomposite,6635);
 assert.equal(view.requirements.cmmcomposite,56635);
 assert.equal(view.unassigned.steel,74062);
 assert.equal(view.allocationsAdjusted,true);
 row.definition.carriers.reverse();
 const reverse=loadingPatternView(row,'owner');
 assert.equal(reverse.pattern.allocations['456'].cmmcomposite,8000);
 assert.equal(reverse.pattern.allocations['123'].cmmcomposite,48635);
});

test('reconciliation is read-only and limited to older catalogue rows; new writes remain strict',()=>{
 const row=legacy();
 assert.throws(()=>parseLoadingPattern(row.definition));
 assert.throws(()=>parseLoadingPattern({...row.definition,catalogue_version:4}));
 for(const version of [5,6,undefined,0]){
  assert.throws(()=>loadingPatternView({...row,catalogue_version:version},'owner'));
 }
 row.definition.allocations['123'].steel=-1;
 assert.throws(()=>loadingPatternView(row,'owner'));
 row.definition.allocations['123']={steel:60000,titanium:60000};
 assert.throws(()=>loadingPatternView(row,'owner'));
});
