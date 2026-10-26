import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { bundleFile } from './helpers/bundle.mjs';

test('Atlas single search offers all goods; build mode keeps its site lists and submits the selected recipe', async () => {
  const bundle = await bundleFile({
    entry: 'src/components/Atlas/AtlasMarketSearch.tsx',
    external: ['react', 'react-dom', 'react-dom/client'],
    stubs: {
      '@/components/ui/Toaster': `export const toast=()=>{};`,
      '@/lib/atlasSearchProgress': `export const finishAtlasSearchProgress=()=>{};export const publishAtlasSearchPoints=()=>{};export const publishAtlasSearchProgress=()=>{};export const startAtlasSearchProgress=()=>{};`,
      '@/components/Atlas/SystemSearchInput': `import React from 'react';export function SystemSearchInput({label,value,onChange}) {return React.createElement('label',null,label,React.createElement('input',{value,onChange:e=>onChange(e.target.value)}));}`,
    },
  });
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://test.local/atlas?tab=market',
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
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () =>
        String(url).endsWith('/start')
          ? {
              job_id: 'job-1',
              total_systems: 1,
              systems_list: [{ name: 'Sol', distance: 0, x: 0, y: 0, z: 0 }],
            }
          : {
              status: 'done',
              is_done: true,
              progress: { scanned: 1, total: 1, found: 0 },
              result: [],
              warnings: ['Sol: EDSM недоступен'],
            },
    };
  };
  const { default: Market } = await import(bundle);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const click = async (element) =>
    act(async () =>
      element.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      )
    );
  try {
    await act(async () => root.render(React.createElement(Market)));
    const commodityInput = document.getElementById('atlas-commodity');
    const suggestedGoods = [...document.querySelectorAll('#atlas-commodities option')].map((option) => option.value);
    assert.ok(suggestedGoods.includes('Gold'), 'single-item search includes ordinary market goods');
    assert.ok(suggestedGoods.includes('Lavian Brandy'), 'single-item search includes rare goods');
    assert.ok(suggestedGoods.length > 100, 'the list is broader than the construction catalog');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(commodityInput, 'Gold');
      commodityInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click(document.querySelector('.atlas-scan-btn'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(requests[0].body.mode, 'single');
    assert.equal(requests[0].body.commodity, 'Gold');
    await click(
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Всё для стройки'
      )
    );
    const select = document.getElementById('atlas-build-type');
    assert.equal(select.options.length, 56);
    assert.equal(
      document.querySelectorAll('.atlas-build-materials tbody tr').length,
      55
    );
    await act(async () => {
      select.value = 'no_truss';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(
      document.querySelectorAll('.atlas-build-materials tbody tr').length,
      19
    );
    assert.match(
      document.querySelector('.atlas-build-materials').textContent,
      /Aluminium/
    );
    assert.match(
      document.querySelector('.atlas-build-materials').textContent,
      /10\s*055/
    );
    assert.match(document.body.textContent, /точные требования и остаток/);
    await click(document.querySelector('.atlas-scan-btn'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(requests[2].body.build_type, 'no_truss');
    assert.equal(requests[2].body.mode, 'build');
    assert.match(document.body.textContent, /Результаты могут быть неполными/);
    assert.doesNotMatch(document.body.textContent, /fetch failed/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
