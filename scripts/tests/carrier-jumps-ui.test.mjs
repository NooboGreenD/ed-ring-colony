/**
 * Страница «Авианосцы перед прыжком» (`/carriers/jumps`) в jsdom.
 *
 * Чистые правила и маршрут проверяет `carrier-jumps.test.mjs`, здесь — то,
 * что видит пилот:
 *   1. таблица строится из ответа маршрута: позывной, маршрут, дистанция,
 *      время вылета, состояние, кнопка подписки;
 *   2. поиск оставляет только совпавшие строки;
 *   3. гость подписывается локально — запись с снимком плана попадает в
 *      localStorage, а в «Моих подписках» появляется «план без изменений»;
 *   4. вошедший пилот видит, что план изменился, а снятие подписки очищает
 *      снимок (`jumpSystem: null`) и не удаляет заметку.
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
export { CarrierJumpBoard } from '@/components/Carriers/CarrierJumpBoard';
export { CARRIER_WATCH_LOCAL_KEY } from '@/lib/carrierDirectory';
export { Toaster } from '@/components/ui/Toaster';
export { JUMP_ALERT_STORAGE_KEY } from '@/lib/carrierJumps';
`;

const GENERATED_AT = '2026-11-10T12:00:00.000Z';
const NOW = Date.parse(GENERATED_AT);
const MIN = 60_000;

function carrier(overrides = {}) {
  return {
    id: '3800000401',
    type: 'FleetCarrier',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    relation: 'other',
    owner: null,
    ownerHidden: false,
    squadron: null,
    system: 'Sol',
    body: null,
    position: { x: 0, y: 0, z: 0 },
    locationAt: GENERATED_AT,
    estimated: false,
    previousSystem: null,
    jump: {
      system: 'Lave',
      departureAt: new Date(NOW + 20 * MIN).toISOString(),
      state: 'scheduled',
      position: { x: 75.75, y: 48.75, z: -12.5 },
    },
    docking: null,
    notorious: null,
    services: [],
    decommission: false,
    origin: 'site',
    ...overrides,
  };
}

async function renderBoard(options = {}) {
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
  const previousFetch = global.fetch;
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  global.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url: target, body: init?.body ? JSON.parse(String(init.body)) : null });
    const custom = options.api?.(target, method, init);
    if (custom) return json(custom.body, custom.status ?? 200);
    return json({});
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/carriers/jumps',
  });
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
  const flush = async (ms = 25) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  await act(async () => {
    // Toaster рядом с таблицей: уведомления о подписках проверяются по тексту,
    // который пилот действительно видит, а не по вызову toast().
    root.render(React.createElement(
      React.Fragment,
      null,
      React.createElement(mod.Toaster),
      React.createElement(mod.CarrierJumpBoard),
    ));
  });
  await flush(60);

  const document = dom.window.document;
  const text = () => document.body.textContent || '';
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush(40);
  };
  const typeInto = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(40);
  };
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };

  return { React, mod, document, text, click, typeInto, flush, cleanup, calls, dom };
}

const FEED = {
  carriers: [
    carrier(),
    carrier({
      id: '3800000402',
      callsign: 'STE-777',
      name: 'Steel Barge',
      system: 'Lave',
      position: { x: 75.75, y: 48.75, z: -12.5 },
      jump: {
        system: 'Sol',
        departureAt: new Date(NOW - 2 * MIN).toISOString(),
        state: 'jumping',
        position: { x: 0, y: 0, z: 0 },
      },
    }),
  ],
  viewer: { signedIn: false },
  generatedAt: GENERATED_AT,
  total: 2,
  truncated: false,
};

/** Строка таблицы по позывному: порядок задаёт время вылета, а не тест. */
function rowFor(ui, callsign) {
  return [...ui.document.querySelectorAll('.cj-table tbody tr')]
    .find((row) => (row.textContent || '').includes(callsign)) ?? null;
}

function feedApi(target) {
  if (target.includes('/api/carriers/jumps')) return { body: FEED };
  if (target.includes('/api/atlas/carriers/watch')) return { status: 401, body: {} };
  return null;
}

