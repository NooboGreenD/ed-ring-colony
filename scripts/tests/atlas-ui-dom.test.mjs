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
import { bundleFile } from './helpers/bundle.mjs';
import { EMPTY_POWERPLAY_META, encodePowerplayLayer } from '../../src/lib/powerplay.ts';
import { EMPTY_BGS_META, encodeBgsLayer } from '../../src/lib/bgs.ts';

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

const ENTRY = [
  "export { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';",
  "export { AtlasProvider, useAtlas } from '@/components/Atlas/AtlasContext';",
  "export { AtlasFavorites } from '@/components/Atlas/AtlasFavorites';",
  "export { AtlasCandidateList } from '@/components/Atlas/AtlasCandidateList';",
  "export { AtlasSearchHistory } from '@/components/Atlas/AtlasSearchHistory';",
  "export { default as Sidebar } from '@/components/Sidebar';",
  "export { I18nProvider } from '@/lib/i18n/I18nContext';",
  "export { default as AtlasPage } from '@/app/atlas/page';",
  "export { resetAtlasSearchProgress, readAtlasSearchResult } from '@/lib/atlasSearchProgress';",
  "export { resetPowerplayLayerCache } from '@/hooks/usePowerplayLayer';",
  "export { resetFactionsLayerCache } from '@/hooks/useFactionsLayer';",
].join('\n');

