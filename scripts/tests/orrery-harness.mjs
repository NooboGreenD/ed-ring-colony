/**
 * Общая обвязка тестов интерфейса 3D-карты системы.
 *
 * Компонент «карта + панели» (`SystemMap/SystemOrrery3D`) отделён от движка
 * three.js: сцену поднимает `@/lib/orrery3d/viewer`, который компонент
 * подгружает динамическим импортом. Тесты интерфейса подменяют этот модуль
 * подставным вьюером — тогда jsdom не нужен WebGL, а проверять можно ровно то,
 * что видит пользователь: кнопки, фильтры, список тел и карточки.
 *
 * Сам движок (сцена, камера, наведение лучом) проверяется без jsdom в
 * `system-orrery-3d.test.mjs`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ROOT_DIR = ROOT;

/** Исходник подставного вьюера: пишется в ту же временную папку, что и бандл. */
const VIEWER_STUB = `
type Any = any;

export const calls: Any[] = [];
export const stub = {
  installed: 0,
  disposed: 0,
  payloads: [] as Any[],
  options: null as Any,
  sceneAvailable: true,
};
const listeners: Record<string, Set<(value: Any) => void>> = {
  select: new Set(), hover: new Set(), state: new Set(),
};
let state: Any = {
  focus: '', zoom: 0, view: 'iso', filter: 'all', labels: 'auto',
  layers: { grid: true, orbits: true, moonOrbits: true, zones: true, rings: true, structures: true, moons: true, player: true },
  playing: false, speed: 1, timeDays: 0,
};

export function resetStub() {
  calls.length = 0;
  stub.installed = 0;
  stub.disposed = 0;
  stub.payloads.length = 0;
  stub.options = null;
  stub.sceneAvailable = true;
  state = {
    focus: '', zoom: 0, view: 'iso', filter: 'all', labels: 'auto',
    layers: { grid: true, orbits: true, moonOrbits: true, zones: true, rings: true, structures: true, moons: true, player: true },
    playing: false, speed: 1, timeDays: 0,
  };
}

/** Сообщить компоненту, что пользователь навёл курсор/кликнул по объекту. */
export function emitHover(pick: Any) { for (const fn of listeners.hover) fn(pick); }
export function emitSelect(pick: Any) { for (const fn of listeners.select) fn(pick); }
export function emitState(patch: Any) {
  state = { ...state, ...patch };
  for (const fn of listeners.state) fn({ ...state });
}
export function currentState() { return { ...state }; }

function push(name: string, ...args: Any[]) { calls.push([name, ...args]); }
function notify() { for (const fn of listeners.state) fn({ ...state }); }

export function createOrreryViewer(container: Any, payload: Any, options: Any = {}) {
  stub.installed += 1;
  stub.options = options;
  stub.payloads.push(payload);
  state = {
    ...state,
    focus: options.focus ?? '',
    zoom: options.zoom ?? 0,
    view: options.view ?? 'iso',
    filter: options.filter ?? 'all',
    labels: options.labels ?? 'auto',
  };
  if (options.onState) listeners.state.add(options.onState);
  if (options.onSelect) listeners.select.add(options.onSelect);
  if (options.onHover) listeners.hover.add(options.onHover);
  push('create', payload.system);
  return {
    setPayload(next: Any, opts: Any = {}) {
      push('setPayload', next, opts);
      payload = next;
      if (!state.focus) state.focus = options.focus ?? '';
    },
    focus(target: string, zoom?: number) { push('focus', target, zoom); state.focus = target; if (zoom != null) state.zoom = zoom; notify(); },
    setZoom(zoom: number) { push('setZoom', zoom); state.zoom = zoom; notify(); },
    setView(view: string) { push('setView', view); state.view = view; notify(); },
    setLayer(layer: string, visible: boolean) { push('setLayer', layer, visible); notify(); },
    setLayers(layers: Any) { push('setLayers', layers); },
    getLayers: () => ({ ...state.layers }),
    setFilter(filter: string) { push('setFilter', filter); state.filter = filter; notify(); },
    setLabels(mode: string) { push('setLabels', mode); state.labels = mode; notify(); },
    setMotion(playing: boolean, speed?: number) { push('setMotion', playing, speed); state.playing = playing; if (speed != null) state.speed = speed; notify(); },
    resetTime() { push('resetTime'); state.timeDays = 0; notify(); },
    fit() { push('fit'); state.focus = ''; state.zoom = 0; notify(); },
    getState: () => ({ ...state }),
    getScene: () => (stub.sceneAvailable ? { parts: {} } : null),
    on(event: string, handler: (value: Any) => void) { listeners[event].add(handler); return () => listeners[event].delete(handler); },
    dispose() { push('dispose'); stub.disposed += 1; },
  };
}

export function viewerStyles() { return ''; }
export function injectViewerStyles() { return undefined; }
export function bodyTooltipHtml() { return ''; }
export function structureTooltipHtml() { return ''; }
`;

