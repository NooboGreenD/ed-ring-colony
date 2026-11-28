import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { I18N_CONTEXT_STUB } from './helpers/i18nStub.mjs';
import { INSTALLATIONS } from '../../src/lib/architect/catalogue.ts';
import { parseLoadingPattern } from '../../src/lib/architect/loadingPatterns.ts';
const id='11111111-2222-4333-8444-555555555555';
const definition=()=>parseLoadingPattern({name:'Test load',visibility:'private',buildings:[{installationId:INSTALLATIONS[0].id,count:1,primary:false}],carriers:[{carrierId:'123',name:'Alpha',capacity:25000}]});
const view=(canEdit=true)=>({id,version:1,canEdit,author:'Owner',updatedAt:'2026-11-23T12:00:00Z',pattern:definition(),requirements:{},total:100,unassigned:{}});
async function harness(options={}){
 const {JSDOM}=await import('jsdom');
 const bundle=await bundleFile({entry:'src/components/Architect/LoadingPatternsWorkspace.tsx',stubs:{
  '@/lib/i18n/I18nContext':I18N_CONTEXT_STUB,
  '@/lib/supabaseClient':`export const authFetch=(...args)=>globalThis.__lpFetch(...args);export const supabase={auth:{onAuthStateChange:(fn)=>{globalThis.__lpAuth=fn;fn('INITIAL_SESSION',{user:{id:'owner'}});return {data:{subscription:{unsubscribe(){}}}}}}};`,
  'next/link':`import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}`,
 },external:['react','react-dom','react-dom/client']});
 const calls=[];
 globalThis.__lpFetch=async(url,init)=>{
  calls.push({url,init});const custom=await options.api?.(url,init);if(custom)return{ok:(custom.status??200)<400,status:custom.status??200,json:async()=>custom.body};
  const body=url.includes('?scope=')?{ok:true,patterns:[view(options.canEdit??true)]}:{ok:true,pattern:view(options.canEdit??true),progress:{total:100,loaded:0,unknown:100,carriers:[],unassigned:0},checkedAt:'2026-11-23T12:00:00Z'};
  return{ok:true,json:async()=>body};
 };
 const dom=new JSDOM('<div id="root"></div>',{url:'https://example.test/architect/loading'+(options.link?'?pattern='+id:''),pretendToBeVisual:true});
 const saved={};for(const key of ['window','document','HTMLElement','Node','IS_REACT_ACT_ENVIRONMENT']){saved[key]=globalThis[key];globalThis[key]=key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key];}
 dom.window.confirm=()=>true;
 const React=await import('react');const {createRoot}=await import('react-dom/client');const mod=await import(bundle);const root=createRoot(dom.window.document.getElementById('root'));
 const flush=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,10));});
 await React.act(async()=>root.render(React.createElement(mod.default)));await flush();
 const doc=dom.window.document;
 const button=text=>[...doc.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
 const click=async(el)=>{assert.ok(el);await React.act(async()=>el.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));await flush();};
 return{doc,dom,calls,button,click,flush,act:React.act,async close(){await React.act(async()=>root.unmount());dom.window.close();Object.assign(globalThis,saved);delete globalThis.__lpFetch;delete globalThis.__lpAuth;}};
}
test('loading UI: navigation and compact empty editor, building quantities and primary controls',async()=>{
 const h=await harness();try{
  assert.ok(h.doc.querySelector('a[href="/architect/loading"]'));
  await h.click(h.button('+ Постройка'));
  assert.equal(h.doc.querySelectorAll('select[aria-label="Постройка"]').length,1);
  assert.equal(h.doc.querySelector('input[aria-label="Количество построек"]').value,'1');
  assert.ok(h.doc.querySelector('input[type="checkbox"]'));
 }finally{await h.close();}
});
test('loading UI: public template is read-only, copying enables editing and stays private',async()=>{
 const h=await harness({link:true,canEdit:false});try{
  const name=h.doc.querySelector('input[aria-label="Название паттерна"]');assert.equal(name.disabled,true);
  assert.equal(h.doc.querySelector('input[aria-label="Выделено места"]').disabled,true);
  await h.click(h.button('Копировать себе'));
  assert.equal(h.doc.querySelector('input[aria-label="Название паттерна"]').disabled,false);
  assert.equal(h.doc.querySelector('select[aria-label="Доступ"]').value,'private');
  assert.ok(h.button('Сохранить'));
 }finally{await h.close();}
});
test('loading UI: switching public/mine list and repeated SIGNED_IN never discard draft',async()=>{
 const h=await harness({link:true});try{
  await h.click(h.button('+ Постройка'));
  assert.equal(h.doc.querySelectorAll('select[aria-label="Постройка"]').length,2);
  await h.click(h.button('Публичные'));
  assert.equal(h.doc.querySelectorAll('select[aria-label="Постройка"]').length,2);
  await h.act(async()=>globalThis.__lpAuth('SIGNED_IN',{user:{id:'owner'}}));await h.flush();
  assert.equal(h.doc.querySelectorAll('select[aria-label="Постройка"]').length,2);
  await h.act(async()=>globalThis.__lpAuth('SIGNED_OUT',null));await h.flush();
  assert.equal(h.doc.querySelectorAll('select[aria-label="Постройка"]').length,0);
  assert.equal(h.doc.querySelector('input[aria-label="Название паттерна"]').value,'');
 }finally{await h.close();}
});
test('loading UI: saving uses authenticated PATCH with version and structured targets',async()=>{
 const h=await harness({link:true});try{
  await h.click(h.button('Сохранить'));
  const call=h.calls.find(c=>c.init?.method==='PATCH');assert.ok(call);
  const body=JSON.parse(call.init.body);assert.equal(body.version,1);assert.equal(body.name,'Test load');assert.equal(body.carriers[0].carrierId,'123');assert.ok(body.allocations['123']);
 }finally{await h.close();}
});