test('таблица: маршрут, дистанция, вылет, состояние и кнопка подписки', async () => {
  const ui = await renderBoard({ api: feedApi });
  try {
    const rows = ui.document.querySelectorAll('.cj-table tbody tr');
    assert.equal(rows.length, 2, 'обе строки таблицы на месте');
    // Ближе к вылету — выше: «в прыжке» (−2 мин) раньше заказанного (+20 мин).
    assert.match(rows[0].textContent || '', /STE-777/);
    const soon = rowFor(ui, 'K7Q-BQL');
    assert.ok(soon, 'заказ с будущим вылетом в таблице');
    const soonText = soon.textContent || '';
    assert.match(soonText, /Hippione/);
    assert.match(soonText, /Sol/);
    assert.match(soonText, /Lave/);
    assert.match(ui.text(), /Готовятся к прыжку: 2/);
    assert.match(ui.text(), /Заказан/);
    assert.match(ui.text(), /В прыжке/);
    const distance = soon.querySelector('.cj-num')?.textContent || '';
    assert.match(distance, /^9\d/, `дистанция в световых годах: ${distance}`);
    assert.equal(ui.document.querySelectorAll('.cj-sub').length, 2);
    assert.equal(ui.document.querySelectorAll('.cj-sub')[0].textContent?.trim(), 'Следить');
    // Гость: записи ещё нет, блок подписок пуст и объясняет, что будет после входа.
    assert.match(ui.text(), /Подписок пока нет/);
    assert.match(ui.text(), /Войдите, чтобы подписки хранились в профиле/);
  } finally {
    await ui.cleanup();
  }
});

test('поиск: строка фильтруется по системе и позывному', async () => {
  const ui = await renderBoard({ api: feedApi });
  try {
    const input = ui.document.querySelector('.cj-search input');
    assert.ok(input, 'поле поиска есть');
    await ui.typeInto(input, 'steel');
    assert.equal(ui.document.querySelectorAll('.cj-table tbody tr').length, 1);
    assert.match(ui.text(), /STE-777/);
    await ui.typeInto(input, 'alioth');
    assert.match(ui.text(), /ничего не нашлось/);
  } finally {
    await ui.cleanup();
  }
});

test('гость подписывается локально: снимок плана и «план без изменений»', async () => {
  const ui = await renderBoard({ api: feedApi });
  try {
    await ui.click(rowFor(ui, 'K7Q-BQL').querySelector('.cj-sub'));
    const stored = JSON.parse(ui.dom.window.localStorage.getItem(ui.mod.CARRIER_WATCH_LOCAL_KEY) || '[]');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].carrierId, '3800000401');
    assert.equal(stored[0].jumpSystem, 'Lave', 'подписка помнит, куда собирался носитель');
    assert.ok(stored[0].jumpDepartureAt);
    assert.ok(stored[0].jumpSeenAt);

    assert.equal(rowFor(ui, 'K7Q-BQL').querySelector('.cj-sub').textContent?.trim(), 'Не следить');
    assert.match(ui.text(), /Мои подписки/);
    assert.match(ui.text(), /план без изменений/);
    assert.match(ui.text(), /Подписки видите только вы|остаются в этом браузере/);
    assert.ok(ui.calls.every((call) => !call.url.includes('/api/atlas/carriers/watch') || call.method === 'GET'),
      'гость не пишет на сервер');
  } finally {
    await ui.cleanup();
  }
});

test('вошедший пилот: план изменился, снятие подписки очищает снимок', async () => {
  const watch = {
    id: 'w-1',
    carrierId: '3800000401',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    system: 'Sol',
    favorite: true,
    note: 'возит сталь',
    updatedAt: GENERATED_AT,
    jumpSystem: 'Alioth',
    jumpDepartureAt: new Date(NOW + 90 * MIN).toISOString(),
    jumpSeenAt: GENERATED_AT,
  };
  const ui = await renderBoard({
    api: (target, method) => {
      if (target.includes('/api/carriers/jumps')) return { body: { ...FEED, viewer: { signedIn: true } } };
      if (target.includes('/api/atlas/carriers/watch') && method === 'GET') return { body: { watches: [watch] } };
      if (target.includes('/api/atlas/carriers/watch') && method === 'PUT') {
        return { body: { watch: { ...watch, note: watch.note, jumpSystem: null, jumpDepartureAt: null } } };
      }
      return { body: {} };
    },
  });
  try {
    assert.match(ui.text(), /план изменился/, 'цель в снимке не совпала с живым заказом');
    assert.match(ui.text(), /было: Alioth/, 'видно, что было обещано при подписке');

    const remove = ui.document.querySelector('.cj-watch-side .cj-icon-btn');
    assert.ok(remove, 'кнопка снятия подписки в «Моих подписках»');
    await ui.click(remove);

    const put = ui.calls.find((call) => call.method === 'PUT');
    assert.ok(put, 'подписка снимается через PUT, а не удалением записи с заметкой');
    assert.equal(put.body.jumpSystem, null);
    assert.equal(put.body.jumpDepartureAt, null);
    assert.equal(put.body.note, 'возит сталь', 'заметка не теряется');
    assert.match(ui.text(), /Подписок пока нет/);
  } finally {
    await ui.cleanup();
  }
});

