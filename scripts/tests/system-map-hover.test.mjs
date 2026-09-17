/**
 * Регрессия 3D-карты системы: наведение не должно перерисовывать фигуру.
 *
 * Что было сломано:
 *
 * 1. `hoveredBody` лежал в зависимостях эффекта, который зовёт `Plotly.react`.
 *    Каждое наведение пересобирало всю фигуру вместе с `scene.camera`, и камера
 *    пользователя молча улетала в стандартный «обзор».
 * 2. Трэк звёзд, в отличие от планет и построек, не проверял, что точки вообще
 *    есть. Пустой маркерный трэк Plotly отдаёт в WebGL с нулевыми буферами —
 *    отсюда `uniform3fv: cannot be converted to a sequence`.
 *
 * Тест рендерит НАСТОЯЩИЙ компонент в jsdom против подставного Plotly и смотрит,
 * какие вызовы тот получил. Без jsdom/esbuild тест честно пропускается, а не
 * падает — `npm test` обязан работать и на голой checkout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
let jsdomMod = null;
try {
  esbuild = await import('esbuild');
  jsdomMod = await import('jsdom');
} catch {
  // devDependencies не установлены — пропускаем, но говорим об этом.
}

const skip = !esbuild || !jsdomMod;
const maybe = skip ? test.skip : test;

/** Собрать компонент в бандл и отрендерить его в jsdom с подставным Plotly. */
async function renderMap(bodies) {
  // Бандл обязан лежать внутри репозитория: react помечен external, и Node
  // ищет его в `node_modules` вверх от файла. В /tmp такой папки нет.
  const dir = mkdtempSync(join(ROOT, '.tmp-edmap-'));
  const entry = join(dir, 'entry.tsx');
  const bundle = join(dir, 'bundle.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    entry,
    "export { default as SystemPlotlyMap } from '@/components/SystemPlotlyMap';\n",
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client'],
    alias: { '@': join(ROOT, 'src') },
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    logLevel: 'silent',
  });

  const { JSDOM } = jsdomMod;
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const prev = {
    window: global.window, document: global.document, HTMLElement: global.HTMLElement,
    Element: global.Element, Node: global.Node, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = raf;

  const calls = { react: [], restyle: [] };
  const handlers = {};
  let gd = null;
  dom.window.Plotly = {
    react(node, traces, layout) {
      calls.react.push({ traces, layout });
      gd = node;
      node._fullLayout = { scene: { camera: JSON.parse(JSON.stringify(layout.scene.camera)) } };
      node.on = (name, fn) => { handlers[name] = fn; };
      return Promise.resolve();
    },
    restyle(_node, update, curves) { calls.restyle.push({ update, curves }); return Promise.resolve(); },
    purge() { return Promise.resolve(); },
  };

  const { SystemPlotlyMap } = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(SystemPlotlyMap, { systemName: 'Sol', initialBodies: bodies }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 25)); });

  return {
    calls,
    handlers,
    /** Камера, которую Plotly сейчас считает текущей. */
    setLiveCamera(eye) { gd._fullLayout.scene.camera.eye = eye; },
    async fire(name, event) {
      await act(async () => {
        handlers[name]?.(event);
        await new Promise((r) => setTimeout(r, 15));
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, value] of Object.entries(prev)) global[key] = value;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const SOL = [
  {
    body_id: 1, body_name: 'Sol', body_type: 'Star', radius_m: 6.957e8, surface_temp_k: 5778,
    raw_data: { type: 'Star', starType: 'G', surfaceTemperature: 5778, radius: 695700 },
  },
  {
    body_id: 3, body_name: 'Earth', body_type: 'Planet', radius_m: 6.371e6,
    raw_data: {
      type: 'Planet', planetClass: 'High metal content body', semiMajorAxis: 1.0,
      orbitalEccentricity: 0.0167, orbitalInclination: 0, argOfPeriapsis: 102.9,
      orbitalPeriod: 365.256, MeanAnomaly: 358.6,
    },
  },
  {
    body_id: 5, body_name: 'Mercury', body_type: 'Planet', radius_m: 2.44e6,
    raw_data: {
      type: 'Planet', semiMajorAxis: 0.387, orbitalEccentricity: 0.2056,
      orbitalInclination: 7.0, argOfPeriapsis: 29.1, orbitalPeriod: 87.97,
    },
  },
];

maybe('карта рисуется и не отдаёт в WebGL пустых маркерных трэков', async () => {
  const map = await renderMap(SOL);
  try {
    assert.ok(map.calls.react.length >= 1, 'Plotly.react не вызван — карта не нарисовалась');
    const traces = map.calls.react[0].traces;
    const empty = traces.filter(
      (t) => String(t.mode || '').includes('markers') && (!t.x || t.x.length === 0),
    );
    assert.deepEqual(
      empty.map((t) => t.name), [],
      'пустой маркерный трэк уедет в WebGL нулевыми буферами (uniform3fv)',
    );
    assert.ok(traces.some((t) => String(t.name).startsWith('★')), 'нет трэка звёзд');
  } finally {
    await map.cleanup();
  }
});

maybe('наведение подсвечивает маркер через restyle, а не перерисовкой фигуры', async () => {
  const map = await renderMap(SOL);
  try {
    const planets = map.calls.react[0].traces.findIndex((t) => t.name === 'Планеты');
    assert.ok(planets >= 0, 'нет трэка планет');
    const baseSizes = map.calls.react[0].traces[planets].marker.size.slice();

    const before = map.calls.react.length;
    map.calls.restyle.length = 0;
    await map.fire('plotly_hover', {
      points: [{ curveNumber: planets, pointNumber: 0, customdata: 'Earth' }],
    });

    // Главное: фигуру не пересобираем — иначе камера пользователя сбросится.
    assert.equal(map.calls.react.length, before,
      'наведение перерисовало фигуру — камера уйдёт в стандартный обзор');
    assert.ok(map.calls.restyle.length >= 1, 'подсветка наведением не сработала');

    const sizes = map.calls.restyle[0].update['marker.size'][0];
    assert.equal(sizes.length, baseSizes.length, 'размеров стало не столько же, сколько точек');
    assert.ok(sizes[0] > baseSizes[0], 'наведённый маркер не увеличен');
    assert.deepEqual(map.calls.restyle[0].curves, [planets], 'restyle ушёл не в тот трэк');
  } finally {
    await map.cleanup();
  }
});

maybe('снятие наведения возвращает исходные размеры', async () => {
  const map = await renderMap(SOL);
  try {
    const planets = map.calls.react[0].traces.findIndex((t) => t.name === 'Планеты');
    const baseSizes = map.calls.react[0].traces[planets].marker.size.slice();

    await map.fire('plotly_hover', {
      points: [{ curveNumber: planets, pointNumber: 0, customdata: 'Earth' }],
    });
    map.calls.restyle.length = 0;
    await map.fire('plotly_unhover', {});

    const restored = map.calls.restyle
      .filter((c) => c.curves.includes(planets))
      .map((c) => c.update['marker.size'][0])
      .pop();
    assert.ok(restored, 'unhover не вернул размеры трэку планет');
    assert.deepEqual(restored, baseSizes, 'размеры после unhover не совпали с исходными');
  } finally {
    await map.cleanup();
  }
});

maybe('камера пользователя переживает перерисовку, не связанную со сменой вида', async () => {
  const map = await renderMap(SOL);
  try {
    const userEye = { x: 0.11, y: -2.4, z: 1.7 };
    map.setLiveCamera(userEye);

    // Перерисовка по причине, не входящей в сигнатуру вида: наведение раньше
    // было именно таким поводом. Берём любой повторный прогон эффекта через
    // смену подписей — она виду не принадлежит.
    const before = map.calls.react.length;
    await map.fire('plotly_hover', {
      points: [{ curveNumber: 0, pointNumber: 0, customdata: 'Sol' }],
    });
    await map.fire('plotly_unhover', {});

    if (map.calls.react.length > before) {
      const camera = map.calls.react[map.calls.react.length - 1].layout.scene.camera;
      assert.deepEqual(camera.eye, userEye, 'перерисовка сбросила камеру пользователя');
    }
  } finally {
    await map.cleanup();
  }
});
