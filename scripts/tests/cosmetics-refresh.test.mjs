import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bundleFile } from './helpers/bundle.mjs';

const bundle = await bundleFile({
  entrySource: `export { default as Provider, previewSkin, applySkinToDocument } from '@/components/Cosmetics/HudSkinProvider';
    export { invalidateCosmetics } from '@/components/Cosmetics/useCosmetics';`,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  stubs: { '@/lib/supabaseClient': `
    export const getCurrentUser = async () => ({ id: 'pilot' });
    export const createSupabaseClient = () => ({ auth: { onAuthStateChange: callback => {
      globalThis.authChanged = callback;
      return { data: { sub: null, subscription: { unsubscribe() {} } } };
    } } });` },
});

test('equipped theme refreshes without reload, ignores stale requests, survives failures and restores after preview', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://local.test' });
  const keys = ['window', 'document', 'HTMLElement', 'Event', 'CustomEvent', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', 'authChanged'];
  const before = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, init) => new Promise(resolve => pending.push({ resolve, init }));
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const mod = await import(bundle);
  const root = createRoot(document.getElementById('root'));
  const flush = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  const skin = id => ({ id, preview: { color: id === 'A' ? '#ff8800' : '#00aaff', cssEffects: id === 'A' ? { '--skin-shadow': 'glow' } : {} } });
  const reply = async (request, id, ok = true) => {
    await React.act(async () => { request.resolve({ ok, json: async () => ({ cosmetics: { pilot: { user_id: 'pilot', skin: id ? skin(id) : null } } }) }); });
    await flush();
  };
  const current = () => document.documentElement.getAttribute('data-hud-skin');
  try {
    await React.act(async () => { root.render(React.createElement(mod.Provider)); });
    await flush();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].init.cache, 'no-store');
    await reply(pending.shift(), 'A');
    assert.equal(current(), 'A');
    assert.equal(document.documentElement.style.getPropertyValue('--skin-shadow'), 'glow');
    await React.act(async () => mod.invalidateCosmetics('pilot'));
    await flush();
    const stale = pending.shift();
    assert.equal(current(), 'A', 'retain previous skin during refetch');
    await React.act(async () => window.dispatchEvent(new Event('cosmetics:changed')));
    await flush();
    await reply(pending.shift(), 'B');
    assert.equal(current(), 'B');
    assert.equal(document.documentElement.style.getPropertyValue('--skin-shadow'), '', 'old effect removed');
    await reply(stale, 'A');
    assert.equal(current(), 'B', 'late response cannot undo equip');
    await React.act(async () => mod.invalidateCosmetics('pilot'));
    await flush();
    await reply(pending.shift(), null, false);
    assert.equal(current(), 'B', '503 must not remove equipped theme');
    await React.act(async () => mod.previewSkin(skin('Preview')));
    assert.equal(current(), 'Preview');
    await React.act(async () => mod.invalidateCosmetics('pilot'));
    await flush();
    await reply(pending.shift(), 'C');
    assert.equal(current(), 'Preview', 'background refresh must not end preview');
    await React.act(async () => mod.previewSkin(null));
    assert.equal(current(), 'C', 'preview resets to latest persisted skin');
    await React.act(async () => globalThis.authChanged('SIGNED_OUT', null));
    assert.equal(current(), null, 'sign-out removes personal skin');
    await React.act(async () => globalThis.authChanged('SIGNED_IN', { user: { id: 'pilot' } }));
    await flush();
    await reply(pending.shift(), 'C');
    assert.equal(current(), 'C', 'session reinitialization restores server state');
    await React.act(async () => mod.invalidateCosmetics('pilot'));
    await flush();
    await reply(pending.shift(), null);
    assert.equal(current(), null, 'successful unequip restores defaults');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const key of keys) { if (before[key] === undefined) delete globalThis[key]; else globalThis[key] = before[key]; }
  }
});
