import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INSTALLATIONS } from '../../src/lib/architect/catalogue.ts';
import { loadingCategories, loadingGoodCategory, loadingGoodColor, loadingCategoryName, orderLoadingGoods } from '../../src/lib/architect/loadingGoods.ts';
const metadata=JSON.parse(fs.readFileSync(new URL('../../uploader/loading_goods.json',import.meta.url)));
const market=JSON.parse(fs.readFileSync(new URL('../../src/lib/stationSearchItems.json',import.meta.url)));
test('loading goods: shared metadata covers every catalogue/primary good with market category and unique recipe order',()=>{
 const goods=new Set(INSTALLATIONS.flatMap(i=>[...Object.keys(i.cargo),...Object.keys(i.primary?.cargo??{})]));
 assert.deepEqual(new Set(Object.keys(metadata.goods)),goods);
 assert.equal(new Set(Object.values(metadata.goods).map(i=>i.order)).size,goods.size);
 for(const good of goods){const item=market.commodities.find(i=>i.symbol.toLowerCase()===good);assert.ok(item,good);assert.equal(loadingGoodCategory(good),item.category);assert.match(loadingGoodColor(good),/^#[\da-f]{6}$/i);}
 assert.equal(loadingGoodCategory('futuregood'),'Other');assert.equal(loadingCategoryName('Metals','ru'),'Металлы');assert.equal(loadingCategoryName('Metals','en'),'Metals');
 assert.ok(Object.keys(loadingCategories).length>=7);
});
test('loading goods: name, category, quantity, recipe, unknown-first remaining sorting are display-only',()=>{
 const rows=[{commodity:'water',required:50,remaining:40},{commodity:'steel',required:100,remaining:0},{commodity:'computercomponents',required:10,remaining:null}];
 const before=JSON.stringify(rows);const keys=mode=>orderLoadingGoods(rows,mode,g=>g).map(r=>r.commodity);
 assert.deepEqual(keys('category'),['steel','computercomponents','water']);
 assert.deepEqual(keys('quantity'),['steel','water','computercomponents']);
 assert.deepEqual(keys('name'),['computercomponents','steel','water']);
 assert.deepEqual(keys('recipe'),['computercomponents','steel','water']);
 assert.deepEqual(keys('remaining'),['computercomponents','water','steel']);
 assert.equal(JSON.stringify(rows),before);
 assert.deepEqual(orderLoadingGoods([{commodity:'unknown',required:1},{commodity:'steel',required:1}],'recipe',g=>g).map(r=>r.commodity),['steel','unknown']);
});
