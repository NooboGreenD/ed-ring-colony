import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { bundleFile } from './helpers/bundle.mjs';
const supabase = `
export const supabase={auth:{getUser:async()=>({data:{user:{id:'admin'}}})},from(table){
 let from=0,to=999,mode='read',value,id;
 const query={select(){return query;},order(){return query;},eq(_,next){id=next;return query;},range(start,end){from=start;to=end;return query;},
  single:async()=>({data:{id:'admin',role:'admin'}}),maybeSingle:async()=>({data:null}),
  update(data){mode='update';value=data;return query;},insert(data){mode='insert';value=data;return query;},
  then(resolve,reject){
   const state=globalThis.__coordinateUi;
   if(mode==='update'){
    state.writes.push({table,id,value});
    if(id===12)return Promise.resolve({error:{message:'write denied'}}).then(resolve,reject);
    const row=(state[table]||[]).find(row=>row.id===id);if(row)Object.assign(row,value);
    return Promise.resolve({error:null}).then(resolve,reject);
   }
   return Promise.resolve({data:(state[table]||[]).slice(from,to+1),error:null}).then(resolve,reject);
  },
 };return query;
}};
export const authFetch=(url,options)=>globalThis.fetch(url,options);
`;

test('coordinate buttons update only missing hubs/route rows and every project row, using shared Spansh fallback results', async () => {
  const bundle = await bundleFile({
    entrySource: `export {default as Admin} from '@/app/admin/page';export {default as Project} from '@/app/projects/[id]/page';export {I18nProvider} from '@/lib/i18n/I18nContext';`,
    external: ['react', 'react-dom', 'react-dom/client'],
    loader: { '.css': 'empty' },
    stubs: {
      '@/lib/supabaseClient': supabase,
      'next/dynamic': `export default function dynamic(){return ()=>null;}`,
      'next/navigation': `export const useParams=()=>({id:'7'});export const useRouter=()=>({push(){},refresh(){}});export const usePathname=()=>'/admin';`,
      'next/link': `import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children);}`,
    },
  });
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://test.local/admin?tab=hubs',
  });
  const keys = [
    'window',
    'document',
    'HTMLElement',
    'localStorage',
    'alert',
    'IS_REACT_ACT_ENVIRONMENT',
    'fetch',
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, globalThis[key]])
  );
  const alerts = [];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    alert: (message) => alerts.push(message),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const state = {
    writes: [],
    hubs: [
      {
        id: 1,
        name: 'Origin hub',
        system_name: 'Origin',
        segment_order: 1,
        x: 0,
        y: 0,
        z: 0,
        status: 'planned',
      },
      {
        id: 2,
        name: 'Missing hub',
        system_name: 'Hub',
        segment_order: 2,
        x: 1,
        y: null,
        z: null,
        status: 'planned',
      },
    ],
    route_systems: [
      {
        id: 10,
        system_name: 'Origin route',
        sort_order: 1,
        x: 0,
        y: 0,
        z: 0,
        status: 'planned',
      },
      {
        id: 11,
        system_name: 'Route',
        sort_order: 2,
        x: null,
        y: null,
        z: null,
        status: 'planned',
      },
      {
        id: 12,
        system_name: 'Denied',
        sort_order: 3,
        x: null,
        y: null,
        z: null,
        status: 'planned',
      },
    ],
  };
  globalThis.__coordinateUi = state;
  const allProjectRows = [
    {
      id: 20,
      system_name: 'Project origin',
      x: 0,
      y: 0,
      z: 0,
      planned_status: 'planned',
    },
    {
      id: 21,
      system_name: 'Project',
      x: null,
      y: null,
      z: null,
      planned_status: 'planned',
    },
    {
      id: 22,
      system_name: 'Hidden project',
      x: null,
      y: null,
      z: null,
      planned_status: 'planned',
    },
  ];
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    calls.push({
      path,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (path === '/api/route/resolve' || path === '/api/edsm/batch') {
      const names = JSON.parse(options.body).names;
      return {
        ok: true,
        json: async () => ({
          results: Object.fromEntries(
            names.map((name) => [name, { x: 3, y: 4, z: 5 }])
          ),
          sources: Object.fromEntries(names.map((name) => [name, 'spansh'])),
          warnings: [],
        }),
      };
    }
    if (path === '/api/projects/7/systems?coordinates_only=1')
      return { ok: true, json: async () => ({ systems: allProjectRows }) };
    if (path === '/api/projects/7/systems' && options.method === 'PATCH') {
      const patch = JSON.parse(options.body);
      state.writes.push({
        table: 'project_systems',
        id: patch.system_id,
        value: patch,
      });
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (path === '/api/projects/7')
      return {
        ok: true,
        json: async () => ({
          project: {
            id: 7,
            name: 'Project',
            color: '#fff',
            created_by: 'admin',
            status: 'active',
            squadron_id: null,
          },
          members: [
            {
              user_id: 'admin',
              role: 'leader',
              profile: { cmdr_name: 'Commander', avatar_url: null },
            },
          ],
          systems: allProjectRows.slice(0, 2),
          route: [],
        }),
      };
    return { ok: true, json: async () => ({}) };
  };
  const mod = await import(bundle);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const flush = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const click = async (element) =>
    act(async () =>
      element.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      )
    );
  const button = (text) =>
    Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent.includes(text)
    );
  try {
    await act(async () =>
      root.render(
        React.createElement(
          mod.I18nProvider,
          null,
          React.createElement(mod.Admin)
        )
      )
    );
    await flush();
    assert.ok(button('Загрузить координаты EDSM / Spansh'));
    await click(button('Загрузить координаты EDSM / Spansh'));
    await flush();
    assert.ok(
      state.writes.some(
        (write) =>
          write.table === 'hubs' && write.id === 2 && write.value.x === 3
      )
    );
    assert.ok(!state.writes.some((write) => write.id === 1));
    assert.match(document.body.textContent, /Spansh: 1/);
    await click(
      Array.from(document.querySelectorAll('button')).find(
        (element) => element.textContent.trim() === 'Маршрут'
      )
    );
    await flush();
    await click(button('Загрузить координаты EDSM / Spansh'));
    await flush();
    assert.ok(
      state.writes.some(
        (write) => write.table === 'route_systems' && write.id === 11
      )
    );
    assert.ok(!state.writes.some((write) => write.id === 10));
    assert.match(document.body.textContent, /write denied/);
    const beforeProject = state.writes.length;
    await act(async () => root.render(React.createElement(mod.Project)));
    await flush();
    await click(
      Array.from(document.querySelectorAll('button')).find(
        (element) =>
          element.className.includes('tab') &&
          element.textContent.includes('Маршрут')
      )
    );
    await flush();
    await click(button('Координаты EDSM / Spansh'));
    await flush();
    const projectWrites = state.writes.slice(beforeProject);
    assert.deepEqual(projectWrites.map((write) => write.id).sort(), [21, 22]);
    assert.ok(
      projectWrites.every((write) => write.table === 'project_systems')
    );
    assert.ok(calls.some((call) => call.path.includes('coordinates_only=1')));
    assert.match(alerts.at(-1), /Обновлено координат: 2 из 2/);
    assert.match(alerts.at(-1), /Spansh: 2/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    delete globalThis.__coordinateUi;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
