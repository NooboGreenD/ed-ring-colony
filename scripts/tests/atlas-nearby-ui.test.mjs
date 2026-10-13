import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { bundleFile } from './helpers/bundle.mjs';

test('nearby UI: 20,051-row complete list, last page, global search, full CSV, cube radius and cancellation', async () => {
  const bundle = await bundleFile({
    entry: 'src/components/Atlas/AtlasNearbySearch.tsx',
    external: ['react', 'react-dom', 'react-dom/client'],
    stubs: {
      '@/lib/atlas': `export function downloadCsv(name,rows){globalThis.__nearbyCsv={name,rows};}`,
      '@/lib/atlasSearchProgress': `export const finishAtlasSearchProgress=()=>{};export const publishAtlasSearchPoints=()=>{};export const startAtlasSearchProgress=()=>{};`,
      '@/components/Atlas/SystemSearchInput': `import React from 'react';export function SystemSearchInput({label,value,onChange,disabled}){return React.createElement('label',null,label,React.createElement('input',{value,disabled,onChange:event=>onChange(event.target.value)}));}`,
    },
  });
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://test.local/atlas?tab=nearby',
  });
  const keys = [
    'window',
    'document',
    'HTMLElement',
    'CustomEvent',
    'DOMException',
    'IS_REACT_ACT_ENVIRONMENT',
    'fetch',
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, globalThis[key]])
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent,
    DOMException: dom.window.DOMException,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const systems = Array.from({ length: 20051 }, (_, i) => ({
    name: `System ${i + 1}`,
    x: i / 20051,
    y: 0,
    z: 0,
    distance: i / 20051,
    sources: ['catalog'],
    aliases: [],
    coordinate_conflict: false,
  }));
  const calls = [];
  let pendingResolve;
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    calls.push({ body, signal: options.signal });
    if (calls.length > 1)
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    return {
      ok: true,
      json: async () => ({
        reference: { name: 'Sol', x: 0, y: 0, z: 0 },
        shape: body.shape,
        radius: body.radius,
        systems,
        count: systems.length,
        sources: [
          { id: 'catalog', status: 'ok', count: systems.length },
          {
            id: 'spansh',
            status: 'partial',
            count: 0,
            message: 'Источник недоступен',
          },
        ],
        warnings: ['Неполная выдача Spansh'],
      }),
    };
  };
  const { default: Nearby } = await import(bundle);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const click = async (el) =>
    act(async () =>
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
  const flush = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const change = async (el, value) =>
    act(async () => {
      const prototype =
        el.tagName === 'SELECT'
          ? dom.window.HTMLSelectElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
      el.dispatchEvent(
        new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', {
          bubbles: true,
        })
      );
    });
  const button = (text) =>
    Array.from(document.querySelectorAll('button')).find((el) =>
      el.textContent.includes(text)
    );
  try {
    await act(async () => root.render(React.createElement(Nearby)));
    const range = document.getElementById('atlas-nearby-radius');
    assert.equal(range.min, '1');
    assert.equal(range.max, '50');
    await change(document.getElementById('atlas-nearby-shape'), 'cube');
    await change(range, '1');
    await click(button('Найти все системы'));
    await flush();
    assert.deepEqual(calls[0].body, {
      reference_system: 'Sol',
      shape: 'cube',
      radius: 1,
    });
    assert.equal(document.querySelectorAll('tbody tr').length, 100);
    assert.match(document.body.textContent, /20\s*051/);
    assert.match(document.body.textContent, /частичные данные/);
    assert.match(
      document.body.textContent,
      /На карте показаны ближайшие 4 000 систем/
    );
    await click(button('CSV:'));
    assert.equal(globalThis.__nearbyCsv.rows.length, 20052);
    await click(
      document.querySelector('button[aria-label="Последняя страница"]')
    );
    assert.equal(document.querySelectorAll('tbody tr').length, 51);
    assert.match(document.querySelector('tbody').textContent, /System 20051/);
    await change(
      document.getElementById('atlas-nearby-filter'),
      'System 20051'
    );
    assert.equal(document.querySelectorAll('tbody tr').length, 1);
    await change(document.getElementById('atlas-nearby-filter'), '');
    assert.equal(document.querySelectorAll('tbody tr').length, 100);
    await change(
      document.querySelector('select[aria-label="Строк на странице"]'),
      '250'
    );
    assert.equal(document.querySelectorAll('tbody tr').length, 250);
    await click(button('Найти все системы'));
    await flush();
    await click(button('Стоп'));
    assert.equal(calls[1].signal.aborted, true);
    pendingResolve({
      ok: true,
      json: async () => ({
        reference: { name: 'Old', x: 0, y: 0, z: 0 },
        shape: 'cube',
        radius: 1,
        systems,
        count: systems.length,
        sources: [],
        warnings: [],
      }),
    });
    await flush();
    assert.equal(
      document.querySelectorAll('tbody tr').length,
      0,
      'late results cannot repopulate a cancelled search'
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    delete globalThis.__nearbyCsv;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
