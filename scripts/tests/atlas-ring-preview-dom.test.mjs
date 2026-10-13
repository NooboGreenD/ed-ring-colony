import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { bundleFile } from './helpers/bundle.mjs';

test('кольцо: превью обновляется до поиска, кэширует координаты и отменяет устаревший ответ', async () => {
  const mod = await import(await bundleFile({
    entrySource: `
      import { useAtlasRingPreview } from '@/hooks/useAtlasRingPreview';
      export * from '@/lib/atlasRingPreview';
      export function Preview({start = 'Sol', center = '', radius = 23000, height = 0, tilt = 0, enabled = true}) {
        const message = useAtlasRingPreview(start, center, radius, height, tilt, enabled);
        return <p>{message}</p>;
      }`,
    external: ['react', 'react-dom', 'react-dom/client'],
  }));
  const dom = new JSDOM('<div id="root"></div>');
  const previous = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map(key => [key, globalThis[key]]));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  let finishSlow;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, signal: init.signal });
    if (url.includes('Slow')) return new Promise(resolve => { finishSlow = resolve; });
    if (url.includes('Unknown')) return { ok: false, json: async () => ({ error: 'Система не найдена' }) };
    return { ok: true, json: async () => ({ start: { x: 80, y: 0, z: 50 }, center: { x: -200, y: 30, z: 300 } }) };
  };
  const root = createRoot(document.getElementById('root'));
  const render = async props => act(async () => root.render(React.createElement(mod.Preview, props)));
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  try {
    await render({});
    assert.equal(mod.readAtlasRingPreview().radius, 23000);
    assert.equal(calls.length, 0, 'известные системы не требуют сети');
    const original = mod.readAtlasRingPreview();
    await render({ radius: 12000, tilt: 45, height: 1000 });
    assert.equal(mod.readAtlasRingPreview().radius, 12000);
    assert.notDeepEqual(mod.readAtlasRingPreview().basis, original.basis);
    assert.notEqual(mod.readAtlasRingPreview().cy, original.cy);
    await render({ enabled: false });
    assert.equal(mod.readAtlasRingPreview(), null, 'при поиске превью отключено');
    await render({ start: 'Custom', center: 'Center' });
    assert.equal(mod.readAtlasRingPreview(), null, 'старый контур не показывается для новых имён');
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(mod.readAtlasRingPreview().cx, -200);
    await render({ start: 'Custom', center: 'Center', radius: 1000, tilt: 15 });
    await flush();
    assert.equal(calls.length, 1, 'ползунки не запрашивают координаты повторно');
    assert.equal(mod.readAtlasRingPreview().radius, 1000);
    await render({ start: 'Slow' });
    await flush();
    await render({});
    assert.equal(calls.at(-1).signal.aborted, true);
    const current = mod.readAtlasRingPreview();
    await act(async () => finishSlow({ ok: true, json: async () => ({ start: { x: 1, y: 2, z: 3 }, center: { x: 9, y: 9, z: 9 } }) }));
    assert.equal(mod.readAtlasRingPreview(), current, 'поздний ответ не заменяет текущую геометрию');
    await render({ start: 'Unknown' });
    await flush();
    assert.equal(mod.readAtlasRingPreview(), null);
    assert.match(document.body.textContent, /Система не найдена/);
  } finally {
    await act(async () => root.unmount());
    assert.equal(mod.readAtlasRingPreview(), null, 'выход из формы очищает превью');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
    dom.window.close();
  }
});
