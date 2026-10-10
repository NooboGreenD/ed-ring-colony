import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINDING = { linked: true, tokenActive: true, platform: 'epic', status: 'missing',
  lastError: 'CAPI не подтвердил доступ к Elite Dangerous. Авторизация сохранена.' };

async function renderCapi({ binding = BINDING, query = '', api } = {}) {
  const dir = mkdtempSync(join(ROOT, '.tmp-capi-page-'));
  writeFileSync(join(dir, 'auth.mjs'), 'export const authFetch = (url, init) => globalThis.fetch(url, init);');
  const bundle = join(dir, 'page.mjs');
  await build({
    entryPoints: [join(ROOT, 'src/app/account/capi/page.tsx')], outfile: bundle,
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client'],
    alias: { '@/lib/supabaseClient': join(dir, 'auth.mjs'), '@': join(ROOT, 'src') },
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `https://colony.test/account/capi${query}`, pretendToBeVisual: true,
  });
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Element', 'Node',
    'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key],
      configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    const custom = api?.(String(url), init);
    const body = custom?.body ?? { profile: null, binding: typeof binding === 'function' ? binding() : binding };
    return new Response(JSON.stringify(body), { status: custom?.status ?? 200 });
  };
  const { default: Page } = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => { root.render(React.createElement(Page)); });
  return {
    dom, calls,
    text: () => dom.window.document.body.textContent,
    click: async (element) => {
      await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    },
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('EGS OAuth + отказ CAPI: страница показывает ожидание данных, не повторный вход', async () => {
  const ui = await renderCapi({ query: '?status=partial&reason=entitlement_unavailable&platform=epic' });
  try {
    assert.match(ui.text(), /Авторизация сохранена/);
    assert.doesNotMatch(ui.text(), /Требуется повторная авторизация|Переподключить|нужно нажать кнопку Steam\/Epic/);
    assert.ok(ui.dom.window.document.querySelector('.capi-status-pending'));
    assert.equal(ui.dom.window.document.querySelector('.capi-status-broken'), null);
    assert.ok([...ui.dom.window.document.querySelectorAll('button')].some((b) => b.textContent.includes('Синхронизировать')));
  } finally {
    await ui.cleanup();
  }
});

test('список audience после колбэка сохраняет «Авто», не выбирает Frontier', async () => {
  const ui = await renderCapi({ query: '?platform=frontier%2Csteam%2Cepic',
    binding: { ...BINDING, tokenActive: false } });
  try {
    assert.equal(ui.dom.window.document.querySelector('.capi-platform-active').textContent, 'Определить автоматически');
    assert.equal(ui.dom.window.document.querySelector('a[href^="/api/capi/auth"]').getAttribute('href'), '/api/capi/auth?platform=auto');
  } finally {
    await ui.cleanup();
  }
});

test('неуспешный ручной синк перечитывает привязку и убирает старое требование входа', async () => {
  let binding = { ...BINDING, tokenActive: false };
  const ui = await renderCapi({ binding: () => binding, api: (url) => {
    if (url === '/api/capi/sync') {
      binding = { ...BINDING, tokenActive: true };
      return { status: 502, body: { error: BINDING.lastError, needsReauth: false, reason: 'entitlement_unavailable' } };
    }
  } });
  try {
    assert.match(ui.text(), /Требуется повторная авторизация/);
    const button = [...ui.dom.window.document.querySelectorAll('button')].find((b) => b.textContent.includes('Синхронизировать'));
    await ui.click(button);
    assert.equal(ui.calls.filter((call) => call.url === '/api/capi/profile').length, 2);
    assert.doesNotMatch(ui.text(), /Требуется повторная авторизация|Переподключить/);
    assert.match(ui.text(), /Авторизация сохранена/);
    assert.ok(ui.dom.window.document.querySelector('.capi-status-pending'));
  } finally {
    await ui.cleanup();
  }
});