async function renderAtlas(ui, options = {}) {
  const { JSDOM } = await import('jsdom');

  // Сборка страницы Atlas одна на весь файл и лежит в общем кэше: раньше каждый
  // из 16 рендеров заново паковал половину `src`.
  const bundle = await bundleFile({
    entrySource: ENTRY,
    stubs: {
      'next/link': NEXT_LINK_STUB,
      'next/navigation': NEXT_NAV_STUB,
      'next/dynamic': NEXT_DYNAMIC_STUB,
    },
    external: ['react', 'react-dom', 'react-dom/client'],
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
    Event: global.Event,
    CustomEvent: global.CustomEvent,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  // События обязаны быть из того же окна: канал прогресса Atlas шлёт
  // CustomEvent в window, и «родное» событие Node jsdom не принимает.
  global.Event = dom.window.Event;
  global.CustomEvent = dom.window.CustomEvent;
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
    assert.ok(hrefs.includes('/systems'), 'раздел систем доступен из меню');
    assert.ok(ui.document.querySelectorAll('.sidebar-group-title').length >= 3, 'пункты сгруппированы по разделам');
    // Магазин, поддержка и личный кабинет переехали в меню пользователя.
    for (const personal of ['/support', '/premium-shop', '/account']) {
      assert.ok(!hrefs.includes(personal), `${personal} не должен дублироваться в боковом меню`);
    }

    const atlasLink = links.find((link) => link.getAttribute('href') === '/atlas');
    assert.equal(atlasLink.getAttribute('aria-current'), 'page', 'активный раздел подсвечен');
    assert.ok(ui.document.querySelector('.sidebar-subitem'), 'у активного раздела показаны подпункты');
    assert.ok(ui.document.querySelector('.sidebar-group-title.active'), 'группа с активным разделом подсвечена');

    const filterInput = ui.document.querySelector('.sidebar-search input');
    await ui.typeInto(filterInput, 'вики');
    // Меню рендерится дважды (боковая панель и drawer), поэтому сравниваем набор.
    const visible = Array.from(ui.document.querySelectorAll('a.sidebar-item')).map((link) => link.getAttribute('href'));
    assert.deepEqual([...new Set(visible)], ['/wiki'], 'фильтр оставил только «Вики»');
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
    assert.equal(tabs.length, 8, 'в панели восемь разделов');
    assert.deepEqual(
      tabs.map((tab) => (tab.textContent || '').trim()),
      ['Поиск', 'Маршрут', 'Маршрут A→B', 'Кольцо', 'Рынок', 'Поблизости', 'PowerPlay', 'Фракции'],
      'подписи и порядок вкладок',
    );
    assert.match(tabs[7].getAttribute('title'), /Alt\+8/);
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

/* ── Вкладка PowerPlay: системы держав на карте ── */

const PP_ROWS = [
  { id64: '10', name: 'Alpha', x: 0, y: 0, z: 0, power: 'Yuri Grom', state: 'Stronghold', observedAt: '2026-10-16T00:00:00.000Z' },
  { id64: '11', name: 'Beta', x: 10, y: 0, z: 0, power: 'Yuri Grom', state: 'Exploited', observedAt: '2026-10-15T00:00:00.000Z' },
  { id64: '13', name: 'Delta', x: 0, y: 18, z: 0, power: 'Archon Delaine', state: 'Exploited', observedAt: null },
  { id64: '14', name: 'Epsilon', x: 100, y: 0, z: 0, power: 'Yuri Grom', state: 'Fortified', observedAt: null },
  { id64: '12', name: 'Gamma', x: 25, y: 0, z: 0, power: 'Archon Delaine', state: 'Fortified', observedAt: '2026-10-14T00:00:00.000Z' },
];

test('страница Atlas: вкладка PowerPlay — фильтр держав и состояний, список и «Чья зона?»', async () => {
  const layer = encodePowerplayLayer(PP_ROWS, {
    ...EMPTY_POWERPLAY_META,
    dumpGeneratedAt: '2026-10-17T02:46:06.000Z',
    syncedAt: '2026-10-17T05:20:00.000Z',
    oldestObservation: '2026-10-14T00:00:00.000Z',
    newestObservation: '2026-10-16T00:00:00.000Z',
  }, 'run-1');
  const ui = await renderAtlas(null, {
    url: 'http://localhost/atlas?tab=powerplay',
    api: (target) => {
      if (target.includes('/api/powerplay/systems')) return { body: layer };
      if (target.includes('/api/galaxy/systems/by-name')) return { body: { name: 'Colony Target', x: 6, y: 0, z: 0 } };
      if (target.includes('/api/projects')) return { body: { projects: [] } };
      if (target.includes('/api/atlas/favorites') || target.includes('/api/atlas/sessions')) return { status: 401, body: { error: 'Unauthorized' } };
      return { body: {} };
    },
  });
  const focused = [];
  const onFocus = (event) => focused.push(event.detail?.name);
  try {
    ui.mod.resetPowerplayLayerCache();
    ui.dom.window.addEventListener('atlas-focus-powerplay', onFocus);
    await ui.render(ui.React.createElement(ui.mod.AtlasPage));
    await ui.flush(60);
    const doc = ui.document;

    const tab = Array.from(doc.querySelectorAll('[role="tab"]')).find((item) => (item.textContent || '').includes('PowerPlay'));
    assert.equal(tab.getAttribute('aria-selected'), 'true', 'вкладка открыта по ?tab=powerplay');
    assert.match(ui.text(), /PowerPlay: системы держав/);
    assert.ok(ui.calls.some((call) => call === 'GET /api/powerplay/systems'), `набор не запрошен: ${ui.calls.join(', ')}`);

    // Первый визит сам включает слой и запоминает это.
    const toggle = doc.querySelector('.powerplay-toggle input');
    assert.equal(toggle.checked, true);
    assert.equal(JSON.parse(ui.dom.window.localStorage.getItem('atlas-powerplay-v1')).visible, true);
    assert.match(ui.text(), /Дамп EDSM от 17\.10\.2026 · наблюдения 14\.10\.2026–16\.10\.2026/);
    // Плашка состояния говорит прямо: данные загружены, сколько и от какого числа.
    const statusCard = doc.querySelector('[data-powerplay-status]');
    assert.equal(statusCard.getAttribute('data-powerplay-status'), 'ready');
    assert.match(statusCard.textContent, /Загружено 5 систем · держав: 2/);

    // В фильтре все двенадцать держав PowerPlay 2.0: с системами — первыми, по числу систем.
    const powers = () => Array.from(doc.querySelectorAll('.powerplay-power')).map((item) => item.getAttribute('data-power'));
    assert.deepEqual(powers().slice(0, 2), ['Yuri Grom', 'Archon Delaine'], 'державы по числу систем');
    assert.equal(powers().length, 12, 'фильтр показывает все державы, а не только найденные в наборе');
    assert.ok(powers().includes('Jerome Archer') && powers().includes('A. Lavigny-Duval'));
    assert.match(doc.querySelector('[data-powerplay-filter]').textContent, /Державы · показано 12 из 12/);
    const rows = () => Array.from(doc.querySelectorAll('[data-powerplay-row]')).map((item) => item.getAttribute('data-powerplay-row'));
    assert.deepEqual(rows(), ['Alpha', 'Epsilon', 'Gamma', 'Beta', 'Delta'], 'сначала оплоты, затем укреплённые, внутри — по имени');
    assert.match(doc.querySelector('.powerplay-summary').textContent, /На карте: 5 из 5 систем/);

    // «Только эта» держава.
    await ui.click(doc.querySelector('[data-power="Archon Delaine"] .powerplay-solo'));
    assert.deepEqual(rows(), ['Gamma', 'Delta']);
    assert.ok(doc.querySelector('[data-power="Yuri Grom"]').classList.contains('off'));
    const hidden = JSON.parse(ui.dom.window.localStorage.getItem('atlas-powerplay-v1')).filter.hiddenPowers;
    assert.ok(hidden.includes('Yuri Grom') && !hidden.includes('Archon Delaine'), 'фильтр запомнен');
    assert.equal(hidden.length, 11, 'скрыты все остальные державы');
    assert.match(doc.querySelector('[data-powerplay-filter]').textContent, /показано 1 из 12/);

    // Состояние: без эксплуатируемых.
    const exploitedChip = Array.from(doc.querySelectorAll('.powerplay-chip')).find((chip) => (chip.textContent || '').includes('Эксплуатируемые'));
    await ui.click(exploitedChip);
    assert.equal(exploitedChip.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(rows(), ['Gamma']);
    await ui.click(exploitedChip);

    // Все державы обратно, поиск по имени.
    const allButton = Array.from(doc.querySelectorAll('.powerplay-group-actions button')).find((button) => (button.textContent || '').trim() === 'все');
    await ui.click(allButton);
    assert.deepEqual(rows(), ['Alpha', 'Epsilon', 'Gamma', 'Beta', 'Delta']);

    // Быстрый выбор фракции: у Федерации в наборе систем нет, Независимые — обе державы.
    await ui.click(doc.querySelector('.powerplay-allegiance[data-allegiance="Federation"]'));
    assert.deepEqual(rows(), []);
    assert.match(doc.querySelector('.powerplay-list').textContent, /Под фильтр систем нет/);
    assert.equal(doc.querySelector('.powerplay-allegiance[data-allegiance="Federation"]').getAttribute('aria-pressed'), 'true');
    await ui.click(doc.querySelector('.powerplay-allegiance[data-allegiance="Independent"]'));
    assert.deepEqual(rows(), ['Alpha', 'Epsilon', 'Gamma', 'Beta', 'Delta']);
    await ui.click(doc.querySelector('.powerplay-allegiance[data-allegiance="Independent"]'));
    assert.equal(JSON.parse(ui.dom.window.localStorage.getItem('atlas-powerplay-v1')).filter.hiddenPowers.length, 0, 'повторный клик — снова все');
    const noneButton = Array.from(doc.querySelectorAll('.powerplay-group-actions button')).find((button) => (button.textContent || '').trim() === 'ни одной');
    await ui.click(noneButton);
    assert.match(doc.querySelector('.powerplay-list').textContent, /Все державы скрыты/);
    await ui.click(allButton);
    await ui.typeInto(doc.querySelector('input[aria-label="Поиск системы среди систем держав"]'), 'ta');
    assert.deepEqual(rows(), ['Beta', 'Delta']);

    // Клик по строке: выбор и камера карты (событие для GalaxyMap).
    await ui.click(doc.querySelector('[data-powerplay-row="Delta"]'));
    assert.deepEqual(focused, ['Delta']);
    assert.equal(doc.querySelector('[data-powerplay-row="Delta"]').getAttribute('aria-pressed'), 'true');

    // Слой можно выключить, выбор при этом снимается.
    await ui.click(toggle);
    assert.equal(doc.querySelector('.powerplay-toggle input').checked, false);
    assert.match(ui.text(), /Слой выключен/);
    assert.equal(doc.querySelector('[data-powerplay-row="Delta"]').getAttribute('aria-pressed'), 'false');

    // «Чья зона?» для системы вне слоя: координаты из каталога, зоны — из набора.
    const checkInput = doc.querySelector('.powerplay-check input[role="combobox"]');
    await ui.typeInto(checkInput, 'Colony Target');
    await ui.keyOn(checkInput, 'Enter');
    await ui.flush(40);
    const result = doc.querySelector('[data-powerplay-check]');
    assert.ok(result, 'результат проверки показан');
    assert.equal(result.getAttribute('data-powerplay-check'), 'Colony Target');
    assert.match(result.textContent, /Не под контролем держав/);
    assert.match(result.textContent, /Yuri Grom — оплот Alpha, 6,00 св\. лет/);
    assert.match(result.textContent, /Archon Delaine — укреплённая Gamma, 19,0 св\. лет/);
    assert.ok(ui.calls.some((call) => call.includes('/api/galaxy/systems/by-name?name=Colony%20Target')));

    // Имена систем в ответе кликабельны: выбор, карточка и камера.
    await ui.click(result.querySelector('[data-powerplay-link="Alpha"]'));
    assert.equal(focused[focused.length - 1], 'Alpha', 'клик по имени ведёт камеру к системе');
    assert.equal(doc.querySelector('.powerplay-toggle input').checked, true, 'и снова показывает слой');
  } finally {
    ui.dom.window.removeEventListener('atlas-focus-powerplay', onFocus);
    await ui.cleanup();
  }
});

test('страница Atlas: PowerPlay — ошибка с повтором, затем ход импорта на сервере и фильтр до данных', async () => {
  let fail = true;
  const ui = await renderAtlas(null, {
    url: 'http://localhost/atlas?tab=powerplay',
    api: (target) => {
      if (target.includes('/api/powerplay/systems')) {
        if (fail) return { status: 503, body: { error: 'Не удалось загрузить системы PowerPlay' } };
        return {
          body: {
            status: 'empty', version: 'none', powers: [], states: ['Stronghold', 'Fortified', 'Exploited'], systems: [],
            meta: {
              ...EMPTY_POWERPLAY_META,
              refreshing: true,
              progress: { stage: 'write', percent: 64, message: 'Запись в базу: пачка 9 из 14', startedAt: '2026-10-18T10:00:00.000Z' },
            },
          },
        };
      }
      if (target.includes('/api/atlas/favorites') || target.includes('/api/atlas/sessions')) return { status: 401, body: { error: 'Unauthorized' } };
      return { body: {} };
    },
  });
  try {
    ui.mod.resetPowerplayLayerCache();
    await ui.render(ui.React.createElement(ui.mod.AtlasPage));
    await ui.flush(60);
    assert.match(ui.text(), /Не удалось загрузить системы PowerPlay/);
    assert.equal(ui.document.querySelector('[data-powerplay-status]').getAttribute('data-powerplay-status'), 'error');
    // Фильтр держав виден и до данных: двенадцать держав, счётчиков пока нет.
    assert.equal(ui.document.querySelectorAll('.powerplay-power').length, 12);
    fail = false;
    const retry = Array.from(ui.document.querySelectorAll('.powerplay-panel button')).find((button) => (button.textContent || '').includes('Повторить'));
    await ui.click(retry);
    await ui.flush(60);
    const card = ui.document.querySelector('[data-powerplay-status]');
    assert.equal(card.getAttribute('data-powerplay-status'), 'importing');
    assert.match(card.textContent, /Сервер загружает данные EDSM — 64 %/);
    assert.match(card.textContent, /Запись в базу: пачка 9 из 14/);
    assert.equal(card.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '64');
    // Галочки работают и без данных — и запоминаются до их прихода.
    await ui.click(ui.document.querySelector('[data-power="Jerome Archer"] input'));
    assert.deepEqual(JSON.parse(ui.dom.window.localStorage.getItem('atlas-powerplay-v1')).filter.hiddenPowers, ['Jerome Archer']);
  } finally {
    await ui.cleanup();
  }
});

/* ── Вкладка «Фракции»: минорные фракции на карте ── */

const BGS_ROWS = [
  { id64: '10477373803', name: 'Sol', x: 0, y: 0, z: 0, allegiance: 'Federation', government: 'Democracy', controllingId: 1, controlling: 'Mother Gaia', population: 22780919531, factionsCount: 2, observedSec: 1792040000, source: 'helper' },
  { id64: '3932277478106', name: 'Lave', x: 75.75, y: 48.75, z: 70.75, allegiance: 'Independent', government: 'Dictatorship', controllingId: 2, controlling: 'Lave Radio', population: 1000000, factionsCount: 3, observedSec: null, source: 'edsm' },
  { id64: '36028797018963971', name: 'Col 285 Sector AB-C d14-3', x: -24.5, y: -33.8, z: 108.8, allegiance: 'Independent', government: 'Cooperative', controllingId: 3, controlling: 'Ring Colony Pioneers', population: 18457, factionsCount: 2, observedSec: 1792050000, source: 'web' },
  { id64: '5', name: 'Achenar', x: 67.5, y: -119.5, z: 24.8, allegiance: 'Empire', government: 'Patronage', controllingId: 4, controlling: 'Achenar Empire League', population: 10000000, factionsCount: 4, observedSec: null, source: 'edsm' },
];

const PIONEERS = {
  id: 3, name: 'Ring Colony Pioneers', allegiance: 'Independent', government: 'Cooperative', is_player: true, systems_count: 2, controlled_count: 1,
  systems: [
    ['5', 'Achenar', 67.5, -119.5, 24.8, 0.12, 'None', false, null, [], [], [], 'Happy', 10000000, 'Empire'],
    ['36028797018963971', 'Col 285 Sector AB-C d14-3', -24.5, -33.8, 108.8, 0.85, 'Expansion', true, 1792050000, ['Expansion'], [], [], 'Happy', 18457, 'Independent'],
  ],
};

test('страница Atlas: вкладка «Фракции» — все населённые системы, поиск и выбор фракций, «у власти»', async () => {
  // Сервер отдаёт системы по имени (bgs_layer_rows) — панель их не пересортировывает.
  const sorted = [...BGS_ROWS].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const layer = { status: 'ready', version: 'run-1.0', meta: { ...EMPTY_BGS_META, dumpGeneratedAt: '2026-10-17T04:50:00.000Z', factions: 7, pilotUpdateAt: '2026-10-18T09:30:00.000Z' }, ...encodeBgsLayer(sorted) };
  const searches = [];
  const ui = await renderAtlas(null, {
    url: 'http://localhost/atlas?tab=factions',
    api: (target) => {
      if (target.includes('/api/factions/systems')) return { body: layer };
      if (target.includes('/api/factions/search')) {
        searches.push(target);
        const results = [{ id: 3, name: 'Ring Colony Pioneers', allegiance: 'Independent', government: 'Cooperative', is_player: true, systems: 2, controlled: 1 }];
        return { body: { results: target.includes('q=zzz') ? [] : results } };
      }
      if (target.includes('/api/factions/presence')) return { body: { factions: [PIONEERS] } };
      if (target.includes('/api/projects')) return { body: { projects: [] } };
      if (target.includes('/api/atlas/favorites') || target.includes('/api/atlas/sessions')) return { status: 401, body: { error: 'Unauthorized' } };
      return { body: {} };
    },
  });
  const focused = [];
  const onFocus = (event) => focused.push(event.detail?.name);
  try {
    ui.mod.resetFactionsLayerCache();
    ui.dom.window.addEventListener('atlas-focus-faction-system', onFocus);
    await ui.render(ui.React.createElement(ui.mod.AtlasPage));
    await ui.flush(60);
    const doc = ui.document;

    const tab = Array.from(doc.querySelectorAll('[role="tab"]')).find((item) => (item.textContent || '').includes('Фракции'));
    assert.equal(tab.getAttribute('aria-selected'), 'true', 'вкладка открыта по ?tab=factions');
    assert.ok(ui.calls.includes('GET /api/factions/systems'), `набор не запрошен: ${ui.calls.join(', ')}`);
    const card = doc.querySelector('[data-bgs-status]');
    assert.equal(card.getAttribute('data-bgs-status'), 'ready');
    assert.match(card.textContent, /4 населённых систем · фракций: 7/);
    assert.match(card.textContent, /Дамп EDSM от 17\.10\.2026/);
    assert.match(card.textContent, /пилоты обновляли/);
    // Первый визит сам включает слой.
    assert.equal(doc.querySelector('.bgs-toggle input').checked, true);
    assert.equal(JSON.parse(ui.dom.window.localStorage.getItem('atlas-factions-v1')).visible, true);

    // Без выбранных фракций — все населённые системы по имени, фильтр принадлежности.
    const rows = () => Array.from(doc.querySelectorAll('[data-bgs-row]')).map((item) => item.getAttribute('data-bgs-row'));
    assert.deepEqual(rows(), ['Achenar', 'Col 285 Sector AB-C d14-3', 'Lave', 'Sol']);
    assert.match(doc.querySelector('[data-bgs-row="Sol"]').textContent, /Mother Gaia · Федерация · 22,8 млрд · фракций 2/);
    const chip = doc.querySelector('[data-bgs-allegiance="Independent"]');
    assert.match(chip.textContent, /Независимые2/);
    await ui.click(chip);
    assert.equal(chip.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(rows(), ['Achenar', 'Sol'], 'независимые скрыты');
    assert.deepEqual(JSON.parse(ui.dom.window.localStorage.getItem('atlas-factions-v1')).filter.hiddenAllegiances, ['Independent']);
    await ui.click(chip);

    // Поиск фракции: одна буква — ничего не ищет, от двух — запрос с задержкой.
    const search = doc.querySelector('input[aria-label="Поиск минорной фракции"]');
    await ui.typeInto(search, 'p');
    await ui.flush(260);
    assert.equal(searches.length, 0, 'одна буква — без запроса');
    await ui.typeInto(search, 'pio');
    await ui.flush(300);
    assert.ok(searches.some((url) => url.includes('q=pio')), `поиск не ушёл: ${searches.join(', ')}`);
    const result = doc.querySelector('[data-bgs-result="Ring Colony Pioneers"]');
    assert.ok(result, 'фракция найдена');
    assert.match(result.textContent, /PMF/);
    assert.match(result.textContent, /Независимые · Кооператив · систем 2 · у власти 1/);

    // Выбор фракции: на карте и в списке — только её системы, сначала где она у власти.
    await ui.click(result);
    await ui.flush(60);
    assert.ok(ui.calls.some((call) => call.includes('/api/factions/presence?ids=3')), 'системы фракции запрошены');
    const selected = doc.querySelector('[data-bgs-selected-faction="Ring Colony Pioneers"]');
    assert.ok(selected, 'фракция в списке выбранных');
    assert.match(selected.textContent, /систем 2 · у власти 1/);
    assert.match(doc.querySelector('[data-bgs-picker]').textContent, /выбрано 1 из 12/);
    assert.deepEqual(rows(), ['Col 285 Sector AB-C d14-3', 'Achenar'], 'сначала «у власти»');
    assert.match(doc.querySelector('[data-bgs-row="Col 285 Sector AB-C d14-3"]').textContent, /Ring Colony Pioneers 85,0 % \(у власти\), экспансия/);
    assert.match(doc.querySelector('.powerplay-summary').textContent, /На карте: 2 систем выбранных фракций/);
    const stored = JSON.parse(ui.dom.window.localStorage.getItem('atlas-factions-v1')).selection;
    assert.deepEqual(stored.map((item) => [item.id, item.name]), [[3, 'Ring Colony Pioneers']], 'выбор запомнен');
    assert.equal(doc.querySelector('[data-bgs-result="Ring Colony Pioneers"]').classList.contains('chosen'), true);

    // «Только где у власти».
    const controlsOnly = Array.from(doc.querySelectorAll('.bgs-options label')).find((label) => (label.textContent || '').includes('у власти')).querySelector('input');
    await ui.click(controlsOnly);
    assert.deepEqual(rows(), ['Col 285 Sector AB-C d14-3']);
    await ui.click(controlsOnly);

    // Клик по строке — выбор и камера карты.
    await ui.click(doc.querySelector('[data-bgs-row="Achenar"]'));
    assert.deepEqual(focused, ['Achenar']);
    assert.equal(doc.querySelector('[data-bgs-row="Achenar"]').getAttribute('aria-pressed'), 'true');

    // Нет совпадений — понятный ответ; только фракции игроков — свой запрос.
    await ui.typeInto(search, 'zzz');
    await ui.flush(300);
    assert.match(doc.querySelector('[data-bgs-results]').textContent, /Фракция «zzz» не найдена/);
    await ui.typeInto(search, '');
    await ui.click(Array.from(doc.querySelectorAll('.bgs-check')).find((label) => (label.textContent || '').includes('PMF')).querySelector('input'));
    await ui.flush(60);
    assert.ok(searches.some((url) => url.includes('player=1')), 'запрос фракций игроков');

    // Сбросить выбор — снова все населённые системы.
    await ui.click(doc.querySelector('[data-bgs-clear]'));
    assert.deepEqual(rows(), ['Achenar', 'Col 285 Sector AB-C d14-3', 'Lave', 'Sol']);
    assert.match(doc.querySelector('[data-bgs-picker]').textContent, /Фракции не выбраны/);
  } finally {
    ui.dom.window.removeEventListener('atlas-focus-faction-system', onFocus);
    await ui.cleanup();
  }
});

test('страница Atlas: «Фракции» — данных нет (подсказка про админку) и ход импорта на сервере', async () => {
  let importing = false;
  const ui = await renderAtlas(null, {
    url: 'http://localhost/atlas?tab=factions',
    api: (target) => {
      if (target.includes('/api/factions/systems')) {
        return {
          body: {
            status: 'empty', version: 'none', allegiances: [], governments: [], sources: [], factions: [], systems: [],
            meta: importing
              ? { ...EMPTY_BGS_META, refreshing: true, progress: { stage: 'download', stageLabel: 'Скачивание дампа на диск', percent: 37, message: 'Скачивание дампа на диск: 210 МБ из 498 МБ', startedAt: '2026-10-18T10:00:00.000Z' } }
              : { ...EMPTY_BGS_META },
          },
        };
      }
      if (target.includes('/api/atlas/favorites') || target.includes('/api/atlas/sessions')) return { status: 401, body: { error: 'Unauthorized' } };
      return { body: {} };
    },
  });
  try {
    ui.mod.resetFactionsLayerCache();
    await ui.render(ui.React.createElement(ui.mod.AtlasPage));
    await ui.flush(60);
    let card = ui.document.querySelector('[data-bgs-status]');
    assert.equal(card.getAttribute('data-bgs-status'), 'empty');
    assert.match(card.textContent, /Данных о фракциях пока нет/);
    assert.match(card.textContent, /Админка → Игровые данные → Фракции/);
    assert.match(card.textContent, /Colonial Helper/);
    importing = true;
    const recheck = Array.from(ui.document.querySelectorAll('.bgs-panel button')).find((button) => (button.textContent || '').includes('Проверить снова'));
    await ui.click(recheck);
    await ui.flush(60);
    card = ui.document.querySelector('[data-bgs-status]');
    assert.equal(card.getAttribute('data-bgs-status'), 'importing');
    assert.match(card.textContent, /Сервер загружает дамп EDSM — 37 %/);
    assert.match(card.textContent, /210 МБ из 498 МБ/);
    assert.equal(card.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '37');
  } finally {
    await ui.cleanup();
  }
});

/* ── Галактическое кольцо: результат, сохранение в проект и выгрузка ── */

const RING_SESSION = {
  session_id: 'ring-1',
  start_system: 'Sol',
  ring_radius: 23000,
  search_radius: 500,
  sectors: 3,
  sectors_done: 3,
  status: 'scanning',
  center: { x: 25.21875, y: -20.90625, z: 25899.96875 },
};

const RING_STATS = {
  realAnchors: 3,
  triangulatedAnchors: 0,
  systemsFound: 12,
  systemsSaved: 12,
  catalogHits: 12,
  cacheHits: 0,
  edsmRequests: 0,
  spanshRequests: 0,
  reusedFromNeighbours: 0,
};

const RING_RESULT = {
  sessionId: 'ring-1',
  start: 'Sol',
  route: [
    { name: 'Sol', x: 0, y: 0, z: 0, source: 'start' },
    { name: 'Alpha Centauri', x: 3.03, y: -0.09, z: 3.16, source: 'catalog' },
    { name: 'RING TRIANGULATED 4', x: 100, y: 0, z: 100, source: 'triangulated' },
  ],
  center: RING_SESSION.center,
  ringRadius: 23000,
  searchRadius: 500,
  anchors: [{ name: 'Anchor A', x: 23025, y: 0, z: 10, source: 'catalog' }],
  totals: {
    points: 3,
    realPoints: 2,
    syntheticPoints: 1,
    anchors: 3,
    triangulatedAnchors: 0,
    discovered: 12,
    deviationAvg: 2.5,
    deviationMax: 8,
  },
  stats: RING_STATS,
};

test('кольцо: результат виден в панели, сохраняется в проект и выгружается в CSV', async () => {
  const saveRequests = [];
  const ui = await renderAtlas(null, {
    api: (target, init) => {
      if (target.includes('/api/projects')) {
        return { body: { projects: [{ id: 3, name: 'Тестовая стройка', squadron_name: 'TEST', color: '#e67e22', description: null }] } };
      }
      if (target.includes('/api/atlas/ring-route/finalize')) return { body: { result: RING_RESULT } };
      if (target.includes('/api/atlas/ring-route/save')) {
        saveRequests.push(JSON.parse(init.body));
        return { body: { ok: true, added: 2, total_points: 3, skipped_duplicate: 0, skipped_synthetic: 1 } };
      }
      if (target.includes('/api/atlas/ring-route')) {
        return {
          body: {
            completed: false,
            session: RING_SESSION,
            step: {
              session_id: 'ring-1',
              sectors: 3,
              sectors_done: 3,
              processed: 3,
              done: true,
              progress: { percent: 98, stage: 'scan', message: 'Сегменты пройдены' },
              anchors: [{ name: 'Anchor A', x: 23025, y: 0, z: 10, source: 'catalog', deviation: 1.2 }],
              found: [{ name: 'Found A', x: 23010, y: 0, z: 12, source: 'catalog' }],
              beam: null,
              stats: RING_STATS,
            },
          },
        };
      }
      if (target.includes('/api/atlas/favorites') || target.includes('/api/atlas/sessions')) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }
      return { body: {} };
    },
  });
  const buttonByText = (label) => Array.from(ui.document.querySelectorAll('button'))
    .find((button) => (button.textContent || '').includes(label)) || null;
  try {
    await ui.render(ui.React.createElement(ui.mod.AtlasPage));
    const ringTab = Array.from(ui.document.querySelectorAll('[role="tab"]'))
      .find((tab) => (tab.textContent || '').includes('Кольцо'));
    await ui.click(ringTab);

    const build = buttonByText('Построить галактическое кольцо');
    assert.ok(build, 'кнопка запуска поиска кольца есть');
    await ui.click(build);
    await ui.flush(40);

    // Итог закреплён в канале прогресса: именно его рисует 3D-карта после
    // того, как оверлей поиска погаснет.
    const pinned = ui.mod.readAtlasSearchResult();
    assert.ok(pinned, 'результат кольца закреплён для карты');
    assert.equal(pinned.kind, 'ring');
    assert.equal(pinned.ring.radius, 23000, 'контур кольца передаётся на карту');
    assert.equal(pinned.path.length, 3, 'маршрут кольца передаётся на карту');
    assert.ok(
      pinned.points.some((point) => point.kind === 'anchor'),
      'опорные точки остаются на карте',
    );

    assert.match(ui.text(), /Результат кольцевого маршрута/, 'панель результата отрисована');
    assert.match(ui.text(), /Точки кольца/, 'список точек кольца показан');
    assert.match(ui.text(), /Сохранить найденное кольцо/, 'блок сохранения на месте');

    // Кнопки подписаны словами: выгрузка не должна прятаться за иконкой.
    for (const label of ['Скачать CSV', 'Копировать текстом', 'Сохранить в проект', 'Убрать с карты']) {
      assert.ok(buttonByText(label), `нет кнопки «${label}»`);
    }

    const select = ui.document.querySelector('#ring-save-project');
    assert.ok(select, 'выбор проекта для сохранения есть');
    assert.match(select.textContent || '', /\[TEST\] Тестовая стройка/, 'проект показан с тегом эскадрильи');

    const saveButton = buttonByText('Сохранить в проект');
    assert.equal(saveButton.disabled, true, 'без выбранного проекта сохранение закрыто');

    await ui.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, '3');
      select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    });
    await ui.flush(10);

    await ui.click(buttonByText('Сохранить в проект'));
    await ui.flush(30);

    assert.equal(saveRequests.length, 1, 'сохранение отправило один запрос');
    assert.equal(saveRequests[0].project_id, 3);
    assert.equal(saveRequests[0].session_id, 'ring-1', 'маршрут берётся из сессии, а не телом на тысячи точек');
    assert.equal(saveRequests[0].include_synthetic, false, 'расчётные точки по умолчанию не сохраняются');
    assert.match(ui.text(), /В проект добавлено систем: 2/, 'итог сохранения показан пилоту');
    assert.match(ui.text(), /расчётных точек пропущено: 1/);
  } finally {
    // Оверлей результата живёт 30 секунд: убираем таймер, чтобы файл не ждал его.
    ui.mod.resetAtlasSearchProgress();
    await ui.cleanup();
  }
});
