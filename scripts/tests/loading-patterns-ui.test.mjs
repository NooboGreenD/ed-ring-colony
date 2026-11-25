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