test('loading UI: old catalogue warning is explicit without silently saving a template',async()=>{
 const h=await harness({link:true,api:async(url)=>url.endsWith('/'+id)?{body:{ok:true,pattern:{...view(),catalogueUpdated:true,allocationsAdjusted:true},progress:{total:100,loaded:0,unknown:100,carriers:[],unassigned:100}}}:null});
 try{
  const notices=[...h.doc.querySelectorAll('[role="status"]')].map(el=>el.textContent).join(' ');
  assert.match(notices,/Каталог обновлён/);assert.match(notices,/Raven/);
  assert.equal(h.calls.filter(call=>call.init?.method==='PATCH').length,0);
 }finally{await h.close();}
});

const collaboration=(canManage=false,accepted=false)=>({canManage,self:{accepted,sharedCarrierIds:[]},ownCarrierIds:['123'],participants:[{userId:'pilot',name:'Cargo Pilot',accepted,sharedCarrierIds:[]}]});
test('loading team UI: invitation acceptance shares only explicitly selected own carriers, no assignment write',async()=>{
 let accepted=false,sharedCarrierIds=[];
 const h=await harness({link:true,canEdit:false,api:async(url,init)=>{
  if(url.endsWith('/members')) {const body=JSON.parse(init.body);accepted=true;sharedCarrierIds=body.sharedCarrierIds;return{body:{ok:true}};}
  if(url.endsWith('/'+id))return{body:{ok:true,pattern:view(false),collaboration:{...collaboration(false,accepted),self:{accepted,sharedCarrierIds}},progress:{total:100,loaded:5,carriers:[]}}};
 }});
 try {
  assert.match(h.doc.body.textContent,/Вас пригласили/);
  const box=h.doc.querySelector('.lp-team input[type="checkbox"]');assert.ok(box);assert.equal(box.checked,false);
  await h.click(box);await h.click(h.button('Принять приглашение и сохранить доступ'));
  const call=h.calls.find(call=>call.url.endsWith('/members'));
  assert.equal(call.init.method,'PATCH');assert.deepEqual(JSON.parse(call.init.body),{accept:true,sharedCarrierIds:['123']});
  assert.equal(h.calls.filter(call=>call.init?.method==='PATCH'&&!call.url.endsWith('/members')).length,0);
  assert.equal(h.doc.querySelector('input[aria-label="Название паттерна"]').disabled,true);
  assert.ok(h.button('Сохранить доступ к остаткам'));
  await h.click(h.doc.querySelector('.lp-team input[type="checkbox"]'));
  await h.click(h.button('Сохранить доступ к остаткам'));
  const calls=h.calls.filter(call=>call.url.endsWith('/members'));assert.deepEqual(JSON.parse(calls.at(-1).init.body).sharedCarrierIds,[]);
  await h.click(h.button('Копировать себе'));assert.equal(h.doc.querySelector('.lp-team'),null);
 } finally {await h.close();}
});
test('loading team UI: loaders without own carriers accept without exposing any stock; logout clears team',async()=>{
 const h=await harness({link:true,canEdit:false,api:async(url)=>url.endsWith('/'+id)?{body:{ok:true,pattern:view(false),collaboration:{...collaboration(),ownCarrierIds:[]},progress:{total:100,loaded:0,carriers:[]}}}:null});
 try {
  assert.match(h.doc.querySelector('.lp-team').textContent,/нет авианосцев/);
  assert.equal(h.doc.querySelectorAll('.lp-team input[type="checkbox"]').length,0);
  await h.click(h.button('Принять приглашение и сохранить доступ'));
  const call=h.calls.find(call=>call.url.endsWith('/members'));assert.deepEqual(JSON.parse(call.init.body),{accept:true,sharedCarrierIds:[]});
  await h.act(async()=>globalThis.__lpAuth('SIGNED_OUT',null));await h.flush();
  assert.equal(h.doc.querySelector('.lp-team'),null);
 } finally {await h.close();}
});
test('loading team UI: membership actions disabled while editing unsaved assignments',async()=>{
 const h=await harness({link:true,api:async(url)=>url.endsWith('/'+id)?{body:{ok:true,pattern:view(),collaboration:collaboration(true,true),progress:{total:100,loaded:0,carriers:[]}}}:null});
 try {
  assert.ok(h.button('Пригласить пилота'));await h.click(h.button('+ Постройка'));
  assert.equal(h.doc.querySelector('.lp-team fieldset').disabled,true);
  assert.equal(h.doc.querySelector('.lp-team input[aria-label="Точное имя CMDR"]').disabled,true);
  assert.equal(h.button('Убрать участника').disabled,true);
 } finally {await h.close();}
});

