/**
 * Навигация 3D-карты системы: клик по телу, переход стрелками, сброс.
 *
 * Тест рендерит НАСТОЯЩИЙ компонент в jsdom против подставного Plotly и
 * проверяет, что пользовательские действия доходят до состояния фокуса, а
 * камера не сбрасывается там, где пользователь её не трогал.
 *
 * Без jsdom/esbuild тест честно пропускается, а не падает.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
let jsdomMod = null;
try {
  esbuild = await import('esbuild');
  jsdomMod = await import('jsdom');
} catch {
  // devDependencies не установлены — пропускаем.
}

const skip = !esbuild || !jsdomMod;
const maybe = skip ? test.skip : test;

async function buildBundle() {
  const dir = mkdtempSync(join(ROOT, '.tmp-navmap-'));
  const entry = join(dir, 'entry.tsx');
  const bundle = join(dir, 'bundle.mjs');
  writeFileSync(entry, "export { default as SystemPlotlyMap } from '@/components/SystemPlotlyMap';\n");
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
  return { dir, bundle };
}

/** Два тела на разных расстояниях — чтобы фокус имел куда перемещаться. */
const BODIES = [
  { body_id: 1, body_name: 'Sol', body_type: 'Star', radius_m: 6.957e8, surface_temp_k: 5778,
    distance_to_arrival_ls: 0, semi_major_axis_ls: 0 },
  { body_id: 2, body_name: 'Earth', body_type: 'Planet', radius_m: 6.371e6,
    distance_to_arrival_ls: 8.3, semi_major_axis_ls: 8.3, orbital_period_days: 365.25,
    eccentricity: 0.0167, orbital_inclination_deg: 0, periapsis_deg: 102, mean_anomaly_deg: 100 },
  { body_id: 3, body_name: 'Mars', body_type: 'Planet', radius_m: 3.389e6,
    distance_to_arrival_ls: 12.5, semi_major_axis_ls: 12.5, orbital_period_days: 687,
    eccentricity: 0.0934, orbital_inclination_deg: 1.85, periapsis_deg: 286, mean_anomaly_deg: 19 },
];

