/**
 * Поиск по станциям в jsdom: быстрый выбор из справочника (ввод, клавиатура,
 * точный выбор, недавние), результаты списком с раскрытием строки, вкладки и
 * страницы.
 *
 * Страница собирается esbuild'ом (`next/link` и поле системы — заглушки).
 * Списки быстрого выбора — настоящие, из `/api/stations/search/options`, а
 * ответ поиска — фиксированный.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bundleFile } from './helpers/bundle.mjs';

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { href, children, prefetch, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;
const SYSTEM_INPUT_STUB = `
import * as React from 'react';
export function SystemSearchInput({ label, value, onChange }: any) {
  return React.createElement('label', null, label, React.createElement('input', { 'data-testid': 'reference', value, onChange: (event: any) => onChange(event.target.value) }));
}
`;

const optionsApi = await import(await bundleFile({ entry: 'src/app/api/stations/search/options/route.ts', stubs: {
  'next/server': `export const NextResponse={json:(body,options={})=>({body,status:options.status||200})};`,
} }));

const NOW = Date.now();
const station = (name, overrides = {}) => ({
  station_key: `market:${name}`, station_name: name, station_type: 'Coriolis Starport', system_name: 'Sol', market_id: '1',
  x: 0, y: 0, z: 0, distance: 4.38, metadata: { body_name: 'Earth', distance_to_arrival: 505 },
  observed_at: new Date(NOW - 3 * 3600_000).toISOString(), source: 'colonial-helper', stale: true,
  items: [{ name: 'Steel', buyPrice: 1234, sellPrice: 1100, stock: 5000, demand: 0, display: 'Сталь', hint: 'Steel' }],
  item_count: 1, best_price: 1234, ...overrides,
});

async function renderPage({ search } = {}) {
  const bundle = await bundleFile({
    entry: 'src/app/station-search/page.tsx',
    stubs: { 'next/link': NEXT_LINK_STUB, '@/components/Atlas/SystemSearchInput': SYSTEM_INPUT_STUB },
    external: ['react', 'react-dom', 'react-dom/client'],
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true, url: 'http://test.local/station-search',
  });
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const requests = [];
  globalThis.fetch = async (url) => {
    const target = new URL(String(url), 'http://test.local');
    requests.push(target);
    if (target.pathname === '/api/stations/search/options') {
      const response = await optionsApi.GET(new Request(target));
      return { ok: response.status === 200, status: response.status, json: async () => response.body };
    }
    const body = search ? search(target) : { kind: 'market', query: target.searchParams.get('q'), page: 0, has_more: false, total: 0, stations: [], pick: null, grouping: 'station' };
    return { ok: true, status: 200, json: async () => body };
  };
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: Page } = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  await act(async () => { root.render(React.createElement(Page)); });
  await flush(30);
  const document = dom.window.document;
  const ui = {
    dom, document, requests, flush,
    query: () => document.getElementById('station-query'),
    options: () => [...document.querySelectorAll('.station-pick-option')],
    button: (text) => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text),
    async click(element) {
      await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      await flush(20);
    },
    async mouseDown(element) {
      await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); });
      await flush(20);
    },
    async type(element, value) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value);
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await flush(15);
    },
    async select(element, value) {
      await act(async () => {
        element.value = value;
        element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      await flush(15);
    },
    async focus(element) {
      await act(async () => { element.focus(); });
      await flush(30);
    },
    async key(element, key) {
      await act(async () => { element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
      await flush(15);
    },
    async submit() {
      await act(async () => { document.querySelector('.station-search-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
      await flush(40);
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      dom.window.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
  return ui;
}

test('typing a material shows a quick-pick list; the keyboard picks it and the search is exact', async () => {
  const ui = await renderPage({
    search: (url) => ({ kind: 'market', query: url.searchParams.get('q'), page: 0, has_more: false, total: 1,
      stations: [station('Galileo')], pick: url.searchParams.get('item') ? { id: url.searchParams.get('item'), label: 'Сталь' } : null, grouping: 'station' }),
  });
  try {
    const input = ui.query();
    assert.equal(input.getAttribute('role'), 'combobox');
    await ui.focus(input);
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.match(ui.document.querySelector('.station-pick-list').textContent, /Строительные материалы/);
    assert.equal(ui.options().length, 55, 'before typing: construction materials');

    await ui.type(input, 'ста');
    assert.equal(ui.options()[0].querySelector('.station-pick-name').textContent, 'Сталь');
    assert.equal(ui.options()[0].querySelector('mark').textContent, 'Ста');
    assert.match(ui.options()[0].textContent, /Steel/);
    await ui.key(input, 'ArrowDown');
    assert.equal(input.getAttribute('aria-activedescendant'), ui.options()[0].id);
    await ui.key(input, 'Enter');
    assert.equal(input.value, 'Сталь');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.match(ui.document.querySelector('.station-pick-note').textContent, /Точный выбор/);

    await ui.submit();
    const search = ui.requests.find((url) => url.pathname === '/api/stations/search');
    assert.equal(search.searchParams.get('item'), 'market:Steel');
    assert.equal(search.searchParams.get('group'), 'station');
    assert.equal(search.searchParams.get('q'), 'Сталь');
    assert.match(ui.document.body.textContent, /Точное совпадение с выбранным из списка/);

    // Повторный фокус: выбранное — в «Недавний выбор».
    await ui.focus(ui.document.querySelector('[data-testid="reference"]'));
    await ui.focus(input);
    assert.match(ui.document.querySelector('.station-pick-group').textContent, /Недавний выбор/);
  } finally {
    await ui.cleanup();
  }
});

test('results are a list of stations; a row expands to show prices, stock and links', async () => {
  const pages = [];
  const ui = await renderPage({
    search: (url) => {
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return page === 0
        ? { kind: 'market', query: 'Сталь', page: 0, has_more: true, total: 51, pick: null, grouping: 'station', reference: null,
          stations: [station('Galileo'), station('Unknown coordinates', { station_key: 'market:2', x: null, y: null, z: null, distance: null, stale: false, observed_at: new Date(NOW - 5 * 60_000).toISOString(),
            items: [{ name: 'Steel', buyPrice: 990, stock: 70, display: 'Сталь', hint: 'Steel' }, { name: 'Steel Plates', buyPrice: 10, stock: 1, display: 'Steel Plates' }], item_count: 3, best_price: 10 })] }
        : { kind: 'market', query: 'Сталь', page: 1, has_more: false, total: 51, pick: null, grouping: 'station', reference: null, stations: [station('Next page', { station_key: 'market:3' })] };
    },
  });
  try {
    await ui.type(ui.query(), 'Steel plates or something');
    await ui.submit();
    assert.equal(ui.document.querySelectorAll('.station-row').length, 2);
    assert.equal(ui.document.querySelector('.station-result-card'), null, 'no tiles any more');
    assert.match(ui.document.querySelector('.station-results-heading').textContent, /Найдено 51 станция · страница 1 из 2/);
    const [first, second] = ui.document.querySelectorAll('.station-row-head');
    assert.equal(first.getAttribute('aria-expanded'), 'false');
    assert.match(first.textContent, /Galileo/);
    assert.match(first.textContent, /Coriolis Starport/);
    assert.match(first.textContent, /4,38 св\. л\./);
    assert.match(first.textContent, /3 ч назад/);
    assert.match(second.textContent, /3 товара · от 10 CR/);
    assert.match(second.textContent, /5 мин назад/);
    assert.equal(ui.document.querySelector('.station-row-panel'), null, 'rows start collapsed');

    await ui.click(first);
    assert.equal(first.getAttribute('aria-expanded'), 'true');
    const panel = ui.document.getElementById(first.getAttribute('aria-controls'));
    assert.ok(panel);
    const cells = [...panel.querySelectorAll('tbody td')].map((cell) => cell.textContent.replace(/\s/g, ' '));
    assert.deepEqual(cells, ['1 234 CR', '1 100 CR', '5 000 т', '0 т']);
    assert.match(panel.querySelector('tbody th').textContent, /СтальSteel/);
    assert.match(panel.textContent, /Earth/);
    assert.match(panel.textContent, /Colonial Helper/);
    assert.match(panel.textContent, /отчёт старше часа/);
    const atlas = [...panel.querySelectorAll('a')].find((link) => link.textContent.includes('Показать систему в Атласе'));
    assert.equal(atlas.getAttribute('target'), '_blank');
    const focus = new URL(atlas.getAttribute('href'), 'http://test.local').searchParams;
    assert.deepEqual([focus.get('focus_system'), focus.get('x'), focus.get('y'), focus.get('z')], ['Sol', '0', '0', '0']);
    assert.equal([...panel.querySelectorAll('a')].find((link) => link.textContent === 'Карточка системы').getAttribute('href'), '/system/Sol');

    await ui.click(ui.button('Развернуть все'));
    assert.equal(ui.document.querySelectorAll('.station-row-panel').length, 2);
    assert.ok(ui.button('Координаты системы неизвестны').disabled);
    assert.match(ui.document.body.textContent, /И ещё 1 товар/);
    await ui.click(ui.button('Свернуть все'));
    assert.equal(ui.document.querySelectorAll('.station-row-panel').length, 0);

    await ui.click(ui.button('Далее →'));
    assert.deepEqual(pages, [0, 1]);
    assert.match(ui.document.querySelector('.station-list').textContent, /Next page/);
    assert.equal(ui.document.querySelectorAll('.station-row-panel').length, 1, 'a single station opens by itself');
  } finally {
    await ui.cleanup();
  }
});

test('a typed full name searches exactly, editing drops the pick, and services suggest engineers', async () => {
  const ui = await renderPage();
  try {
    const input = ui.query();
    await ui.focus(input);
    await ui.type(input, 'water');
    await ui.submit();
    let search = ui.requests.filter((url) => url.pathname === '/api/stations/search').at(-1);
    assert.equal(search.searchParams.get('item'), 'market:Water', 'an exact English name becomes the pick');
    assert.equal(ui.query().value, 'Вода');

    await ui.type(ui.query(), 'Вода и');
    assert.match(ui.document.querySelector('.station-pick-note').textContent, /Свободный поиск/);
    await ui.type(ui.query(), 'wat');
    await ui.submit();
    search = ui.requests.filter((url) => url.pathname === '/api/stations/search').at(-1);
    assert.equal(search.searchParams.get('item'), null, 'partial text stays a free search');

    await ui.click(ui.document.getElementById('station-tab-services'));
    assert.equal(ui.query().value, '');
    await ui.focus(ui.query());
    await ui.type(ui.query(), 'farseer');
    const engineer = ui.options().find((option) => option.textContent.includes('Felicity Farseer'));
    assert.ok(engineer);
    assert.match(engineer.textContent, /Deciat/);
    await ui.mouseDown(engineer);
    assert.equal(ui.query().value, 'Felicity Farseer');
    await ui.submit();
    search = ui.requests.filter((url) => url.pathname === '/api/stations/search').at(-1);
    assert.equal(search.searchParams.get('kind'), 'services');
    assert.equal(search.searchParams.get('item'), 'engineer:farseer');

    await ui.click(ui.document.getElementById('station-tab-outfitting'));
    await ui.focus(ui.query());
    await ui.type(ui.query(), 'fsd');
    assert.equal(ui.options()[0].querySelector('.station-pick-name').textContent, 'Гипердвигатель (FSD)');
    await ui.key(ui.query(), 'Escape');
    assert.equal(ui.query().getAttribute('aria-expanded'), 'false');
  } finally {
    await ui.cleanup();
  }
});

test('radius and stock presets fill the fields in one click', async () => {
  const ui = await renderPage();
  try {
    const stock = ui.document.getElementById('station-stock');
    const preset = [...ui.document.querySelectorAll('[aria-label="Быстрый выбор запаса"] button')].find((button) => button.textContent.replace(/\s/g, '') === '1000');
    await ui.click(preset);
    assert.equal(stock.value, '1000');
    assert.equal(preset.getAttribute('aria-pressed'), 'true');
    const radiusPresets = [...ui.document.querySelectorAll('[aria-label="Быстрый выбор радиуса"] button')];
    assert.ok(radiusPresets.every((button) => button.disabled), 'radius needs a reference system');
    await ui.type(ui.document.querySelector('[data-testid="reference"]'), 'Sol');
    await ui.click(radiusPresets.find((button) => button.textContent === '100'));
    assert.equal(ui.document.getElementById('station-radius').value, '100');
  } finally {
    await ui.cleanup();
  }
});


test('pad and carrier filters are sent, retained across tabs and applied from page zero', async () => {
  const ui = await renderPage();
  try {
    assert.equal(ui.document.getElementById('station-pad').value, 'any');
    assert.equal(ui.document.getElementById('station-carriers').value, 'include');
    await ui.select(ui.document.getElementById('station-pad'), 'M');
    await ui.select(ui.document.getElementById('station-carriers'), 'exclude');
    await ui.type(ui.query(), 'Steel');
    await ui.submit();
    let request = ui.requests.filter(url => url.pathname === '/api/stations/search').at(-1);
    assert.equal(request.searchParams.get('pad'), 'M');
    assert.equal(request.searchParams.get('carriers'), 'exclude');
    assert.equal(request.searchParams.get('page'), '0');
    await ui.click(ui.document.getElementById('station-tab-services'));
    assert.equal(ui.document.getElementById('station-pad').value, 'M');
    assert.equal(ui.document.getElementById('station-carriers').value, 'exclude');
    await ui.select(ui.document.getElementById('station-carriers'), 'only');
    await ui.type(ui.query(), 'repair');
    await ui.submit();
    request = ui.requests.filter(url => url.pathname === '/api/stations/search').at(-1);
    assert.equal(request.searchParams.get('carriers'), 'only');
    assert.equal(request.searchParams.get('pad'), 'M');
    assert.equal(request.searchParams.get('kind'), 'services');
  } finally { await ui.cleanup(); }
});