async function changeSelect(h, selector, value) {
 const element=h.doc.querySelector(selector);assert.ok(element,selector);
 await h.act(async()=>{element.value=value;element.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));});
 await h.flush();
}
test('loading UI: read-only category/name filters group rows without modifying targets, totals or save state',async()=>{
 const h=await harness({link:true,canEdit:false});try{
  const rows=()=>[...h.doc.querySelectorAll('tbody tr')].filter(row=>row.querySelector('td.lp-good-name'));
  const initialCount=rows().length;const metrics=h.doc.querySelector('.lp-metrics').textContent;
  const inputValues=()=>[...h.doc.querySelectorAll('tbody input')].map(el=>[el.getAttribute('aria-label'),el.value]);
  const before=inputValues();
  await changeSelect(h,'select[aria-label="Группировка и порядок"]','category');
  assert.ok(h.doc.querySelector('.lp-category-heading'));assert.equal(rows().length,initialCount);
  assert.deepEqual(inputValues().sort(),before.sort());
  await changeSelect(h,'select[aria-label="Категория"]','Metals');
  assert.ok(rows().length<initialCount);assert.ok(rows().length>0);
  assert.ok(rows().every(row=>row.firstChild.title==='Металлы'));
  assert.equal(h.doc.querySelector('.lp-metrics').textContent,metrics);
  await changeSelect(h,'select[aria-label="Категория"]','');
  await changeSelect(h,'select[aria-label="Группировка и порядок"]','name');
  assert.equal(h.doc.querySelector('.lp-category-heading'),null);assert.equal(rows().length,initialCount);
  assert.equal(h.calls.filter(c=>c.init?.method==='PATCH').length,0);
  assert.ok(!h.doc.body.textContent.includes('Есть несохранённые изменения'));
  assert.equal(h.doc.querySelector('select[aria-label="Alpha: Лимит целых комплектов"]').disabled,true);
 }finally{await h.close();}
});

test('loading UI: whole-recipe method is explicit, saves carrier limits and ignores display filters',async()=>{
 const h=await harness({link:true});try{
  await changeSelect(h,'select[aria-label="Alpha: Лимит целых комплектов"]','2');
  await changeSelect(h,'select[aria-label="Способ распределения"]','kits');
  assert.match(h.doc.body.textContent,/только целиком/);
  await changeSelect(h,'select[aria-label="Категория"]','Metals');
  await h.click(h.button('Распределить автоматически'));
  await h.click(h.button('Сохранить'));
  const call=h.calls.find(c=>c.init?.method==='PATCH');assert.ok(call);
  const body=JSON.parse(call.init.body);assert.equal(body.carriers[0].recipeLimit,2);
  // The selected starport recipe exceeds 25kt: do not split or allocate just
  // the visible metals. It remains completely unassigned.
  assert.deepEqual(body.allocations['123'],{});
  assert.equal(body.version,1);
 }finally{await h.close();}
});

