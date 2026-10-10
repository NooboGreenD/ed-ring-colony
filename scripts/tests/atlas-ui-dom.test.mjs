/**
 * Интерактивные проверки новых элементов Atlas и меню в jsdom.
 *
 * Сборка — тем же приёмом, что в `architect-ui.test.mjs`: esbuild собирает
 * компоненты, `next/link`, `next/navigation` и `next/dynamic` подменяются
 * заглушками, сеть — подставным `fetch`.
 *
 * 1. Автодополнение систем: каталог Spansh, откат на EDSM, выбор по Enter,
 *    история последних систем.
 * 2. Общее состояние Atlas: избранное, добавленное из списка кандидатов,
 *    сразу видно в блоке «Избранное» (раньше это были разные хуки и список
 *    не обновлялся), а гость не получает ошибку — запись остаётся локальной.
 * 3. Меню: пункт Atlas, фильтр пунктов, мобильный drawer и закрытие по Escape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Заглушка <Link> обязана пробрасывать aria-атрибуты: именно по aria-current
// проверяется подсветка активного раздела меню.
const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { children, href, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;

// Заглушка навигации ведёт себя как настоящий роутер: replace/push меняют
// адрес и уведомляют подписчиков, а useSearchParams отдаёт стабильный объект,
// иначе эффект «вкладка следует за URL» на каждом рендере возвращал бы
// активную вкладку к значению из адресной строки.
const NEXT_NAV_STUB = `
import * as React from 'react';
const listeners = new Set();
let cacheKey = null;
let cacheValue = new URLSearchParams('');
function subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }
function getSnapshot() {
  const search = globalThis.__search || '';
  if (cacheKey !== search) { cacheKey = search; cacheValue = new URLSearchParams(search); }
  return cacheValue;
}
const getPathname = () => globalThis.__pathname || '/atlas';
export function usePathname() { return React.useSyncExternalStore(subscribe, getPathname, getPathname); }
export function useRouter() {
  const record = (kind) => (url) => {
    (globalThis.__nav ||= []).push(kind + ' ' + url);
    try {
      const parsed = new URL(url, 'http://localhost');
      globalThis.__pathname = parsed.pathname;
      globalThis.__search = parsed.search.startsWith('?') ? parsed.search.slice(1) : '';
    } catch {}
    listeners.forEach((callback) => callback());
  };
  return { push: record('push'), replace: record('replace'), refresh() {}, back() {} };
}
export function useSearchParams() { return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot); }
export function useParams() { return {}; }
`;

const NEXT_DYNAMIC_STUB = `
export default function dynamic() { return function DynamicStub() { return null; }; }
`;

async function renderAtlas(ui, options = {}) {
  const esbuild = await import('esbuild');
  const { JSDOM } = await import('jsdom');

  const dir = mkdtempSync(join(ROOT, '.tmp-atlas-ui-'));
  writeFileSync(join(dir, 'next-link.tsx'), NEXT_LINK_STUB);
  writeFileSync(join(dir, 'next-navigation.ts'), NEXT_NAV_STUB);
  writeFileSync(join(dir, 'next-dynamic.ts'), NEXT_DYNAMIC_STUB);
  const entry = join(dir, 'entry.tsx');
  writeFileSync(entry, [
    "export { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';",
    "export { AtlasProvider, useAtlas } from '@/components/Atlas/AtlasContext';",
    "export { AtlasFavorites } from '@/components/Atlas/AtlasFavorites';",
    "export { AtlasCandidateList } from '@/components/Atlas/AtlasCandidateList';",
    "export { AtlasSearchHistory } from '@/components/Atlas/AtlasSearchHistory';",
    "export { default as Sidebar } from '@/components/Sidebar';",
    "export { I18nProvider } from '@/lib/i18n/I18nContext';",
    "export { default as AtlasPage } from '@/app/atlas/page';",
  ].join('\n'));

  const bundle = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client'],
    alias: {
      'next/link': join(dir, 'next-link.tsx'),
      'next/navigation': join(dir, 'next-navigation.ts'),
      'next/dynamic': join(dir, 'next-dynamic.ts'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    logLevel: 'silent',
  });

  const calls = [];
  const previousFetch = global.fetch;
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  global.fetch = async (url, init) => {
    const target = String(url);
    calls.push(`${init?.method ?? 'GET'} ${target}`);
    if (options.api) {
      const custom = options.api(target, init);
      if (custom) return json(custom.body, custom.status ?? 200);
    }
    return json({});
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: options.url ?? 'http://localhost/atlas',
  });
  const previous = {
    nav: globalThis.__nav,
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
    Element: global.Element,
    Node: global.Node,
    localStorage: global.localStorage,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
    getComputedStyle: global.getComputedStyle,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.localStorage = dom.window.localStorage;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.getComputedStyle = dom.window.getComputedStyle;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  const raf = (callback) => setTimeout(() => callback(Date.now()), 0);
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = raf;
  globalThis.__nav = [];
  globalThis.__pathname = options.url ? new URL(options.url).pathname : '/atlas';
  globalThis.__search = options.url && new URL(options.url).search.startsWith('?')
    ? new URL(options.url).search.slice(1)
    : '';

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const mod = await import(bundle);

  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async (ms = 20) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  const render = async (element) => {
    await act(async () => { root.render(element); });
    await flush(30);
  };
  const document = dom.window.document;
  const text = () => document.body.textContent || '';
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush(20);
  };
  const typeInto = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(10);
  };
  const focusOn = async (element) => {
    await act(async () => { element.focus(); });
    await flush(15);
  };
  const keyOn = async (element, key) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    });
    await flush(25);
  };

  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'navigator') Object.defineProperty(global, 'navigator', { value, configurable: true });
      else if (value === undefined) delete global[key];
      else global[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    React, mod, render, document, text, click, typeInto, focusOn, keyOn, flush, cleanup, calls, dom, act,
    nav: () => globalThis.__nav,
    inputByLabel: (label) => Array.from(dom.window.document.querySelectorAll(`.atlas-system-search label`))
      .find((item) => (item.textContent || '').trim() === label)?.parentElement?.querySelector('input') || null,
  };
}

const CATALOG_RESULTS = [
  { id64: 10477373803, name: 'Sol', x: 0, y: 0, z: 0, main_star: 'G (White-Yellow) Star', star_type: 'G', needs_permit: true, distance_from_sols: 0, distance_from_sgra: 25899.97 },
  { id64: 5, name: 'Solati', x: 12, y: 3, z: 40, main_star: 'K Star', star_type: 'K', needs_permit: false, distance_from_sols: 42.1, distance_from_sgra: 25860.4 },
];

test('автодополнение систем: подсказки каталога, выбор по Enter и история', async () => {
  const ui = await renderAtlas(null, {
    api: (target) => (target.includes('/api/galaxy/systems/search') ? { body: { results: CATALOG_RESULTS } } : null),
  });
  try {
    const changes = [];
    function Harness() {
      const [value, setValue] = ui.React.useState('');
      return ui.React.createElement(ui.mod.SystemSearchInput, {
        value,
        label: 'Система отсчёта',
        onChange: (next) => { changes.push(next); setValue(next); },
      });
    }
    await ui.render(ui.React.createElement(Harness));

    const input = ui.document.querySelector('input');
    assert.ok(input, 'поле ввода отрисовано');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-expanded'), 'false');

    await ui.typeInto(input, 'Sol');
    await ui.flush(320);

    assert.ok(
      ui.calls.some((call) => call.includes('/api/galaxy/systems/search?q=Sol')),
      `каталог систем не запрошен: ${ui.calls.join(', ')}`,
    );
    const options = Array.from(ui.document.querySelectorAll('[role="option"]'));
    assert.equal(options.length, 2, 'показаны две подсказки каталога');
    assert.match(options[0].textContent || '', /Sol/);
    assert.match(ui.document.querySelector('.atlas-system-meta')?.textContent || '', /Sol: 0 св\.л\./);
    assert.equal(input.getAttribute('aria-expanded'), 'true');

    await ui.keyOn(input, 'ArrowDown');
    await ui.keyOn(input, 'Enter');
    assert.equal(changes.at(-1), 'Sol', 'Enter выбирает подсказку из списка');
    assert.equal(ui.document.querySelectorAll('[role="option"]').length, 0, 'список закрылся после выбора');

    const recent = JSON.parse(ui.dom.window.localStorage.getItem('atlas:recent-systems') || '[]');
    assert.deepEqual(recent.slice(0, 1), ['Sol'], 'выбранная система попала в историю');
  } finally {
    await ui.cleanup();
  }
});

test('автодополнение систем: пустой каталог уходит на EDSM, ошибка не блокирует ввод', async () => {
  const ui = await renderAtlas(null, {
    api: (target) => {
      if (target.includes('/api/galaxy/systems/search')) return { body: { results: [] } };
      if (target.includes('/api/edsm/search')) return { body: { systems: [{ id: 7, name: 'Colonia', coords: { x: -9530, y: -910, z: 19800 }, distance: 22000, requirePermit: false }] } };
      return null;
    },
  });
  try {
    function Harness() {
      const [value, setValue] = ui.React.useState('Colo');
      return ui.React.createElement(ui.mod.SystemSearchInput, { value, onChange: setValue });
    }
    await ui.render(ui.React.createElement(Harness));
    const input = ui.document.querySelector('input');
    await ui.focusOn(input); // фокус открывает список подсказок
    await ui.flush(320);

    assert.ok(ui.calls.some((call) => call.includes('/api/edsm/search?q=Colo')), 'нет отката на EDSM');
    const options = Array.from(ui.document.querySelectorAll('[role="option"]'));
    assert.ok(options.some((option) => /Colonia/.test(option.textContent || '')));
  } finally {
    await ui.cleanup();
  }
});

test('общее состояние Atlas: избранное из списка кандидатов сразу видно в панели', async () => {
  const ui = await renderAtlas(null, {
    api: (target, init) => {
      if (target.includes('/api/atlas/favorites') && (init?.method ?? 'GET') === 'GET') {
        return { status: 401, body: { error: 'Unauthorized' } };
      }
      if (target.includes('/api/atlas/favorites') && init?.method === 'POST') {
        return { status: 401, body: { error: 'Unauthorized' } };
      }
      if (target.includes('/api/atlas/sessions')) return { status: 401, body: { error: 'Unauthorized' } };
      return { body: {} };
    },
  });
  try {
    const candidates = [
      { id: 'c1', search_id: 's1', system_name: 'Solati', x: 1, y: 2, z: 3, world_type: 'earth_like', distance_from_ref: 12.5, estimated_value: 250000, created_at: new Date().toISOString() },
    ];
    function Harness() {
      const [rows] = ui.React.useState(candidates);
      return ui.React.createElement(
        ui.mod.AtlasProvider,
        null,
        ui.React.createElement(ui.mod.AtlasCandidateList, { candidates: rows, onSelect: () => {} }),
        ui.React.createElement(ui.mod.AtlasFavorites, { onSelect: () => {} }),
      );
    }
    await ui.render(ui.React.createElement(Harness));
    assert.match(ui.text(), /Solati/, 'кандидат отрисован');

    const favButton = Array.from(ui.document.querySelectorAll('button'))
      .find((button) => (button.getAttribute('title') || '').includes('Добавить в избранное'));
    assert.ok(favButton, 'у кандидата есть кнопка избранного');
    await ui.click(favButton);
    await ui.flush(40);

    assert.ok(
      ui.calls.some((call) => call.startsWith('POST /api/atlas/favorites')),
      'гость всё равно пытается сохранить в профиль',
    );
    const favPanel = Array.from(ui.document.querySelectorAll('.atlas-fav-item'));
    assert.equal(favPanel.length, 1, 'запись появилась в панели «Избранное» без перезагрузки');
    assert.match(favPanel[0].textContent || '', /Solati/);
    assert.match(ui.text(), /ИЗБРАННОЕ|Избранное/, 'панель избранного осталась на месте');
  } finally {
    await ui.cleanup();
  }
});

test('список кандидатов: фильтр, сортировка и счётчик', async () => {
  const ui = await renderAtlas(null, {});
  try {
    const candidates = [
      { id: 'c1', search_id: 's1', system_name: 'Alpha', x: 1, y: 2, z: 3, world_type: 'earth_like', distance_from_ref: 30, estimated_value: 100, created_at: '' },
      { id: 'c2', search_id: 's1', system_name: 'Beta', x: 4, y: 5, z: 6, world_type: 'water_world', distance_from_ref: 10, estimated_value: 900, created_at: '' },
      { id: 'c3', search_id: 's1', system_name: 'Gamma', x: 7, y: 8, z: 9, world_type: 'earth_like', distance_from_ref: 20, estimated_value: 500, created_at: '' },
    ];
    await ui.render(ui.React.createElement(
      ui.mod.AtlasProvider,
      null,
      ui.React.createElement(ui.mod.AtlasCandidateList, { candidates, onSelect: () => {}, total: 3 }),
    ));

    const rows = () => Array.from(ui.document.querySelectorAll('.atlas-candidate-item'));
    assert.equal(rows().length, 3);
    assert.match(rows()[0].textContent || '', /Beta/, 'по умолчанию сначала ближние');

    await ui.click(ui.document.querySelector('.atlas-toggle-btn'));
    assert.match(ui.text(), /Ничего не найдено по фильтру/, 'пустое избранное даёт честное сообщение');
    await ui.click(ui.document.querySelector('.atlas-toggle-btn'));
    assert.equal(rows().length, 3);

    const filterInput = Array.from(ui.document.querySelectorAll('input')).find((input) => input.getAttribute('aria-label') === 'Фильтр кандидатов');
    assert.ok(filterInput, 'есть поле фильтра');
    await ui.typeInto(filterInput, 'gamma');
    assert.equal(rows().length, 1, 'фильтр оставил одну строку');
    assert.match(ui.text(), /Показано 1 из 1/);
  } finally {
    await ui.cleanup();
  }
});

test('история поисков: гость видит подсказку войти, а локальные поиски — в списке', async () => {
  const ui = await renderAtlas(null, {
    api: (target) => {
      if (target.includes('/api/atlas/sessions')) return { status: 401, body: { error: 'Unauthorized' } };
      return { body: {} };
    },
  });
  try {
    await ui.render(ui.React.createElement(
      ui.mod.I18nProvider,
      null,
      ui.React.createElement(
        ui.mod.AtlasProvider,
        null,
        ui.React.createElement(ui.mod.AtlasSearchHistory, { onSelectSession: () => {} }),
      ),
    ));
    assert.match(ui.text(), /История поисков/, 'блок истории отрисован');
    assert.match(ui.text(), /Войдите в профиль/, 'гостю объяснили, что история серверная');
    assert.match(ui.calls.join(' '), /GET \/api\/atlas\/sessions/, 'запрос истории сделан один раз из провайдера');
  } finally {
    await ui.cleanup();
  }
});

test('меню: Atlas на месте, фильтр ищет пункты, drawer закрывается по Escape', async () => {
  const ui = await renderAtlas(null, {});
  try {
    await ui.render(ui.React.createElement(ui.mod.I18nProvider, null, ui.React.createElement(ui.mod.Sidebar)));

    const links = Array.from(ui.document.querySelectorAll('a.sidebar-item'));
    const hrefs = links.map((link) => link.getAttribute('href'));
    assert.ok(hrefs.includes('/atlas'), `Atlas отсутствует в боковом меню: ${hrefs.join(', ')}`);
    assert.ok(hrefs.includes('/support'), 'раздел поддержки доступен из меню');
    assert.ok(ui.document.querySelectorAll('.sidebar-group-title').length >= 3, 'пункты сгруппированы по разделам');

    const atlasLink = links.find((link) => link.getAttribute('href') === '/atlas');
    assert.equal(atlasLink.getAttribute('aria-current'), 'page', 'активный раздел подсвечен');
    assert.ok(ui.document.querySelector('.sidebar-subitem'), 'у активного раздела показаны подпункты');

    const filterInput = ui.document.querySelector('.sidebar-search input');
    await ui.typeInto(filterInput, 'магазин');
    // Меню рендерится дважды (боковая панель и drawer), поэтому сравниваем набор.
    const visible = Array.from(ui.document.querySelectorAll('a.sidebar-item')).map((link) => link.getAttribute('href'));
    assert.deepEqual([...new Set(visible)], ['/premium-shop'], 'фильтр оставил только «Магазин»');
    await ui.typeInto(filterInput, 'абракадабра');
    assert.match(ui.text(), /Ничего не найдено/);

    const hamburger = ui.document.querySelector('.hamburger');
    assert.equal(hamburger.getAttribute('aria-expanded'), 'false');
    await ui.click(hamburger);
    assert.equal(hamburger.getAttribute('aria-expanded'), 'true');
    assert.ok(ui.document.querySelector('.sidebar-drawer.open'), 'drawer открылся');
    await ui.keyOn(ui.document, 'Escape');
    assert.ok(!ui.document.querySelector('.sidebar-drawer.open'), 'Escape закрывает меню');
  } finally {
    await ui.cleanup();
  }
});

test('страница Atlas: вкладки, панель поиска и переключение разделов', async () => {
  const ui = await renderAtlas(null, {
    api: (target) => {
      if (target.includes('/api/projects')) return { body: { projects: [{ id: 3, name: 'Тестовая стройка', color: '#e67e22', squadron_id: null }] } };
      if (target.includes('/api/atlas/favorites') || target.includes('/api/atlas/sessions')) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }
      return { body: {} };
    },
  });
  try {
    await ui.render(ui.React.createElement(ui.mod.AtlasPage));

    const tabs = Array.from(ui.document.querySelectorAll('[role="tab"]'));
    assert.equal(tabs.length, 5, 'в панели пять разделов');
    assert.deepEqual(
      tabs.map((tab) => (tab.textContent || '').trim()),
      ['Поиск', 'Маршрут', 'Маршрут A→B', 'Кольцо', 'Рынок'],
      'подписи и порядок вкладок',
    );
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.match(ui.text(), /Поиск миров/, 'по умолчанию открыт поиск миров');
    assert.match(ui.text(), /История поисков/);
    assert.match(ui.text(), /Избранное/);
    assert.match(ui.text(), /Секторы \(42\)/);

    const marketTab = tabs.find((tab) => (tab.textContent || '').includes('Рынок'));
    await ui.click(marketTab);
    assert.equal(marketTab.getAttribute('aria-selected'), 'true');
    assert.match(ui.text(), /Поиск товаров для стройки/, 'вкладка рынка отрисована');
    assert.ok(ui.nav().some((entry) => entry === 'replace /atlas?tab=market'), `URL не обновлён: ${ui.nav().join(', ')}`);

    const routeTab = tabs.find((tab) => (tab.textContent || '').includes('A→B'));
    await ui.click(routeTab);
    assert.match(ui.text(), /Поиск маршрута колонизации/);
    assert.ok(ui.inputByLabel('Точка А (откуда)'), 'поле точки А использует автодополнение');
    assert.ok(ui.inputByLabel('Точка Б (куда)'), 'поле точки Б использует автодополнение');

    const ringTab = tabs.find((tab) => (tab.textContent || '').includes('Кольцо'));
    await ui.click(ringTab);
    assert.match(ui.text(), /Галактическое кольцо колонизации/);

    const projectTab = tabs.find((tab) => (tab.textContent || '').trim() === 'Маршрут');
    await ui.click(projectTab);
    assert.match(ui.text(), /Маршрут проекта/);
    assert.match(ui.text(), /Тестовая стройка|Выберите проект/);
  } finally {
    await ui.cleanup();
  }
});