test('подписка вошедшего пилота отправляет живой план', async () => {
  const ui = await renderBoard({
    api: (target, method) => {
      if (target.includes('/api/carriers/jumps')) return { body: { ...FEED, viewer: { signedIn: true } } };
      if (target.includes('/api/atlas/carriers/watch') && method === 'GET') return { body: { watches: [] } };
      if (target.includes('/api/atlas/carriers/watch') && method === 'PUT') {
        return { body: { watch: { carrierId: '3800000401', jumpSystem: 'Lave' } } };
      }
      return { body: {} };
    },
  });
  try {
    await ui.click(rowFor(ui, 'K7Q-BQL').querySelector('.cj-sub'));
    const put = ui.calls.find((call) => call.method === 'PUT');
    assert.ok(put, 'PUT ушёл на сервер');
    assert.equal(put.body.carrierId, '3800000401');
    assert.equal(put.body.jumpSystem, 'Lave');
    assert.equal(put.body.jumpDepartureAt, new Date(NOW + 20 * MIN).toISOString());
    assert.equal(put.body.favorite, false, 'подписка не добавляет носитель в избранное Атласа');
  } finally {
    await ui.cleanup();
  }
});

test('позывной в таблице ведёт в Атлас и фокусирует носитель', async () => {
  const ui = await renderBoard({ api: feedApi });
  try {
    const link = rowFor(ui, 'K7Q-BQL').querySelector('.cj-carrier-link');
    assert.ok(link, 'позывной — ссылка');
    assert.ok((link.getAttribute('href') || '').startsWith('/atlas?'), 'ведёт в Атлас');
    const query = new URLSearchParams((link.getAttribute('href') || '').split('?')[1]);
    assert.equal(query.get('tab'), 'carriers', 'открывается вкладка «Авианосцы»');
    assert.equal(query.get('carrier'), '3800000401', 'фокус — на этом носителе');
    assert.equal(query.get('carrier_system'), 'Sol');
    // Координаты стоянки передаются сразу: камера летит, не дожидаясь слоя.
    assert.equal(query.get('focus_system'), 'Sol');
    assert.deepEqual([query.get('x'), query.get('y'), query.get('z')], ['0', '0', '0']);
  } finally {
    await ui.cleanup();
  }
});

test('смена плана подписки: уведомление один раз, повторное обновление молчит', async () => {
  const watch = {
    id: 'w-1',
    carrierId: '3800000401',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    system: 'Sol',
    favorite: false,
    note: null,
    updatedAt: GENERATED_AT,
    jumpSystem: 'Lave',
    jumpDepartureAt: new Date(NOW + 20 * MIN).toISOString(),
    jumpSeenAt: GENERATED_AT,
  };
  const feed = structuredClone(FEED);
  feed.viewer = { signedIn: true };
  const ui = await renderBoard({
    api: (target, method) => {
      if (target.includes('/api/carriers/jumps')) return { body: feed };
      if (target.includes('/api/atlas/carriers/watch') && method === 'GET') return { body: { watches: [watch] } };
      return null;
    },
  });
  try {
    const alerts = () => (ui.text().match(/план прыжка изменился/g) ?? []).length;
    assert.equal(alerts(), 0, 'первый показ страницы ничего не рассылает');

    // Командир перенёс прыжок: живая цель больше не совпадает со снимком.
    feed.carriers[0].jump.system = 'Alioth';
    await ui.click(ui.document.querySelector('.cj-toolbar .cj-btn'));
    assert.equal(alerts(), 1, 'перенос плана — одно уведомление');
    assert.match(ui.text(), /Hippione: план прыжка изменился — Alioth/);

    const stored = JSON.parse(ui.dom.window.localStorage.getItem(ui.mod.JUMP_ALERT_STORAGE_KEY) || '{}');
    assert.ok(stored['3800000401'], 'что видел пилот — запомнено');

    // Обновление без изменений не повторяет уведомление.
    await ui.click(ui.document.querySelector('.cj-toolbar .cj-btn'));
    assert.equal(alerts(), 1, 'то же состояние второй раз не уведомляет');
  } finally {
    await ui.cleanup();
  }
});
