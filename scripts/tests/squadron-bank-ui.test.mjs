import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { I18N_CONTEXT_STUB } from './helpers/i18nStub.mjs';

const entry = await bundleFile({
  entrySource: `export {default as Bank} from '@/components/Carriers/SquadronBankPanel'; export {default as Page} from '@/app/squadrons/[id]/page';`,
  external: ['react', 'react-dom', 'react-dom/client'],
  stubs: {
    '@/lib/i18n/I18nContext': I18N_CONTEXT_STUB,
    'next/link': `import React from 'react'; export default function Link({href,children}) {return <a href={href}>{children}</a>}`,
    'next/navigation': `export const useParams=()=>({id:'7'});`,
    '@/lib/supabaseClient': `
      export const authFetch=(...args)=>globalThis.fetch(...args);
      export const supabase={auth:{
        getUser:async()=>({data:{user:globalThis.__bankUiUser}}),
        onAuthStateChange:(callback)=>{
          globalThis.__bankAuthCallback=callback;
          return {data:{subscription:{unsubscribe(){globalThis.__bankAuthCallback=null;}}}};
        }
      }};
    `,
    '@/components/Carriers/CarrierPanel': `export default function Panel(){return <div>Carrier panel</div>}`,
    '@/components/SquadronChat': `export default function Chat(){return null}`,
    '@/components/Avatar': `export default function Avatar(){return null}`,
  },
});

const carriers = [{
  carrierId: '3713477376', name: 'Squadron Depot', callsign: 'DNHG', type: 'SquadronCarrier', relation: 'squadron',
  cargo: { items: [{ commodity: 'steel', name: 'Сталь', quantity: 2640 }], trackedTotal: 2640, updatedAt: '2026-11-24T21:30:00Z' },
}];
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

async function render({ page = false, member = true, url = 'https://example.test/squadrons/7', api } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url, pretendToBeVisual: true });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', '__bankUiUser', '__bankAuthCallback', 'setInterval', 'clearInterval'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__bankUiUser = member ? { id: 'member' } : null;
  const calls = [];
  const intervals = new Map();
  let timerId = 0;
  globalThis.setInterval = (callback, ms) => { const id = ++timerId; intervals.set(id, { callback, ms }); return id; };
  globalThis.clearInterval = id => intervals.delete(id);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/bank')) return api ? api(calls.filter(call => call.url.endsWith('/bank')).length) : response({ ok: true, carriers });
    return response({ squadron: { id: 7, name: 'Test Squadron', tag: 'TEST', color: '#e67e22', description: '', created_by: 'officer' },
      members: member ? [{ user_id: 'member', cmdr_name: 'Pilot', rank_name: 'Member' }] : [], ranks: [], projects: [] });
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Bank, Page } = await import(entry);
  const root = createRoot(document.getElementById('root'));
  const flush = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const draw = async (id = 7) => { await React.act(async () => root.render(React.createElement(page ? Page : Bank, page ? {} : { squadronId: id }))); await flush(); };
  await draw();
  return {
    dom, calls, draw, flush, intervals, act: React.act,
    text: () => document.body.textContent,
    button: pattern => [...document.querySelectorAll('button')].find(button => pattern.test(button.textContent)),
    click: async button => { assert.ok(button); await React.act(async () => button.click()); await flush(); },
    async close() {
      await React.act(async () => root.unmount());
      dom.window.close();
      for (const key of keys) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    },
  };
}

test('squadron bank tab is lazy, visible to ordinary members and preserves direct URL', async () => {
  const ui = await render({ page: true });
  try {
    assert.ok(ui.button(/Банк эскадрильи/));
    assert.equal(ui.calls.filter(call => call.url.endsWith('/bank')).length, 0);
    await ui.click(ui.button(/Банк эскадрильи/));
    assert.equal(ui.calls.filter(call => call.url.endsWith('/bank')).length, 1);
    assert.match(ui.text(), /Сталь/);
    assert.match(ui.text(), /Squadron Depot/);
    assert.match(ui.text(), /Не полный снимок банка/);
    assert.equal(new URL(ui.dom.window.location.href).searchParams.get('tab'), 'bank');
    await ui.click(ui.button(/^Обзор$/));
    assert.ok(!document.querySelector('[data-testid="squadron-bank"]'));
    assert.equal(new URL(ui.dom.window.location.href).searchParams.get('tab'), null);
    assert.equal(ui.intervals.size, 0);
  } finally { await ui.close(); }
});

