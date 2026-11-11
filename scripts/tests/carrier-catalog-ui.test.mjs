/**
 * Каталог авианосцев (`/carriers`) в jsdom.
 *
 * Правила и маршрут проверяет `carrier-catalog.test.mjs`, здесь — то, что видит
 * пилот:
 *   1. таблица строится из ответа маршрута: позывной и имя ведут в карточку
 *      носителя, система — в карточку системы, службы и источник подписаны;
 *   2. в шапке есть переход на `/carriers/jumps` — тот, ради которого страница
 *      и заведена;
 *   3. поиск уходит на сервер с паузой после ввода, фильтры и порядок — сразу;
 *   4. пейджер листает страницы, а не фильтрует уже загруженное, и пишет
 *      страницу в адрес;
 *   5. гость добавляет носитель в избранное локально, кнопка становится
 *      нажатой;
 *   6. пустая выдача объясняется и сбрасывается одной кнопкой;
 *   7. Carrier ID копируется по кнопке.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { I18N_CONTEXT_STUB } from './helpers/i18nStub.mjs';

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { children, href, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;

const ENTRY = `
export { CarrierDirectoryPage } from '@/components/Carriers/CarrierDirectoryPage';
export { CARRIER_WATCH_LOCAL_KEY } from '@/lib/carrierDirectory';
export { Toaster } from '@/components/ui/Toaster';
`;

const SEEN = '2026-11-16T10:00:00.000Z';

function row(overrides = {}) {
  return {
    id: '3800001001',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    type: 'FleetCarrier',
    origin: 'site',
    system: 'Sol',
    body: 'Earth',
    position: { x: 0, y: 0, z: 0 },
    relation: 'other',
    decommission: false,
    jump: null,
    docking: 'все пилоты',
    notorious: false,
    services: { active: 2, total: 3 },
    sightings: 4,
    seenAt: SEEN,
    updatedAt: SEEN,
    ...overrides,
  };
}

function feed(carriers, overrides = {}) {
  return {
    ok: true,
    carriers,
    total: carriers.length,
    page: 1,
    pageSize: 50,
    pages: 1,
    viewer: { signedIn: false },
    generatedAt: SEEN,
    ...overrides,
  };
}

async function renderPage(options = {}) {
  const { JSDOM } = await import('jsdom');
  const bundle = await bundleFile({
    entrySource: ENTRY,
    stubs: {
      'next/link': NEXT_LINK_STUB,
      '@/lib/i18n/I18nContext': I18N_CONTEXT_STUB,
    },
    external: ['react', 'react-dom', 'react-dom/client'],
  });

  const calls = [];
  const copied = [];
  const previousFetch = global.fetch;
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  global.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
    const custom = options.api?.(target, method, init);
    if (custom) return json(custom.body, custom.status ?? 200);
    if (target.includes('/api/carriers/directory')) return json(feed([row()]));
    return json({});
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: options.url ?? 'http://localhost/carriers',
  });
  const clipboard = {
    writeText: async (value) => { copied.push(value); },
  };
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: clipboard, configurable: true });

  const previous = {
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
    Element: global.Element,
    Node: global.Node,
    localStorage: global.localStorage,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
    getComputedStyle: global.getComputedStyle,
  };
  const previousNavigator = global.navigator;
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.localStorage = dom.window.localStorage;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.getComputedStyle = dom.window.getComputedStyle;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const mod = await import(bundle);

  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async (ms = 30) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  await act(async () => {
    root.render(React.createElement(
      React.Fragment,
      null,
      React.createElement(mod.Toaster),
      React.createElement(mod.CarrierDirectoryPage),
    ));
  });
  await flush(60);

  const document = dom.window.document;
  const text = () => document.body.textContent || '';
  const click = async (element) => {
    assert.ok(element, 'элемент не найден');
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush(50);
  };
  const typeInto = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(380);
  };
  const choose = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush(60);
  };
  let cleaned = false;
  const cleanup = async () => {
    // Тест мог упасть до проверок: снимаем компонент всегда, иначе его
    // интервалы держат процесс и прогон висит вместо отчёта о падении.
    if (cleaned) return;
    cleaned = true;
    await act(async () => { root.unmount(); });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
    Object.defineProperty(global, 'navigator', { value: previousNavigator, configurable: true });
  };

  return { mod, document, text, click, typeInto, choose, flush, cleanup, calls, dom, copied };
}

const searchInput = (ui) => ui.document.querySelector('.cj-search input');
const directoryCalls = (calls) => calls.filter((call) => call.url.includes('/api/carriers/directory'));

test('таблица: позывной и имя ведут в карточку, система — в карточку системы, есть переход в «Прыжки»', async (t) => {
  const ui = await renderPage({
    api: (target) => (target.includes('/api/carriers/directory')
      ? {
        body: feed([
          row(),
          row({
            id: '3800001002',
            callsign: 'REG-704',
            name: null,
            origin: 'eddn',
            system: 'Lave',
            body: null,
            sightings: 12,
            jump: { system: 'Sol', departureAt: '2026-11-16T12:00:00.000Z', state: 'scheduled' },
          }),
        ]),
      }
      : null),
  });
  t.after(() => ui.cleanup());
  const text = ui.text();
  assert.match(text, /K7Q-BQL/);
  assert.match(text, /Hippione/);
  assert.match(text, /REG-704/);
  assert.match(text, /имя неизвестно/, 'у носителя из реестра имени нет — так и написано');
  assert.match(text, /2 из 3/, 'работающие службы из общего числа');
  assert.match(text, /EDDN/, 'источник подписан');

  const links = [...ui.document.querySelectorAll('.cj-carrier-link')];
  assert.deepEqual(links.map((link) => link.getAttribute('href')), ['/carriers/3800001001', '/carriers/3800001002']);

  // Вторая колонка — система, третья — цель заказанного прыжка: обе ведут в
  // карточку системы, и это разные ссылки в разных ячейках.
  const rows = [...ui.document.querySelectorAll('.cj-table tbody tr')];
  const system = rows.map((tr) => tr.children[1].querySelector('a.cj-target')?.getAttribute('href'));
  assert.deepEqual(system, ['/system/Sol', '/system/Lave']);
  assert.equal(rows[1].children[2].querySelector('a.cj-target')?.getAttribute('href'), '/system/Sol',
    'цель прыжка тоже кликабельна');
  assert.match(rows[0].children[2].textContent, /нет заказа/, 'без заказа — честная подпись, а не пустая ячейка');

  const cta = ui.document.querySelector('.cl-cta');
  assert.equal(cta.getAttribute('href'), '/carriers/jumps');
  assert.match(cta.textContent, /Авианосцы перед прыжком/);

  await ui.cleanup();
});

test('поиск: пауза после ввода, запрос уходит на сервер, пустой ввод возвращает список', async (t) => {
  const ui = await renderPage({
    api: (target) => {
      if (!target.includes('/api/carriers/directory')) return null;
      const query = new URL(target, 'http://localhost').searchParams.get('q');
      if (!query) return { body: feed([row()]) };
      return {
        body: feed(query.startsWith('k7q')
          ? [row()]
          : []),
      };
    },
  });
  t.after(() => ui.cleanup());

  await ui.typeInto(searchInput(ui), 'k7q');
  const withQuery = directoryCalls(ui.calls).filter((call) => call.url.includes('q=k7q'));
  assert.equal(withQuery.length, 1, 'на каждую букву запрос не уходит — только после паузы');
  assert.equal(ui.document.querySelectorAll('.cj-table tbody tr').length, 1);

  await ui.typeInto(searchInput(ui), 'nothing');
  assert.match(ui.text(), /Ничего не найдено/);

  await ui.typeInto(searchInput(ui), '');
  assert.equal(ui.document.querySelectorAll('.cj-table tbody tr').length, 1, 'пустой поиск снова показывает список');

  await ui.cleanup();
});

test('фильтры и порядок: уходят в запрос сразу и попадают в адрес', async (t) => {
  const ui = await renderPage();
  const eddn = [...ui.document.querySelectorAll('.cl-seg-btn')].find((button) => button.textContent === 'EDDN');
  await ui.click(eddn);
  const filtered = directoryCalls(ui.calls).at(-1);
  assert.match(filtered.url, /origin=eddn/);
  assert.match(ui.dom.window.location.search, /origin=eddn/);

  const planned = [...ui.document.querySelectorAll('.cl-seg-btn')].find((button) => button.textContent === 'с заказом');
  await ui.click(planned);
  assert.match(directoryCalls(ui.calls).at(-1).url, /jump=planned/);

  const select = ui.document.querySelector('.cl-sort select');
  await ui.choose(select, 'name');
  assert.match(directoryCalls(ui.calls).at(-1).url, /sort=name/);

  const reset = [...ui.document.querySelectorAll('.cj-btn')].find((button) => button.textContent === 'Сбросить');
  await ui.click(reset);
  const last = directoryCalls(ui.calls).at(-1);
  assert.equal(new URL(last.url, 'http://localhost').search, '', 'сброс убирает фильтры из запроса');
  assert.equal(ui.dom.window.location.search, '', 'и из адреса');

  await ui.cleanup();
});

test('пейджер: листает серверные страницы, крайние кнопки выключены', async (t) => {
  const ui = await renderPage({
    api: (target) => {
      if (!target.includes('/api/carriers/directory')) return null;
      const page = Number(new URL(target, 'http://localhost').searchParams.get('page') ?? 1);
      return {
        body: feed([row({ id: `38000020${page}` })], { total: 120, page, pageSize: 50, pages: 3 }),
      };
    },
  });
  t.after(() => ui.cleanup());

  const buttons = () => [...ui.document.querySelectorAll('.cl-page-btn')];
  const prev = buttons().find((button) => button.textContent.includes('Назад'));
  const next = buttons().find((button) => button.textContent.includes('Вперёд'));
  assert.equal(prev.disabled, true, 'на первой странице «Назад» недоступна');
  assert.equal(ui.document.querySelector('.cl-page-btn.active').textContent, '1');

  await ui.click(buttons().find((button) => button.textContent === '2'));
  assert.match(directoryCalls(ui.calls).at(-1).url, /page=2/);
  assert.match(ui.dom.window.location.search, /page=2/);
  assert.equal(ui.document.querySelector('.cl-page-btn.active').textContent, '2');
  assert.equal(buttons().find((button) => button.textContent.includes('Назад')).disabled, false);

  await ui.click(buttons().find((button) => button.textContent === '3'));
  assert.equal(buttons().find((button) => button.textContent.includes('Вперёд')).disabled, true);

  await ui.cleanup();
});

test('гость добавляет в избранное локально: кнопка нажата, запись в браузере', async (t) => {
  const ui = await renderPage({
    api: (target) => {
      if (target.includes('/api/atlas/carriers/watch')) return { status: 401, body: {} };
      return null;
    },
  });
  t.after(() => ui.cleanup());
  const star = () => ui.document.querySelector('.cl-table tbody .cj-sub');
  assert.equal(star().getAttribute('aria-pressed'), 'false');

  await ui.click(star());
  assert.equal(star().getAttribute('aria-pressed'), 'true');
  assert.match(star().textContent, /В избранном/);
  const stored = JSON.parse(ui.dom.window.localStorage.getItem(ui.mod.CARRIER_WATCH_LOCAL_KEY));
  assert.equal(stored[0].carrierId, '3800001001');
  assert.equal(stored[0].favorite, true);

  await ui.click(star());
  assert.equal(star().getAttribute('aria-pressed'), 'false');
  const after = JSON.parse(ui.dom.window.localStorage.getItem(ui.mod.CARRIER_WATCH_LOCAL_KEY) ?? '[]');
  assert.deepEqual(after, [], 'снятый флаг без заметки не оставляет пустую запись');

  await ui.cleanup();
});

test('пустая выдача: объяснение и сброс фильтров одной кнопкой', async (t) => {
  const ui = await renderPage({
    url: 'http://localhost/carriers?q=nothing',
    api: (target) => (target.includes('/api/carriers/directory') ? { body: feed([]) } : null),
  });
  t.after(() => ui.cleanup());
  assert.match(ui.text(), /Ничего не найдено/);
  const reset = [...ui.document.querySelectorAll('.cj-btn')].find((button) => button.textContent === 'Сбросить фильтры');
  await ui.click(reset);
  assert.equal(searchInput(ui).value, '');
  assert.equal(directoryCalls(ui.calls).at(-1).url.includes('q='), false);
  await ui.cleanup();
});

test('Carrier ID копируется кнопкой, рядом с позывным', async (t) => {
  const ui = await renderPage();
  t.after(() => ui.cleanup());
  const copy = ui.document.querySelector('.cl-copy');
  assert.match(copy.textContent, /3800001001/);
  await ui.click(copy);
  assert.deepEqual(ui.copied, ['3800001001']);
  assert.match(ui.text(), /Carrier ID скопирован/, 'пилот видит подтверждение, а не гадает');
  await ui.cleanup();
});
