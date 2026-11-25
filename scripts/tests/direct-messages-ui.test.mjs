import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { I18N_CONTEXT_STUB } from './helpers/i18nStub.mjs';
const entry=await bundleFile({entrySource:`export {default} from '@/components/DirectConversation';`,external:['react','react-dom','react-dom/client'],stubs:{
  '@/lib/i18n/I18nContext':I18N_CONTEXT_STUB,
  'next/link':`import React from 'react';export default function Link({href,children}){return <a href={href}>{children}</a>}`,
  '@/components/Cosmetics/PilotIdentity':`export default function Identity({cmdrName}){return <span>{cmdrName}</span>}`,
  '@/lib/supabaseClient':`export const authFetch=(...args)=>globalThis.fetch(...args);export const supabase={from:()=>globalThis.__dmQuery(),channel:()=>({on(event,filter,callback){globalThis.__dmRealtime=callback;return this},subscribe(){return this}}),removeChannel:async()=>{}};`,
}});
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222', C='33333333-3333-4333-8333-333333333333';
const row=(id,content,sender_id=A,recipient_id=B)=>({id,content,sender_id,recipient_id,author_name:'Pilot',created_at:`2026-11-25T10:00:${String(id).padStart(2,'0')}Z`,attachments:[]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
async function render(){
 const {JSDOM}=await import('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://example.test',pretendToBeVisual:true});
 const keys=['window','document','navigator','HTMLElement','Element','Node','IS_REACT_ACT_ENVIRONMENT','fetch','setInterval','clearInterval','requestAnimationFrame','__dmQuery','__dmRealtime'];
 const previous=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of ['window','document','navigator','HTMLElement','Element','Node'])Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='window'?dom.window:dom.window[key]});
 globalThis.requestAnimationFrame=callback=>callback();globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const state={rows:[],poll:null,api:null,calls:[],intervals:new Map(),orders:[],queryResult:null};let timer=0;
 globalThis.setInterval=(callback,ms)=>{state.intervals.set(++timer,{callback,ms});return timer};globalThis.clearInterval=id=>state.intervals.delete(id);
 globalThis.__dmQuery=()=>{let update=false;return {select(){return this},or(){return this},order(k,v){state.orders.push([k,v]);return this},limit(){return this},update(){update=true;return this},eq(){return this},is(){return this},then(resolve,reject){return (update?Promise.resolve({error:null}):state.queryResult??Promise.resolve({data:state.rows,error:null})).then(resolve,reject)}}};
 globalThis.fetch=async(url,init)=>{state.calls.push({url,init});return state.api?state.api(url,init):{ok:true,json:async()=>({message:row(1,init.body.get('content'))})}};
 const React=await import('react');const {createRoot}=await import('react-dom/client');const Chat=(await import(entry)).default;const root=createRoot(document.getElementById('root'));
 const flush=()=>React.act(async()=>{await new Promise(resolve=>setTimeout(resolve,0))});
 const draw=async(peer=B)=>{await React.act(async()=>root.render(React.createElement(Chat,{key:peer,userId:A,peerId:peer,peerName:peer===B?'Friend':'Other',myName:'Me',myAvatar:null,onUnreadReset(){}})));await flush()};
 await draw();
 const type=async(text)=>{await React.act(async()=>{const textarea=document.querySelector('textarea');Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(textarea,text);textarea.dispatchEvent(new dom.window.Event('input',{bubbles:true}))});await flush()};
 const click=async(button)=>{assert.ok(button);await React.act(async()=>button.click());await flush()};
 const send=()=>click(document.querySelector('.dm-input button'));
 return {state,draw,flush,type,click,send,act:React.act,text:()=>document.body.textContent,
 async realtime(message){await React.act(async()=>globalThis.__dmRealtime({new:message}));await flush()},
 async poll(){await React.act(async()=>{await [...state.intervals.values()][0].callback()});await flush()},
 async close(){await React.act(async()=>root.unmount());dom.window.close();for(const k of keys){const d=previous.get(k);if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k]}}
 };
}
test('sent row appears with Realtime disconnected; incoming duplicates are merged; latest-first bounded query',async()=>{
 const ui=await render();try{
  assert.deepEqual(ui.state.orders.slice(0,2),[['created_at',{ascending:false}],['id',{ascending:false}]]);
  await ui.type('hello without realtime');await ui.send();assert.match(ui.text(),/hello without realtime/);assert.equal(document.querySelector('textarea').value,'');
  await ui.realtime(row('1','hello without realtime'));assert.equal(document.querySelectorAll('.dm-message').length,1);
  await ui.realtime(row(2,'incoming',B,A));assert.match(ui.text(),/incoming/);
  await ui.realtime(row(3,'unrelated',B,C));assert.doesNotMatch(ui.text(),/unrelated/);
  ui.state.rows=[row(1,'hello without realtime'),row(2,'incoming',B,A),row(4,'poll fallback',B,A)];await ui.poll();assert.match(ui.text(),/poll fallback/);
  assert.equal([...ui.state.intervals.values()][0].ms,10000);
 }finally{await ui.close()}
});
test('failed send preserves draft; pending double send blocked; old peer response never enters new chat',async()=>{
 const ui=await render();try{
  ui.state.api=async()=>({ok:false,json:async()=>({error:'Send failed'})});await ui.type('keep this draft');await ui.send();assert.equal(document.querySelector('textarea').value,'keep this draft');assert.match(ui.text(),/Send failed/);
  const pending=deferred();ui.state.api=()=>pending.promise;
  await ui.send();assert.equal(document.querySelector('.dm-input button').disabled,true);await ui.send();assert.equal(ui.state.calls.length,2);
  await ui.draw(C);await ui.act(async()=>pending.resolve({ok:true,json:async()=>({message:row(1,'old peer message')})}));await ui.flush();assert.doesNotMatch(ui.text(),/old peer message/);
 }finally{await ui.close()}
});
test('toolbar wraps selection, emoji inserts, Shift+Enter does not send, Markdown is safe',async()=>{
 const ui=await render();try{
  await ui.type('bold');const textarea=document.querySelector('textarea');textarea.setSelectionRange(0,4);await ui.click(document.querySelector('[title="Жирный"]'));assert.equal(textarea.value,'**bold**');
  await ui.click(document.querySelector('[aria-label="Эмодзи"]'));await ui.click([...document.querySelectorAll('button')].find(button=>button.textContent==='🚀'));assert.match(textarea.value,/🚀/);
  await ui.act(async()=>textarea.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true})));assert.equal(ui.state.calls.length,0);
  await ui.realtime(row(1,'**safe bold** <script>alert(1)</script>\n![remote](https://evil.test/track)\n[bad](javascript:alert(1))'));
  assert.equal(document.querySelector('.dm-markdown strong').textContent,'safe bold');assert.equal(document.querySelectorAll('.dm-markdown script,.dm-markdown img').length,0);
  assert.equal(document.querySelectorAll('a[href^="javascript:"]').length,0);
 }finally{await ui.close()}
});
test('late snapshot cannot overwrite a newly sent row; failed delete retains message',async()=>{
 const ui=await render();try{
  const pending=deferred();ui.state.queryResult=pending.promise;
  await ui.poll();await ui.type('live');await ui.send();assert.match(ui.text(),/live/);
  await ui.act(async()=>pending.resolve({data:[],error:null}));await ui.flush();assert.match(ui.text(),/live/);
  ui.state.api=async()=>({ok:false});await ui.click(document.querySelector('.dm-meta button'));assert.match(ui.text(),/live/);assert.match(ui.text(),/Не удалось удалить/);
 }finally{await ui.close()}
});