test('loading UI: progress filters keep unknown rows and overall progress unchanged',async()=>{
 const progress={total:10,loaded:5,unknown:3,unassigned:0,carriers:[{carrierId:'123',name:'Alpha',known:false,loaded:5,target:10,items:[{commodity:'steel',required:5,loaded:5,remaining:0},{commodity:'water',required:3,loaded:null,remaining:null},{commodity:'titanium',required:2,loaded:0,remaining:2}]}]};
 const h=await harness({link:true,api:async(url)=>url.endsWith('/'+id)?{body:{ok:true,pattern:view(),progress}}:null});try{
  const card=()=>h.doc.querySelector('.lp-progress-grid details');
  assert.equal(card().querySelectorAll('.lp-progress-item').length,3);
  const bar=h.doc.querySelector('progress');assert.equal(bar.value,5);assert.equal(bar.max,10);
  const completed=h.doc.querySelector('.lp-view-checks input[type="checkbox"]');await h.click(completed);
  assert.equal(card().querySelectorAll('.lp-progress-item').length,2);
  assert.match(card().textContent,/\?/);
  await changeSelect(h,'select[aria-label="Группировка и порядок"]','remaining');
  assert.match(card().querySelector('.lp-progress-item').textContent,/Вода/);
  assert.equal(h.doc.querySelector('progress').value,5);assert.equal(h.doc.querySelector('progress').max,10);
  assert.equal(h.button('Сохранить').disabled,false); // display changes do not dirty the draft
  assert.ok(!h.doc.body.textContent.includes('Есть несохранённые изменения'));
 }finally{await h.close();}
});

test('loading UI: visible goods alternate dark/light independently of category headings and filtering',async()=>{
 const progress={total:10,loaded:5,unknown:3,unassigned:0,carriers:[{carrierId:'123',name:'Alpha',known:false,loaded:5,target:10,items:[{commodity:'steel',required:5,loaded:5,remaining:0},{commodity:'water',required:3,loaded:null,remaining:null},{commodity:'titanium',required:2,loaded:0,remaining:2}]}]};
 const h=await harness({link:true,api:async(url)=>url.endsWith('/'+id)?{body:{ok:true,pattern:view(),progress}}:null});try{
  const check=()=>{
   for(const selector of ['.lp-table tbody .lp-good-row','.lp-progress-grid .lp-progress-item']){
    const rows=[...h.doc.querySelectorAll(selector)];assert.ok(rows.length>1,selector);
    rows.forEach((row,index)=>assert.ok(row.classList.contains(`lp-good-row--${index%2?'light':'dark'}`),selector+': '+index));
   }
   assert.ok([...h.doc.querySelectorAll('.lp-category-heading')].every(row=>!row.className.includes('lp-good-row--')));
  };
  check();
  await changeSelect(h,'select[aria-label="Группировка и порядок"]','category');
  assert.ok(h.doc.querySelector('.lp-category-heading'));check();
  await changeSelect(h,'select[aria-label="Категория"]','Metals');check();
  await h.click(h.doc.querySelector('.lp-view-checks input[type="checkbox"]'));
  assert.equal(h.doc.querySelector('.lp-progress-item').classList.contains('lp-good-row--dark'),true);
  assert.equal(h.calls.filter(c=>c.init?.method==='PATCH').length,0);
 }finally{await h.close();}
});

