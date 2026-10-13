import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { bundleFile } from './helpers/bundle.mjs';

const SUPABASE_STUB = `
export const supabase = {
  auth: { getUser: async () => ({data:{user:{id:'admin'}}}) },
  from(table) {
    let offset = 0, end = 999, mode = 'read', value, id;
    const query = {
      select() { return query; }, order() { return query; }, eq(_, next) { id = next; return query; },
      range(from,to) { offset = from; end = to; return query; },
      single: async () => ({data:{id:'admin',role:'admin'}}),
      maybeSingle: async () => ({data:null}),
      update(data) { mode='update';value=data;return query; },
      delete() { mode='delete';return query; },
      insert(rows) { mode='insert';value=rows;return query; },
      then(resolve,reject) {
        if (table === 'route_systems') {
          if (mode === 'read' && globalThis.__largeAdminError && offset >= 1000) return Promise.resolve({data:null,error:{message:'failed page'}}).then(resolve,reject);
          if (mode === 'read') return Promise.resolve({data:globalThis.__largeAdminRows.slice(offset, Math.min(end+1,offset+1000)),error:null}).then(resolve,reject);
          globalThis.__largeAdminWrites.push({mode,id,value});
        }
        return Promise.resolve({data:[],error:null}).then(resolve,reject);
      },
    }; return query;
  },
};
export const authFetch = async () => ({json:async () => ({})});
`;

test('admin: a 20,051-system route has bounded pages, global search, late-row editing and correct append order', async () => {
  const bundle = await bundleFile({
    entrySource: `
      export {default as AdminPage} from '@/app/admin/page';
      export {I18nProvider} from '@/lib/i18n/I18nContext';
      import React, {useState} from 'react';
      import {RoutePagination,useRoutePagination} from '@/components/Admin/RoutePagination';
      export function PaginationHarness() {
        const [rows,setRows]=useState(Array.from({length:20001},(_,i)=>i+1));
        const page=useRoutePagination(rows);
        return React.createElement(React.Fragment,null,
          React.createElement(RoutePagination,page),
          React.createElement('output',null,JSON.stringify(page.rows)),
          React.createElement('button',{onClick:()=>setRows(rows.slice(0,-1))},'Remove last'));
      }
    `,
    stubs: {'@/lib/supabaseClient':SUPABASE_STUB, 'next/dynamic':`export default function dynamic() {return () => null;}`,
      'next/navigation':`export const useRouter = () => ({push(){},refresh(){}}); export const usePathname = () => '/admin';`,
      'next/link':`import React from 'react';export default function Link({href,children,...rest}) {return <a href={href} {...rest}>{children}</a>;}`},
    external:['react','react-dom','react-dom/client'],
    loader:{'.tsx':'tsx','.ts':'ts','.css':'empty'},
  });
  const dom = new JSDOM('<div id="root"></div>',{url:'http://example.test/admin?tab=route'});
  const keys=['window','document','localStorage','HTMLElement','IS_REACT_ACT_ENVIRONMENT','fetch','confirm'];
  const previous=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;
  globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  globalThis.fetch=async()=>({ok:true,json:async()=>({})});globalThis.confirm=()=>true;
  globalThis.__largeAdminRows=Array.from({length:20051},(_,i)=>({id:i+1,system_name:`System ${i+1}`,sort_order:i+1,x:i,y:0,z:0,status:'planned',progress:0}));
  globalThis.__largeAdminWrites=[];
  const mod = await import(bundle);
  const {createRoot} = await import('react-dom/client');
  const root=createRoot(document.getElementById('root'));
  const flush=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  const click=async el=>act(async()=>el.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
  const change=async(el,value)=>{
    await act(async()=>{
      const prototype=el.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:el.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,value);
      el.dispatchEvent(new dom.window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));
    });await flush();
  };
  try {
    await act(async()=>root.render(React.createElement(mod.I18nProvider,null,React.createElement(mod.AdminPage))));await flush();
    const rows=()=>Array.from(document.querySelectorAll('tbody tr'));
    assert.equal(rows().length,100);
    assert.match(document.body.textContent,/20051/);
    await click(document.querySelector('button[aria-label="Последняя страница"]'));
    assert.equal(rows().length,51);
    assert.match(rows().at(-1).textContent,/System 20051/);
    await change(rows().at(-1).querySelector('select'),'done');
    assert.deepEqual(globalThis.__largeAdminWrites.at(-1),{mode:'update',id:20051,value:{status:'done'}});
    assert.equal(rows().length,51);
    const search=document.querySelector('input[placeholder="Поиск по списку"]');
    await change(search,'System 20051');
    assert.equal(rows().length,1);
    assert.match(rows()[0].textContent,/System 20051/);
    await change(search,'');
    assert.equal(rows().length,100,'filter changes return to the first page');
    const size=Array.from(document.querySelectorAll('nav select')).find(el=>el.options.length===3);
    await change(size,'250');assert.equal(rows().length,250);
    const bulk=document.querySelector('textarea[placeholder^="HIP 12345"]');
    await change(bulk,'New system');
    const add=Array.from(document.querySelectorAll('button')).find(el=>el.textContent.includes('Добавить в маршрут'));
    assert.ok(add);
    await click(add);await flush();
    const inserted=globalThis.__largeAdminWrites.find(write=>write.mode==='insert');
    assert.equal(inserted.value[0].sort_order,20052,'append uses the last order of the complete route');
    globalThis.__largeAdminError=true;
    await change(bulk,'Reload test');await click(add);await flush();
    assert.equal(rows().length,0,'failed later pages never appear as a complete route');
    assert.match(document.querySelector('[role=alert]').textContent,/failed page/);
    assert.equal(add.disabled,true);
    await act(async()=>root.render(React.createElement(mod.I18nProvider,null,React.createElement(mod.PaginationHarness))));
    await flush();
    await click(document.querySelector('button[aria-label="Последняя страница"]'));
    assert.equal(document.querySelector('output').textContent,'[20001]');
    await click(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Remove last'));
    const remaining=JSON.parse(document.querySelector('output').textContent);
    assert.equal(remaining.length,100,'deleting the only last-page row clamps to a nonempty previous page');
    assert.equal(remaining.at(-1),20000);
    await change(document.querySelector('nav select'),'50');
    assert.equal(JSON.parse(document.querySelector('output').textContent)[0],1);
    assert.equal(JSON.parse(document.querySelector('output').textContent).length,50);
  } finally {
    await act(async()=>root.unmount());dom.window.close();
    delete globalThis.__largeAdminRows;delete globalThis.__largeAdminWrites;delete globalThis.__largeAdminError;
    for(const[key,value]of Object.entries(previous)) {if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  }
});
