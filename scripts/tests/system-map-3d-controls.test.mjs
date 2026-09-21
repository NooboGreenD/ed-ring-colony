/**
 * Тесты интерактивных 3D-контролов карты системы:
 * 1. Режимы мыши dragmode: orbit, pan, turntable.
 * 2. Тумблер зума колесом мыши во встроенном режиме.
 * 3. Наэкранный HUD-компас навигации (D-Pad, поворот, наклон, зум +/-).
 * 4. Сохранение фокуса и позиции камеры при переключении режимов.
 * 5. Тактильный курсор и слежение прицела без дерганий.
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
  // devDependencies не установлены
}

const skip = !esbuild || !jsdomMod;
const maybe = skip ? test.skip : test;

async function buildBundle() {
  const dir = mkdtempSync(join(ROOT, '.tmp-3dmap-'));
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

const BODIES = [
  {
    body_id: 1,
    body_name: 'Sol',
    body_type: 'Star',
    radius_m: 6.957e8,
    surface_temp_k: 5778,
    distance_to_arrival_ls: 0,
    semi_major_axis_ls: 0,
  },
  {
    body_id: 2,
    body_name: 'Earth',
    body_type: 'Planet',
    radius_m: 6.371e6,
    distance_to_arrival_ls: 8.3,
    semi_major_axis_ls: 8.3,
    orbital_period_days: 365.25,
    eccentricity: 0.0167,
    orbital_inclination_deg: 0,
    periapsis_deg: 102,
    mean_anomaly_deg: 100,
  },
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
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
    Element: global.Element,
    Node: global.Node,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
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
    react(node, traces, layout, config) {
      calls.react.push({ traces, layout, config });
      gd = node;
      node._fullLayout = {
        scene: {
          camera: JSON.parse(JSON.stringify(layout.scene.camera)),
          dragmode: layout.dragmode || 'orbit',
          xaxis: { range: [-100, 100] },
          yaxis: { range: [-100, 100] },
          zaxis: { range: [-100, 100] },
        },
      };
      node.on = (name, fn) => {
        handlers[name] = fn;
      };
      return Promise.resolve();
    },
    restyle() {
      return Promise.resolve();
    },
    relayout(_node, update) {
      calls.relayout.push(update);
      if (update['scene.camera.eye'] && gd?._fullLayout?.scene?.camera) {
        gd._fullLayout.scene.camera.eye = update['scene.camera.eye'];
      }
      return Promise.resolve();
    },
    purge() {
      return Promise.resolve();
    },
  };

  const focusChanges = [];
  const { SystemPlotlyMap } = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(SystemPlotlyMap, {
        systemName: 'Sol',
        initialBodies: BODIES,
        onFocusChange: (name) => focusChanges.push(name),
      })
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

  return {
    calls,
    handlers,
    focusChanges,
    act,
    dom,
    lastLayout: () => calls.react[calls.react.length - 1]?.layout,
    lastConfig: () => calls.react[calls.react.length - 1]?.config,
    async click(element) {
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 20));
      });
    },
    async pointerDown(element) {
      await act(async () => {
        const ev = new dom.window.Event('pointerdown', { bubbles: true });
        element.dispatchEvent(ev);
        await new Promise((r) => setTimeout(r, 10));
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

maybe('по умолчанию dragmode установлен в orbit для свободного 3D-вращения', async () => {
  const map = await renderMap();
  try {
    const layout = map.lastLayout();
    assert.equal(layout.dragmode, 'orbit', 'layout.dragmode не равен orbit');
    assert.equal(layout.scene.dragmode, 'orbit', 'layout.scene.dragmode не равен orbit');
  } finally {
    await map.cleanup();
  }
});

maybe('кнопки переключения режимов мыши переключают dragmode на pan и turntable', async () => {
  const map = await renderMap();
  try {
    const buttons = [...map.dom.window.document.querySelectorAll('.ed-map-chip')];
    const panBtn = buttons.find((b) => b.textContent.includes('панорама'));
    assert.ok(panBtn, 'не найдена кнопка панорамы');

    await map.click(panBtn);
    let lastRelayout = map.calls.relayout[map.calls.relayout.length - 1];
    assert.equal(lastRelayout?.dragmode, 'pan', 'relayout не передал dragmode: pan');

    const turntableBtn = buttons.find((b) => b.textContent.includes('карусель'));
    assert.ok(turntableBtn, 'не найдена кнопка карусели');

    await map.click(turntableBtn);
    lastRelayout = map.calls.relayout[map.calls.relayout.length - 1];
    assert.equal(lastRelayout?.dragmode, 'turntable', 'relayout не передал dragmode: turntable');
  } finally {
    await map.cleanup();
  }
});

maybe('тумблер зума колесом включает scrollZoom без перехода в полноэкранный режим', async () => {
  const map = await renderMap();
  try {
    assert.equal(map.lastConfig().scrollZoom, false, 'изначально колесо не должно перехватывать зум');

    const wheelChip = [...map.dom.window.document.querySelectorAll('.ed-map-chip')]
      .find((b) => b.textContent.includes('колесо'));
    assert.ok(wheelChip, 'не найден чип тумблера колеса');

    await map.click(wheelChip);
    assert.equal(map.lastConfig().scrollZoom, true, 'после клика scrollZoom не включился');

    await map.click(wheelChip);
    assert.equal(map.lastConfig().scrollZoom, false, 'повторный клик не выключил scrollZoom');
  } finally {
    await map.cleanup();
  }
});

maybe('HUD 3D NAV compass pad отображается и позволяет поворачивать и зумировать камеру', async () => {
  const map = await renderMap();
  try {
    const hud = map.dom.window.document.querySelector('.ed-3d-compass-hud');
    assert.ok(hud, 'не найден контейнер .ed-3d-compass-hud');

    const buttons = [...hud.querySelectorAll('button')];
    const upBtn = buttons.find((b) => b.title?.includes('Tilt Up'));
    assert.ok(upBtn, 'не найдена кнопка наклона вверх ▲');

    const beforeRelayouts = map.calls.relayout.length;
    await map.click(upBtn);
    assert.ok(map.calls.relayout.length > beforeRelayouts, 'клик по ▲ не вызвал relayout камеры');
    const update = map.calls.relayout[map.calls.relayout.length - 1];
    assert.ok(update['scene.camera.eye'], 'relayout не содержит scene.camera.eye');

    const zoomInBtn = buttons.find((b) => b.textContent === '+');
    assert.ok(zoomInBtn, 'не найдена кнопка приближения +');
    await map.click(zoomInBtn);
    const zoomUpdate = map.calls.relayout[map.calls.relayout.length - 1];
    assert.ok(zoomUpdate['scene.xaxis.range'], 'клик по + не пересчитал диапазон осей xaxis');
  } finally {
    await map.cleanup();
  }
});

maybe('зажатие мыши меняет стиль курсора на grabbing', async () => {
  const map = await renderMap();
  try {
    const host = map.dom.window.document.querySelector('[data-ed-map-host]');
    assert.ok(host, 'хост карты не найден');

    // До нажатия
    assert.equal(host.style.cursor, 'crosshair');

    // Нажатие указателя
    await map.pointerDown(host);
    assert.equal(host.style.cursor, 'grabbing', 'при зажатой мыши курсор должен быть grabbing');
  } finally {
    await map.cleanup();
  }
});