test('deep link opens bank for members, while visitors neither see the tab nor fetch goods', async () => {
  const member = await render({ page: true, url: 'https://example.test/squadrons/7?tab=bank' });
  try { assert.match(member.text(), /Сталь/); } finally { await member.close(); }
  const visitor = await render({ page: true, member: false, url: 'https://example.test/squadrons/7?tab=bank' });
  try {
    assert.equal(visitor.button(/Банк эскадрильи/), undefined);
    assert.match(visitor.text(), /только участникам/);
    assert.equal(visitor.calls.filter(call => call.url.endsWith('/bank')).length, 0);
  } finally { await visitor.close(); }
});

test('bank distinguishes no carrier, denied access and load errors, and supports retry', async () => {
  const empty = await render({ api: () => response({ ok: true, carriers: [] }) });
  try { assert.match(empty.text(), /ещё не привязан/); } finally { await empty.close(); }
  const denied = await render({ api: () => response({}, 403) });
  try { assert.match(denied.text(), /только участникам/); assert.doesNotMatch(denied.text(), /Сталь/); } finally { await denied.close(); }
  const retry = await render({ api: n => n === 1 ? response({}, 503) : response({ ok: true, carriers }) });
  try {
    assert.match(retry.text(), /Не удалось загрузить банк/);
    await retry.click(retry.button(/Обновить/));
    assert.match(retry.text(), /Сталь/);
    assert.equal(retry.calls[0].init.cache, 'no-store');
  } finally { await retry.close(); }
});

test('logout clears private goods and a late response cannot restore them', async () => {
  let resolve;
  const ui = await render({ api: n => n === 1 ? response({ ok: true, carriers }) : new Promise(done => { resolve = done; }) });
  try {
    assert.match(ui.text(), /Сталь/);
    await ui.click(ui.button(/Обновить/));
    await ui.act(async () => { globalThis.__bankAuthCallback('SIGNED_OUT'); });
    await ui.act(async () => { resolve(response({ ok: true, carriers })); });
    await ui.flush();
    assert.doesNotMatch(ui.text(), /Сталь/);
    assert.match(ui.text(), /только участникам/);
  } finally { await ui.close(); }
});

test('changing squadron clears goods and discards the old squadron response', async () => {
  let resolve;
  const ui = await render({ api: n => n === 1 ? new Promise(done => { resolve = done; }) : response({ ok: true, carriers: [] }) });
  try {
    await ui.draw(8);
    await ui.act(async () => resolve(response({ ok: true, carriers })));
    await ui.flush();
    assert.doesNotMatch(ui.text(), /Сталь/);
    assert.match(ui.text(), /ещё не привязан/);
    assert.ok(ui.calls.some(call => call.url === '/api/squadrons/8/bank'));
  } finally { await ui.close(); }
});

test('bank refreshes once per minute only while visible and clears stale goods on access revocation', async () => {
  const ui = await render({ api: n => n === 1 ? response({ ok: true, carriers }) : response({}, 403) });
  try {
    const [timer] = ui.intervals.values();
    assert.equal(timer.ms, 60000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await ui.act(async () => timer.callback());
    assert.equal(ui.calls.length, 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await ui.act(async () => timer.callback());
    await ui.flush();
    assert.equal(ui.calls.length, 2);
    assert.match(ui.text(), /только участникам/);
    assert.doesNotMatch(ui.text(), /Сталь/);
  } finally { await ui.close(); }
});
