import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { I18N_CONTEXT_STUB } from './helpers/i18nStub.mjs';
const entry=await bundleFile({entrySource:`export {default as Correction} from '@/components/Carriers/BankCorrection';export {default as Bank} from '@/components/Carriers/SquadronBankPanel';export {CarrierCardPage as Card} from '@/components/Carriers/CarrierCardPage';`,external:['react','react-dom','react-dom/client'],stubs:{
 '@/lib/i18n/I18nContext':I18N_CONTEXT_STUB,
 'next/link':`import React from 'react';export default function Link({href,children}){return <a href={href}>{children}</a>}`,
 '@/lib/supabaseClient':`export const authFetch=(...args)=>globalThis.fetch(...args);const listeners=new Set();export const supabase={auth:{onAuthStateChange(callback){listeners.add(callback);globalThis.__correctionAuth=event=>{for(const cb of [...listeners])cb(event)};return {data:{subscription:{unsubscribe(){listeners.delete(callback)}}}}}}};`,
}});
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}};
const carrier={carrierId:'3713477376',callsign:'DNHG',name:'Brewers Port',type:'SquadronCarrier',relation:'squadron',cargo:{items:[{commodity:'steel',name:'Сталь',quantity:13334}],trackedTotal:13334,updatedAt:null}};
async function render({parent=false,card=false,allowed=true,api}={}){
 const {JSDOM}=await import('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://example.test',pretendToBeVisual:true});
 const keys=['window','document','navigator','HTMLElement','Element','Node','IS_REACT_ACT_ENVIRONMENT','fetch','setInterval','clearInterval','__correctionAuth'];
 const previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const key of ['window','document','navigator','HTMLElement','Element','Node'])Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='window'?dom.window:dom.window[key]});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const state={allowed,calls:[],corrected:0,api,intervals:new Map(),history:[],bankCalls:0,bankView:carrier};let timer=0;
 globalThis.setInterval=(callback,ms)=>{state.intervals.set(++timer,{callback,ms});return timer};globalThis.clearInterval=id=>state.intervals.delete(id);
 globalThis.fetch=async(url,init={})=>{
  state.calls.push({url:String(url),init});
  if(state.api){const result=state.api(String(url),init);if(result)return result}
  if(String(url).endsWith('/card'))return response({ok:true,card:{id:carrier.carrierId,name:carrier.name,callsign:carrier.callsign,type:'SquadronCarrier',relation:'squadron',services:[],location:{system:'Sol',body:null,position:null,at:null,source:'site'},owner:{name:null,hidden:true},squadron:{id:7,name:'Squadron',tag:'DNHG',member:true},stats:{total:0,last7:0,last30:0,perWeek:0,site:0,eddn:0,uniqueDestinations:0,top:[],daily:[],monthly:[]},jumps:[],warnings:[]}});
  if(String(url)==='/api/carriers/'+carrier.carrierId)return response({ok:true,carrier:state.bankView});
  if(String(url).endsWith('/bank')){state.bankCalls++;return response({ok:true,carriers:[state.bankView]})}
  if(init.method==='POST')return response({ok:true,id:1});
  return response({ok:true,canCorrect:state.allowed,serverNow:'2026-03-10T11:00:00.000Z',history:state.history});
 };
 const React=await import('react');const {createRoot}=await import('react-dom/client');const {Correction,Bank,Card}=await import(entry);const root=createRoot(document.getElementById('root'));
 const flush=()=>React.act(async()=>{await new Promise(resolve=>setTimeout(resolve,5))});
 const draw=async(id=carrier.carrierId)=>{await React.act(async()=>root.render(React.createElement(parent?Bank:card?Card:Correction,parent?{squadronId:7}:card?{carrierId:id}:{key:id,carrierId:id,callsign:'DNHG',onCorrected(){state.corrected++}})));await flush()};
 await draw();
 const button=pattern=>[...document.querySelectorAll('button')].find(button=>pattern.test(button.textContent));
 const click=async element=>{assert.ok(element);await React.act(async()=>element.click());await flush()};
 const set=async(element,value)=>{assert.ok(element);await React.act(async()=>{
  const kind=element.tagName==='SELECT'?'HTMLSelectElement':element.tagName==='TEXTAREA'?'HTMLTextAreaElement':'HTMLInputElement';
  Object.getOwnPropertyDescriptor(dom.window[kind].prototype,'value').set.call(element,value);
  element.dispatchEvent(new dom.window.Event(kind==='HTMLSelectElement'?'change':'input',{bubbles:true}));
 });await flush()};
 const label=pattern=>[...document.querySelectorAll('label')].find(label=>pattern.test(label.textContent))?.querySelector('input,textarea');
 const complete=()=>click(document.querySelector('input[type=checkbox]'));
 const open=()=>click(button(/^Корректировать банк$/));
 const add=async(commodity,qty)=>{await click(button(/^Добавить товар$/));const rows=document.querySelectorAll('.bank-correction-row');const row=rows[rows.length-1];await set(row.querySelector('select'),commodity);await set(row.querySelector('input'),String(qty))};
 const fill=async()=>{await open();await click(button(/Проверено сейчас/));await add('tritium',1034);await add('thargoidtitandrivecomponent',4);await add('drones',2);await set(label(/Причина сверки/),'Проверено по полному банку в игре');await set(label(/Введите позывной/),'DNHG');await complete()};
 return {state,flush,draw,click,button,set,label,open,add,fill,complete,act:React.act,text:()=>document.body.textContent,
  async close(){await React.act(async()=>root.unmount());dom.window.close();for(const key of keys){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
 };
}

test('correction button is hidden from ordinary members; officers can enter all three actual goods and must review before saving',async()=>{
 const member=await render({allowed:false});try{assert.equal(member.button(/^Корректировать банк$/),undefined)}finally{await member.close()}
 const ui=await render();try{
  await ui.fill();assert.equal(ui.state.calls.filter(call=>call.init.method==='POST').length,0);
  await ui.click(ui.button(/^Проверить изменения$/));assert.match(ui.text(),/1040|1.040|1\s040/);assert.match(ui.text(),/Все остальные товары/);
  await ui.click(ui.button(/^Подтвердить замену остатка$/));
  const posts=ui.state.calls.filter(call=>call.init.method==='POST');assert.equal(posts.length,1);const body=JSON.parse(posts[0].init.body);
  assert.equal(body.observedAt,'2026-03-10T11:00:00.000Z');assert.equal(body.confirmComplete,true);assert.equal(body.callsign,'DNHG');
  assert.deepEqual(body.items.map(({commodity,qty})=>({commodity,qty})),[{commodity:'tritium',qty:1034},{commodity:'thargoidtitandrivecomponent',qty:4},{commodity:'drones',qty:2}]);
  assert.match(ui.text(),/Корректировка сохранена/);assert.equal(ui.state.corrected,1);assert.equal(document.querySelector('.bank-correction-form'),null);
 }finally{await ui.close()}
});
test('full-inventory checkbox, typed callsign, reason, time and valid quantities are required; empty bank has an explicit preview warning',async()=>{
 const ui=await render();try{
  await ui.open();await ui.click(ui.button(/^Проверить изменения$/));assert.match(ui.text(),/Проверьте товары/);assert.equal(ui.button(/^Подтвердить замену остатка$/),undefined);
  await ui.click(ui.button(/Проверено сейчас/));await ui.set(ui.label(/Причина сверки/),'Полностью пустой банк в игре');await ui.set(ui.label(/Введите позывной/),'WRONG');await ui.complete();
  await ui.click(ui.button(/^Проверить изменения$/));assert.equal(ui.button(/^Подтвердить замену остатка$/),undefined);
  await ui.set(ui.label(/Введите позывной/),'DNHG');await ui.click(ui.button(/^Проверить изменения$/));assert.match(ui.text(),/Весь банк будет отмечен пустым/);
  await ui.click(ui.button(/^Назад к редактированию$/));await ui.add('steel','1.5');await ui.click(ui.button(/^Проверить изменения$/));assert.equal(ui.button(/^Подтвердить замену остатка$/),undefined);
  assert.equal(ui.state.calls.filter(call=>call.init.method==='POST').length,0);
 }finally{await ui.close()}
});
test('network errors preserve review/draft and prevent double submit; conflict can be edited without losing the form',async()=>{
 const ui=await render();try{
  await ui.fill();await ui.click(ui.button(/^Проверить изменения$/));const pending=deferred();ui.state.api=(_url,init)=>init.method==='POST'?pending.promise:null;
  await ui.click(ui.button(/^Подтвердить замену остатка$/));assert.equal(ui.button(/^Сохранение/).disabled,true);await ui.click(ui.button(/^Сохранение/));assert.equal(ui.state.calls.filter(call=>call.init.method==='POST').length,1);
  await ui.act(async()=>pending.resolve(response({error:'Есть более новый снимок'},409)));await ui.flush();assert.match(ui.text(),/Есть более новый снимок/);assert.match(ui.text(),/1034|1.034|1\s034/);
  await ui.click(ui.button(/^Назад к редактированию$/));assert.equal(document.querySelectorAll('.bank-correction-row').length,3);assert.equal(ui.label(/Введите позывной/).value,'DNHG');assert.match(ui.label(/Причина сверки/).value,/Проверено/);
 }finally{await ui.close()}
});
test('sign-out clears private audit and pending correction responses cannot restore success or history',async()=>{
 const ui=await render();try{
  await ui.fill();await ui.click(ui.button(/^Проверить изменения$/));const pending=deferred();ui.state.api=(_url,init)=>init.method==='POST'?pending.promise:null;
  await ui.click(ui.button(/^Подтвердить замену остатка$/));await ui.act(async()=>globalThis.__correctionAuth('SIGNED_OUT'));await ui.flush();assert.equal(ui.button(/^Корректировать банк$/),undefined);assert.doesNotMatch(ui.text(),/Проверено по полному/);
  await ui.act(async()=>pending.resolve(response({ok:true,id:9})));await ui.flush();assert.doesNotMatch(ui.text(),/Корректировка сохранена/);assert.equal(ui.state.corrected,0);
 }finally{await ui.close()}
});
test('audit renders human author/reason and observed time; permission revocation on submit closes the editor',async()=>{
 const ui=await render();try{
  ui.state.history=[{id:1,observedAt:'2026-03-10T10:00:00Z',recordedAt:'2026-03-10T11:00:00Z',total:1040,author:'Officer Test',reason:'Reason in audit'}];
  await ui.open();await ui.click(ui.button(/Проверено сейчас/));assert.match(ui.text(),/Officer Test/);assert.match(ui.text(),/Reason in audit/);
  await ui.click(ui.button(/^Отмена$/));await ui.fill();await ui.click(ui.button(/^Проверить изменения$/));ui.state.api=(_url,init)=>init.method==='POST'?response({error:'Нет прав'},403):null;
  await ui.click(ui.button(/^Подтвердить замену остатка$/));assert.equal(document.querySelector('.bank-correction-form'),null);assert.doesNotMatch(ui.text(),/Officer Test|Reason in audit/);assert.match(ui.text(),/Нет прав/);
 }finally{await ui.close()}
});
test('squadron tab mounts the correction mechanism and background bank polling does not discard an active draft',async()=>{
 const ui=await render({parent:true});try{
  assert.match(ui.text(),/Brewers Port/);await ui.fill();
  const interval=[...ui.state.intervals.values()].find(timer=>timer.ms===60000);assert.ok(interval);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await ui.act(async()=>interval.callback());await ui.flush();
  assert.equal(document.querySelectorAll('.bank-correction-row').length,3);assert.match(ui.label(/Причина сверки/).value,/Проверено/);assert.equal(ui.state.bankCalls,2);
  ui.state.api=(_url,init)=>{if(init.method!=='POST')return null;ui.state.bankView={...carrier,cargo:{...carrier.cargo,items:[{commodity:'tritium',name:'Тритий',quantity:1040}],trackedTotal:1040,baselineSource:'BankReconciliation',baselineAt:'2026-03-10T11:00:00Z'}};return response({ok:true,id:1})};
  await ui.click(ui.button(/^Проверить изменения$/));await ui.click(ui.button(/^Подтвердить замену остатка$/));assert.equal(ui.state.bankCalls,3);
  assert.match(document.querySelector('[data-testid=squadron-bank]').textContent,/Тритий/);assert.doesNotMatch(document.querySelector('[data-testid=squadron-bank]').textContent,/Сталь/);
  assert.match(ui.text(),/Полный остаток сверялся вручную/);
 }finally{await ui.close()}
});
test('late permission/history response from another carrier cannot reveal data in a newly selected carrier',async()=>{
 const pending=deferred();const ui=await render({api:url=>url.includes('/3713477376/')?pending.promise:null});try{
  await ui.draw('3713477999');assert.ok(ui.button(/^Корректировать банк$/));
  await ui.act(async()=>pending.resolve(response({ok:true,canCorrect:true,history:[{id:1,reason:'Old private reason',author:'Old Officer',observedAt:'2026-03-01T00:00:00Z',recordedAt:'2026-03-01T00:00:00Z',total:999}]})));await ui.flush();
  assert.doesNotMatch(ui.text(),/Old private reason|Old Officer/);
 }finally{await ui.close()}
});

test('carrier detail card also exposes the officer correction editor, preserving the draft across its periodic refresh',async()=>{
 const ui=await render({card:true});try{
  assert.match(ui.text(),/Brewers Port/);assert.ok(ui.button(/^Корректировать банк$/));await ui.fill();
  const timer=[...ui.state.intervals.values()].find(timer=>timer.ms===120000);assert.ok(timer);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await ui.act(async()=>timer.callback());await ui.flush();
  assert.equal(document.querySelectorAll('.bank-correction-row').length,3);assert.equal(ui.label(/Введите позывной/).value,'DNHG');
  assert.ok(ui.state.calls.some(call=>call.url==='/api/carriers/3713477376/bank/correction'));
 }finally{await ui.close()}
});