/**
 * Собрать компонент карты и отрисовать его в jsdom с подставным вьюером.
 *
 * Возвращает инструменты для теста: поиск элементов, клики, ввод, события
 * вьюера и записанные вызовы (`viewerCalls`).
 */
export async function renderOrreryMap(props = {}) {
  const { sceneAvailable = true, structures, projects, ...componentProps } = props;
  const esbuild = await import('esbuild');
  const jsdomMod = await import('jsdom');
  const { writeFileSync } = await import('node:fs');

  // Бандл обязательно внутри репозитория: react помечен external, и Node
  // ищет его в `node_modules` вверх от файла, а в /tmp такой папки нет.
  const dir = mkdtempSync(join(ROOT, '.tmp-orrery-ui-'));
  const entry = join(dir, 'entry.tsx');
  const bundle = join(dir, 'bundle.mjs');
  const stubPath = join(dir, 'viewer-stub.ts');
  writeFileSync(stubPath, VIEWER_STUB);
  writeFileSync(
    entry,
    "export { default as SystemOrrery3D } from '@/components/SystemMap/SystemOrrery3D';\n"
    + "export { calls, stub, resetStub, emitHover, emitSelect, emitState, currentState } from './viewer-stub';\n"
    + "export { buildOrreryView } from '@/lib/orrery3d/payload';\n"
    + "export { buildOrreryLayout, toStructures } from '@/lib/systemOrrery';\n",
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client'],
    alias: {
      '@/lib/orrery3d/viewer': stubPath,
      '@': join(ROOT, 'src'),
    },
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    logLevel: 'silent',
  });

  const { JSDOM } = jsdomMod;
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/system/Sol',
  });
  const prev = {
    window: global.window, document: global.document, HTMLElement: global.HTMLElement,
    Element: global.Element, Node: global.Node, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
    navigator: global.navigator, requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame, getComputedStyle: global.getComputedStyle,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.getComputedStyle = dom.window.getComputedStyle;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  const raf = (callback) => setTimeout(() => callback(Date.now()), 0);
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = raf;

  const mod = await import(bundle);
  mod.resetStub();
  if (!sceneAvailable) mod.stub.sceneAvailable = false;
  const preparedStructures = structures ?? (projects ? mod.toStructures(projects) : undefined);
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async (ms = 20) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  await act(async () => {
    root.render(React.createElement(mod.SystemOrrery3D, {
      systemName: 'Sol',
      ...componentProps,
      ...(preparedStructures ? { structures: preparedStructures } : {}),
    }));
  });
  await flush(30);

  const document = dom.window.document;
  const click = async (element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await flush(10);
  };
  const setSelect = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush(10);
  };
  const typeInto = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(10);
  };

  const text = () => document.body.textContent || '';
  const buttons = () => Array.from(document.querySelectorAll('button'));
  const button = (pattern) => buttons().find((item) => (typeof pattern === 'string'
    ? item.textContent === pattern
    : pattern.test(item.textContent || '')));
  /** Кнопка по всплывающей подсказке — она у каждой кнопки своя и не меняется. */
  const matches = (pattern, value) => (typeof pattern === 'string'
    ? value === pattern
    : pattern.test(value));
  const buttonByTitle = (pattern) => buttons().find((item) => matches(pattern, item.getAttribute('title') || ''));
  const select = (title) => Array.from(document.querySelectorAll('select'))
    .find((item) => (item.getAttribute('title') || '') === title);

  return {
    mod,
    dom,
    document,
    root,
    text,
    buttons,
    button,
    buttonByTitle,
    select,
    click,
    setSelect,
    typeInto,
    flush,
    /** Вызовы подставного вьюера: [имя, ...аргументы]. */
    viewerCalls: mod.calls,
    viewerCall: (name) => mod.calls.filter((entry) => entry[0] === name),
    emitHover: mod.emitHover,
    emitSelect: mod.emitSelect,
    emitState: mod.emitState,
    currentState: mod.currentState,
    stub: mod.stub,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, value] of Object.entries(prev)) {
        if (key === 'navigator') continue;  // в Node это read-only аксессор
        try {
          if (value === undefined) delete global[key];
          else global[key] = value;
        } catch {
          // Свойство объявлено только для чтения — оставляем как есть.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Собрать настоящие модули движка (без подставного вьюера) — для проверки
 * подсказок, пакета данных и раскладки там, где jsdom не нужен.
 */
export async function loadEngineModules() {
  const esbuild = await import('esbuild');
  const dir = mkdtempSync(join(ROOT, '.tmp-orrery-mods-'));
  const entry = join(dir, 'entry.ts');
  const bundle = join(dir, 'engine.mjs');
  writeFileSync(
    entry,
    "export { bodyTooltipHtml, structureTooltipHtml } from '@/lib/orrery3d/viewer';\n"
    + "export { buildOrreryView } from '@/lib/orrery3d/payload';\n"
    + "export { buildOrreryLayout, toStructures, habitableZoneLs } from '@/lib/systemOrrery';\n",
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: { '@': join(ROOT, 'src') },
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });
  const module = await import(bundle);
  return {
    ...module,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Тела системы для тестов: звезда, землеподобная планета с луной, газовый гигант. */
export function solBodies() {
  return [
    {
      body_name: 'Sol', body_type: 'Star', sub_type: 'G (Yellow) Star', body_id: 1,
      radius_m: 6.957e8, surface_temp_k: 5778, distance_ls: 0, semi_major_axis_ls: 0,
    },
    {
      body_name: 'Sol 1', body_type: 'Planet', sub_type: 'Icy body', body_id: 2,
      radius_m: 4.1e6, distance_ls: 120, semi_major_axis_ls: 120, parents: [{ Star: 1 }],
    },
    {
      body_name: 'Sol 3', body_type: 'Planet', sub_type: 'Earthlike body', body_id: 3,
      radius_m: 6.371e6, distance_ls: 600, semi_major_axis_ls: 600,
      surface_temp_k: 288, gravity: 9.807, is_landable: true, bio_signals_count: 2,
      parents: [{ Star: 1 }], first_discovered_by: 'Тестировщик',
    },
    {
      body_name: 'Sol 3 a', body_type: 'Moon', sub_type: 'Rocky body', body_id: 4,
      radius_m: 1.7e6, distance_ls: 604, semi_major_axis_ls: 4,
      parents: [{ Planet: 3 }], is_landable: true,
    },
    {
      body_name: 'Sol 5', body_type: 'Planet', sub_type: 'Gas giant', body_id: 5,
      radius_m: 7.1e7, distance_ls: 3200, semi_major_axis_ls: 3200,
      parents: [{ Star: 1 }], rings: [{ name: 'Sol 5 A Ring', ringClass: 'Icy' }],
    },
  ];
}

/** Двойная система: два кластера тел — для проверки навигации по звёздам. */
export function binaryBodies() {
  return [
    {
      body_name: 'Alpha', body_type: 'Star', sub_type: 'K (Yellow-Orange) Star', body_id: 1,
      radius_m: 6.0e8, surface_temp_k: 5000, distance_ls: 0,
    },
    {
      body_name: 'Alpha B', body_type: 'Star', sub_type: 'M (Red dwarf) Star', body_id: 2,
      radius_m: 2.0e8, surface_temp_k: 3000, distance_ls: 900, semi_major_axis_ls: 900,
      parents: [{ Star: 1 }],
    },
    {
      body_name: 'Alpha 2', body_type: 'Planet', sub_type: 'Rocky body', body_id: 3,
      radius_m: 5e6, distance_ls: 300, semi_major_axis_ls: 300, parents: [{ Star: 1 }],
    },
    {
      body_name: 'Alpha B 1', body_type: 'Planet', sub_type: 'Ice world', body_id: 4,
      radius_m: 6e6, distance_ls: 1200, semi_major_axis_ls: 300, parents: [{ Star: 2 }],
    },
  ];
}

/** Постройки для тестов: активная стройка с грузом и готовая станция. */
export function solStructures() {
  return [
    {
      buildId: 'build-1', buildName: 'Стройка «Заря»', buildType: 'Planetary Outpost',
      bodyName: 'Sol 3', progress: 29, totalRequired: 12000, totalProvided: 3500,
      resources: [
        { name: 'Сталь', required: 8000, provided: 4000 },
        { name: 'Титан', required: 4000, provided: 500 },
      ],
    },
    {
      buildId: 'build-2', buildName: 'Готовый порт', buildType: 'Coriolis Starport',
      bodyName: 'Sol 5', progress: 100, totalRequired: 0, totalProvided: 0, resources: [],
    },
  ];
}