async function changeNumber(h, selector, value) {
 const input=h.doc.querySelector(selector);assert.ok(input,selector);
 const setter=Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype,'value').set;
 await h.act(async()=>{setter.call(input,String(value));input.dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));});
 await h.flush();
}
const extraFixture=(capacity=100)=>({...view(),pattern:{...definition(),carriers:[{carrierId:'123',name:'Alpha',capacity}],allocations:{'123':{steel:2,computercomponents:1,water:0}}}});
test('loading UI: one-shot extras include hidden positive cells, skip zeros, save metadata and re-auto clears reserve',async()=>{
 const fixture=extraFixture();
 const h=await harness({link:true,api:async(url,init)=>url.endsWith('/'+id)&&!init?.method?{body:{ok:true,pattern:fixture}}:null});try{
  await changeSelect(h,'select[aria-label="Категория"]','Metals');
  await h.click(h.button('Добавить +1 т к заполненным ячейкам'));
  assert.equal(h.doc.querySelector('input[aria-label="Alpha: Сталь"]').value,'3');
  assert.match(h.doc.body.textContent,/всего \+2 т/);
  assert.match(h.doc.body.textContent,/Есть несохранённые изменения/);
  assert.equal(h.doc.querySelectorAll('.lp-warning[role="alert"]').length,0);
  await changeSelect(h,'select[aria-label="Категория"]','');
  assert.equal(h.doc.querySelector('input[aria-label="Alpha: Компьютерные компоненты"]').value,'2');
  assert.equal(h.doc.querySelector('input[aria-label="Alpha: Вода"]').value,'0');
  await changeNumber(h,'input[aria-label="Запас на каждую заполненную ячейку, т"]',2);
  await h.click(h.button('Добавить +2 т к заполненным ячейкам'));
  assert.equal(h.doc.querySelector('input[aria-label="Alpha: Сталь"]').value,'5');
  await h.click(h.button('Сохранить'));
  const call=h.calls.find(c=>c.init?.method==='PATCH');assert.ok(call);
  const saved=JSON.parse(call.init.body);
  assert.deepEqual(saved.extras,{'123':{steel:3,computercomponents:3}});
  assert.deepEqual(saved.allocations,{'123':{steel:5,computercomponents:4}});
  assert.doesNotThrow(()=>parseLoadingPattern(saved));
  // The test server returns the initial pattern after save. Add reserve again
  // and verify the real auto action explicitly removes it, then clear all.
  await h.click(h.button('Добавить +2 т к заполненным ячейкам'));
  assert.ok(h.doc.querySelector('.lp-cell-extra'));
  await h.click(h.button('Распределить автоматически'));
  assert.equal(h.doc.querySelector('.lp-cell-extra'),null);
  await h.click(h.button('Очистить распределение'));
  assert.equal(h.button('Добавить +2 т к заполненным ячейкам').disabled,true);
 }finally{await h.close();}
});

test('loading UI: capacity error changes no assignments and does not dirty a saved pattern; read-only has no extra button',async()=>{
 const fixture=extraFixture(3);
 const h=await harness({link:true,api:async(url)=>url.endsWith('/'+id)?{body:{ok:true,pattern:fixture}}:null});try{
  await h.click(h.button('Добавить +1 т к заполненным ячейкам'));
  const alert=h.doc.querySelector('[role="alert"]');assert.ok(alert);
  assert.match(alert.textContent,/Alpha.*нужно 2 т.*свободно 0 т.*не хватает 2 т/);
  assert.equal(h.doc.querySelector('input[aria-label="Alpha: Сталь"]').value,'2');
  assert.equal(h.doc.querySelector('.lp-cell-extra'),null);
  assert.ok(!h.doc.body.textContent.includes('Есть несохранённые изменения'));
  assert.equal(h.calls.filter(c=>c.init?.method==='PATCH').length,0);
 }finally{await h.close();}
 const readonly=await harness({link:true,canEdit:false});try{
  assert.equal(readonly.doc.querySelector('.lp-extra-controls'),null);
 }finally{await readonly.close();}
});

test('loading UI: reserve requires positive whole tonnes and at least one non-zero assignment',async()=>{
 const h=await harness({link:true,api:async(url)=>url.endsWith('/'+id)?{body:{ok:true,pattern:extraFixture()}}:null});try{
  for(const value of [0,-1,1.5,60001,'']){
   await changeNumber(h,'input[aria-label="Запас на каждую заполненную ячейку, т"]',value);
   assert.equal(h.doc.querySelector('.lp-extra-controls button').disabled,true);
  }
  await changeNumber(h,'input[aria-label="Запас на каждую заполненную ячейку, т"]',1);
  assert.equal(h.doc.querySelector('.lp-extra-controls button').disabled,false);
  await h.click(h.button('Очистить распределение'));
  assert.equal(h.doc.querySelector('.lp-extra-controls button').disabled,true);
 }finally{await h.close();}
});