test('attachments can be selected and removed; failed sends retain selection and success clears it',async()=>{
 const ui=await render();try{
  const picker=document.querySelector('input[type=file]');
  const choose=async files=>{Object.defineProperty(picker,'files',{configurable:true,value:files});await ui.act(async()=>picker.dispatchEvent(new window.Event('change',{bubbles:true})));await ui.flush()};
  await choose([new File(['a'],'notes.txt')]);assert.match(document.querySelector('.dm-files').textContent,/notes.txt/);
  ui.state.api=async()=>({ok:false,json:async()=>({error:'Offline'})});await ui.send();assert.match(document.querySelector('.dm-files').textContent,/notes.txt/);
  const body=ui.state.calls[0].init.body;assert.equal(body.getAll('files').length,1);assert.equal(body.get('peerId'),B);
  await ui.click(document.querySelector('.dm-files button'));assert.equal(document.querySelector('.dm-files'),null);
  await choose([new File(['<svg/>'],'unsafe.svg')]);assert.equal(document.querySelector('.dm-files'),null);assert.match(ui.text(),/Недопустимый формат/);
  await choose([new File(['a'],'document.pdf')]);ui.state.api=async()=>({ok:true,json:async()=>({message:row(1,'')})});await ui.send();assert.equal(document.querySelector('.dm-files'),null);
 }finally{await ui.close()}
});
