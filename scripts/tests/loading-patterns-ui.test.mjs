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
