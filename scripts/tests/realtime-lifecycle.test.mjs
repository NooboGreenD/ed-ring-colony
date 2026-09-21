import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

mkdirSync('.cache', { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.cache/realtime-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'supabase.mjs'), 'export const supabase = globalThis.__realtimeTestClient;');
writeFileSync(join(dir, 'navigation.mjs'), 'export const useRouter = () => ({push(){}});');
writeFileSync(join(dir, 'link.mjs'), `import React from 'react'; export default function Link(props) {return React.createElement('a',props);}`);
writeFileSync(join(dir, 'entry.tsx'), `export {default as Bell} from '@/components/NotificationBell';
export {default as Badge} from '@/components/UnreadBadge';`);

const state = {};
const client = {
  auth: {
    getUser: () => state.initialUser,
    onAuthStateChange: fn => { state.listeners.add(fn); return {data:{subscription:{unsubscribe:()=>state.listeners.delete(fn)}}}; },
  },
  from: table => {
    const result = state.queryResult?.(table) ?? Promise.resolve({data:[],count:0,error:null});
    const query = { then: (...args) => result.then(...args) };
    for (const name of ['select','eq','is','order','limit','update']) query[name] = () => query;
    return query;
  },
  channel: name => {
    const channel = { name, filters:[], on(event,filter,fn) {this.filters.push({event,filter,fn});return this;}, subscribe(){return this;} };
    state.channels.push(channel); return channel;
  },
  removeChannel: async channel => {state.removed.push(channel);},
};
globalThis.__realtimeTestClient = client;
await build({entryPoints:[join(dir,'entry.tsx')],outfile:join(dir,'bundle.mjs'),bundle:true,platform:'node',format:'esm',jsx:'automatic',
  external:['react','react/*','react-dom/*'],logLevel:'silent',alias:{
    '@/lib/supabaseClient':join(dir,'supabase.mjs'),'next/navigation':join(dir,'navigation.mjs'),
    'next/link':join(dir,'link.mjs'),'@':join(process.cwd(),'src'),
  }});
const { Bell, Badge } = await import(join(dir,'bundle.mjs'));
function deferred() {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function render(Component, initialUser = Promise.resolve({data:{user:null}})) {
  Object.assign(state,{initialUser,listeners:new Set(),channels:[],removed:[],intervals:new Set(),queryResult:null});
  const dom = new JSDOM('<div id="root"></div>',{url:'https://edringcolony.ru',pretendToBeVisual:true});
  const globals = new Map(['window','document','localStorage','IS_REACT_ACT_ENVIRONMENT','setInterval','clearInterval']
    .map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,
    setInterval:fn=>{state.intervals.add(fn);return fn;},clearInterval:fn=>state.intervals.delete(fn)});
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async()=>{root.render(React.createElement(Component));});
  return {
    dom,
    async event(name,id) {await act(async()=>{for (const callback of state.listeners) callback(name,id ? {user:{id}} : null);});},
    async close() {
      await act(async()=>{root.unmount();});dom.window.close();
      for(const [key,descriptor] of globals) {if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
    },
  };
}
for (const [name,Component,prefix] of [['notification bell',Bell,'notifications'],['unread badge',Badge,'unread']]) {
  test(`${name}: guest opens no socket and starts no private polling`, async()=>{
    const app=await render(Component);
    try {assert.equal(state.channels.length,0);assert.equal(state.intervals.size,0);}
    finally {await app.close();}
    assert.equal(state.listeners.size,0);
  });
  test(`${name}: login, refresh, logout and account switch manage one scoped channel`,async()=>{
    const app=await render(Component);
    try {
      await app.event('SIGNED_IN','pilot-a');
      assert.equal(state.channels.length,1);assert.equal(state.channels[0].name,`${prefix}:pilot-a`);
      assert.ok(state.channels[0].filters.every(({filter})=>filter.filter.endsWith('=eq.pilot-a')));
      assert.equal(state.channels[0].filters.find(({filter})=>filter.table==='messages').filter.filter,'recipient_id=eq.pilot-a');
      await app.event('TOKEN_REFRESHED','pilot-a');assert.equal(state.channels.length,1,'refresh must not reconnect same user');
      await app.event('SIGNED_OUT',null);
      assert.deepEqual(state.removed,[state.channels[0]]);assert.equal(state.intervals.size,0);
      await app.event('SIGNED_IN','pilot-b');assert.equal(state.channels[1].name,`${prefix}:pilot-b`);
      assert.equal(state.intervals.size,1);
    } finally {await app.close();}
    assert.equal(state.removed.length,2);assert.equal(state.listeners.size,0);assert.equal(state.intervals.size,0);
  });
  test(`${name}: late getUser cannot resurrect the old account's channel`,async()=>{
    const user=deferred();const app=await render(Component,user.promise);
    try {
      await app.event('SIGNED_IN','pilot-b');
      await act(async()=>user.resolve({data:{user:{id:'pilot-a'}}}));
      assert.deepEqual(state.channels.map(channel=>channel.name),[`${prefix}:pilot-b`]);
      await app.event('SIGNED_OUT',null);assert.equal(state.intervals.size,0);
    } finally {await app.close();}
  });
}
test('unread count from an old request is discarded on account switch',async()=>{
  const count=deferred();const app=await render(Badge);
  try {
    state.queryResult=()=>count.promise;
    await app.event('SIGNED_IN','pilot-a');
    state.queryResult=()=>Promise.resolve({data:[],count:2});
    await app.event('SIGNED_IN','pilot-b');
    assert.match(app.dom.window.document.body.textContent,/Сообщения: 2/);
    await act(async()=>count.resolve({data:[],count:99}));
    assert.match(app.dom.window.document.body.textContent,/Сообщения: 2/);
    assert.doesNotMatch(app.dom.window.document.body.textContent,/99/);
  } finally {await app.close();}
});