async function renderMap() {
  const { dir, bundle } = await buildBundle();
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
  global.getComputedStyle = dom.window.getComputedStyle;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = raf;

  const calls = { react: [], relayout: [] };
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
    restyle() { return Promise.resolve(); },
    relayout(_node, update) { calls.relayout.push(update); return Promise.resolve(); },
    purge() { return Promise.resolve(); },
  };

  const focusChanges = [];
  const { SystemPlotlyMap } = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(SystemPlotlyMap, {
      systemName: 'Sol',
      initialBodies: BODIES,
      onFocusChange: (name) => focusChanges.push(name),
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 25)); });

  return {
    calls,
    handlers,
    focusChanges,
    act,
    dom,
    /** Камера последней отрисовки. */
    lastCamera: () => calls.react[calls.react.length - 1]?.layout?.scene?.camera,
    /** Камера, которую Plotly считает текущей (её правит пользователь). */
    setLiveCamera(eye) { gd._fullLayout.scene.camera.eye = eye; },
    liveEye() { return gd._fullLayout.scene.camera.eye; },
    /** Вызвать обработчик Plotly-события. */
    async fire(name, event) {
      await act(async () => {
        handlers[name]?.(event);
        await new Promise((r) => setTimeout(r, 15));
      });
    },
    /** Нажать клавишу в окне. */
    /**
     * Нажать клавишу. По умолчанию событие уходит в `window` — так клавиатура
     * работает, когда фокус не в поле. `element` позволяет проверить реальный
     * случай ввода: тогда `event.target` — само поле, и событие всплывает.
     */
    async key(key, element) {
      await act(async () => {
        const target = element ?? dom.window;
        target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
        await new Promise((r) => setTimeout(r, 15));
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [k, v] of Object.entries(prev)) global[k] = v;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

maybe('карта рисуется по готовым данным', async () => {
  const map = await renderMap();
  try {
    assert.ok(map.calls.react.length > 0, 'Plotly.react не вызван');
  } finally {
    await map.cleanup();
  }
});

maybe('клик по телу фокусирует его', async () => {
  const map = await renderMap();
  try {
    await map.fire('plotly_click', {
      points: [{ curveNumber: 1, pointNumber: 0, customdata: 'Earth' }],
    });
    assert.deepEqual(map.focusChanges, ['Earth'], 'клик не довёл фокус до родителя');
  } finally {
    await map.cleanup();
  }
});

maybe('стрелки переключают тела', async () => {
  const map = await renderMap();
  try {
    await map.key('ArrowRight');
    assert.equal(map.focusChanges.length > 0, true, 'стрелка вправо не сменила цель');
    const first = map.focusChanges[0];
    await map.key('ArrowRight');
    assert.notEqual(map.focusChanges[map.focusChanges.length - 1], first, 'вторая стрелка не переключила тело');
  } finally {
    await map.cleanup();
  }
});

maybe('Escape снимает фокус', async () => {
  const map = await renderMap();
  try {
    await map.key('ArrowRight');
    await map.key('Escape');
    assert.equal(map.focusChanges[map.focusChanges.length - 1], '', 'Escape не сбросил фокус');
  } finally {
    await map.cleanup();
  }
});

maybe('клик по линии орбиты не меняет фокус', async () => {
  // Реальная форма события: у линейных трэков (орбиты, кольца, HZ) стоит
  // `hoverinfo: 'skip'` и нет `customdata` вовсе. Клик по такой линии не должен
  // уводить фокус — иначе карта «прыгает» при попытке повороить сцену.
  const map = await renderMap();
  try {
    await map.fire('plotly_click', {
      points: [{ curveNumber: 4, pointNumber: 0, customdata: undefined, data: {} }],
    });
    assert.deepEqual(map.focusChanges, [], `клик по орбите сменил фокус: ${JSON.stringify(map.focusChanges)}`);
  } finally {
    await map.cleanup();
  }
});

maybe('стрелки не перехватываются, когда пользователь печатает', async () => {
  // Обработчик висит на `window` без проверки активного элемента: стрелка в
  // поле поиска листала тела системы вместо перемещения курсора в тексте.
  const map = await renderMap();
  try {
    const input = map.dom.window.document.createElement('input');
    map.dom.window.document.body.appendChild(input);
    input.focus();
    assert.equal(map.dom.window.document.activeElement, input, 'поле не получило фокус — тест ничего не проверяет');
    await map.key('ArrowRight', input);
    assert.deepEqual(map.focusChanges, [], 'стрелка в поле ввода сменила цель карты');
    // Контроль: вне поля та же стрелка обязана работать.
    await map.key('ArrowRight');
    assert.equal(map.focusChanges.length > 0, true, 'стрелка перестала работать и вне полей ввода');
  } finally {
    await map.cleanup();
  }
});

maybe('наведение не перерисовывает фигуру и не трогает камеру', async () => {
  const map = await renderMap();
  try {
    const eye = { x: 0.4, y: -1.9, z: 0.8 };
    map.setLiveCamera(eye);
    // Инвариант: наведение работает через `restyle`, поэтому `Plotly.react`
    // вызываться не должен вовсе. Именно перерисовка сбрасывала камеру.
    const before = map.calls.react.length;
    await map.fire('plotly_hover', { points: [{ curveNumber: 1, pointNumber: 0, customdata: 'Earth' }] });
    assert.equal(map.calls.react.length, before, 'наведение перерисовало фигуру');
    // Камеру трогать нечем: раз `Plotly.react` не вызывался, layout.scene.camera
    // не переписывался вовсе. Живая камера Plotly осталась нетронутой.
    assert.equal(map.liveEye(), eye, 'живая камера изменена наведением');
  } finally {
    await map.cleanup();
  }
});
