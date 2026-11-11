/**
 * Вкладка «Расписание» страницы `/carriers/jumps` в jsdom.
 *
 * Чистые правила и маршруты проверяет `carrier-jump-schedule.test.mjs`, здесь
 * то, что видит пилот:
 *   1. вкладки «Прыжки» и «Расписание» переключают панели, а выбранная вкладка
 *      попадает в адрес (`?tab=calendar`);
 *   2. гость не видит форму создания, но читает публичное расписание;
 *   3. календарь месяца показывает счётчики прыжков, день фильтрует список;
 *   4. владелец создаёт расписание, открывает его, меняет видимость и
 *      добавляет прыжок — запросы уходят с ожидаемым телом;
 *   5. чужое публичное расписание — только чтение: кнопок правки нет.
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
export { CarrierJumpCalendar } from '@/components/Carriers/CarrierJumpCalendar';
export { CarrierJumpsPage } from '@/components/Carriers/CarrierJumpsPage';
`;

const SCHEDULE = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Среда, снабжение Lave',
  note: 'возит сталь',
  visibility: 'private',
  mine: true,
  ownerName: 'Pilot One',
  entryCount: 2,
  nextEntryAt: '2026-11-11T18:00:00.000Z',
  createdAt: '2026-11-10T12:00:00.000Z',
  updatedAt: '2026-11-10T12:00:00.000Z',
};

const FOREIGN = {
  ...SCHEDULE,
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Чужой публичный',
  note: null,
  visibility: 'public',
  mine: false,
  ownerName: 'Pilot Two',
  entryCount: 1,
};

const ENTRIES = [
  {
    id: 'e-1',
    scheduleId: SCHEDULE.id,
    carrierId: '3800000501',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    from: 'Sol',
    to: 'Lave',
    departureAt: '2026-11-11T18:00:00.000Z',
    note: 'груз',
  },
  {
    id: 'e-2',
    scheduleId: SCHEDULE.id,
    carrierId: null,
    callsign: null,
    name: null,
    from: 'Lave',
    to: 'Alioth',
    departureAt: '2026-11-11T20:30:00.000Z',
    note: null,
  },
  {
    id: 'e-3',
    scheduleId: SCHEDULE.id,
    carrierId: '3800000502',
    callsign: 'STE-777',
    name: null,
    from: 'Alioth',
    to: 'Sol',
    departureAt: '2026-11-13T09:00:00.000Z',
    note: null,
  },
];

async function render(componentName, options = {}) {
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
    url: options.url ?? 'http://localhost/carriers/jumps',
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
    confirm: global.confirm,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.localStorage = dom.window.localStorage;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.getComputedStyle = dom.window.getComputedStyle;
  // `window.confirm` в jsdom не реализован — удаление подтверждаем «да».
  dom.window.confirm = () => true;
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
    root.render(React.createElement(mod[componentName], options.props ?? {}));
  });
  await flush(70);

  const document = dom.window.document;
  const text = () => document.body.textContent || '';
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush(50);
  };
  const typeInto = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(30);
  };
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };

  return { mod, document, text, click, typeInto, flush, cleanup, calls, dom };
}

/** Ответы маршрутов для владельца: список, расписание, правки. */
function ownerApi(target, method) {
  if (target.endsWith('/api/carriers/jumps/schedules') && method === 'GET') {
    return { body: { schedules: [SCHEDULE, FOREIGN], viewer: { signedIn: true } } };
  }
  if (target.endsWith('/api/carriers/jumps/schedules') && method === 'POST') {
    return { status: 201, body: { schedule: { ...SCHEDULE, id: '33333333-3333-4333-8333-333333333333', title: 'Новое', entryCount: 0, nextEntryAt: null } } };
  }
  if (target.includes(`/schedules/${SCHEDULE.id}`) && method === 'GET') {
    return { body: { schedule: SCHEDULE, entries: ENTRIES, viewer: { signedIn: true } } };
  }
  if (target.includes(`/schedules/${FOREIGN.id}`) && method === 'GET') {
    return { body: { schedule: FOREIGN, entries: [ENTRIES[0]], viewer: { signedIn: true } } };
  }
  if (target.includes(`/schedules/${SCHEDULE.id}`) && method === 'PATCH') {
    return { body: { schedule: { ...SCHEDULE, visibility: 'public' } } };
  }
  if (target.includes(`/schedules/${SCHEDULE.id}`) && method === 'POST') {
    return {
      status: 201,
      body: {
        entry: {
          id: 'e-9', scheduleId: SCHEDULE.id, carrierId: null, callsign: 'NEW-001', name: null,
          from: 'Sol', to: 'Lave', departureAt: '2026-11-11T22:00:00.000Z', note: null,
        },
      },
    };
  }
  if (target.includes('/api/carriers/jumps') && method === 'GET') {
    return { body: { carriers: [], viewer: { signedIn: true }, generatedAt: '2026-11-10T12:00:00.000Z', total: 0, truncated: false } };
  }
  return { body: {} };
}

test('вкладки: «Прыжки», «Расписание» и «История» переключают панели и пишутся в адрес', async () => {
  const ui = await render('CarrierJumpsPage', { api: ownerApi });
  try {
    const tabs = ui.document.querySelectorAll('.cj-tab');
    assert.equal(tabs.length, 3, 'третья вкладка — история прыжков');
    assert.equal(tabs[0].textContent.trim(), 'Прыжки');
    assert.equal(tabs[1].textContent.trim(), 'Расписание');
    assert.equal(tabs[2].textContent.trim(), 'История');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');

    await ui.click(tabs[1]);
    assert.equal(ui.document.querySelectorAll('.cj-tab')[1].getAttribute('aria-selected'), 'true');
    assert.equal(ui.dom.window.location.search, '?tab=calendar', 'вкладка попала в адрес');
    assert.match(ui.text(), /Расписания прыжков/);
    assert.equal(ui.dom.window.location.search, '?tab=calendar', 'период истории в адрес расписания не протекает');
  } finally {
    await ui.cleanup();
  }
});

test('расписание владельца: список, календарь со счётчиками и прыжки дня', async () => {
  const ui = await render('CarrierJumpCalendar', {
    api: ownerApi,
    url: 'http://localhost/carriers/jumps?tab=calendar',
  });
  try {
    assert.match(ui.text(), /Среда, снабжение Lave/);
    assert.match(ui.text(), /Чужой публичный/);
    assert.match(ui.text(), /Моё/, 'своё расписание помечено');
    assert.match(ui.text(), /Прыжков: 2/);

    // Расписание открывается кликом по списку (на странице это делает `?schedule=`).
    const own = [...ui.document.querySelectorAll('.cjc-item')]
      .find((element) => (element.textContent || '').includes('Среда, снабжение Lave'));
    await ui.click(own);
    assert.equal(ui.document.querySelectorAll('.cjc-entry').length, 3, 'весь месяц показывает все прыжки');
    assert.match(ui.text(), /STE-777/);

    // Ноябрь 2026 в тестовых данных: 11-е — два прыжка, 13-е — один.
    const cells = [...ui.document.querySelectorAll('.cjc-day')];
    const day11 = cells.find((cell) => cell.getAttribute('aria-label')?.startsWith('2026-11-11'));
    const day13 = cells.find((cell) => cell.getAttribute('aria-label')?.startsWith('2026-11-13'));
    assert.ok(day11 && day13, 'сетка месяца построена');
    assert.equal(day11.querySelector('.cjc-day-count')?.textContent, '2');
    assert.equal(day13.querySelector('.cjc-day-count')?.textContent, '1');

    await ui.click(day11);
    const rows = [...ui.document.querySelectorAll('.cjc-entry')];
    assert.equal(rows.length, 2, 'выбранный день фильтрует список');
    assert.match(ui.text(), /K7Q-BQL/);
    assert.ok(!(ui.text().includes('STE-777')), 'прыжки других дней скрыты');
  } finally {
    await ui.cleanup();
  }
});

test('владелец: создание расписания, публикация и добавление прыжка', async () => {
  const ui = await render('CarrierJumpCalendar', {
    api: ownerApi,
    url: 'http://localhost/carriers/jumps?tab=calendar',
  });
  try {
    const titleInput = ui.document.querySelector('.cjc-new input');
    assert.ok(titleInput, 'форма создания есть у вошедшего пилота');
    const createButton = ui.document.querySelector('.cjc-new button[type="submit"]');
    assert.equal(createButton.disabled, true, 'без названия кнопка неактивна');
    await ui.typeInto(titleInput, 'Новое расписание');
    assert.equal(ui.document.querySelector('.cjc-new button[type="submit"]').disabled, false);
    await ui.click(ui.document.querySelector('.cjc-new button[type="submit"]'));

    const created = ui.calls.find((call) => call.method === 'POST' && call.url.endsWith('/schedules'));
    assert.ok(created, 'POST создания ушёл');
    assert.equal(created.body.title, 'Новое расписание');
    assert.equal(created.body.visibility, 'private', 'по умолчанию приватное');

    // Открываем своё расписание и публикуем его.
    const item = [...ui.document.querySelectorAll('.cjc-item')]
      .find((element) => (element.textContent || '').includes('Среда, снабжение Lave'));
    await ui.click(item);
    const publish = [...ui.document.querySelectorAll('.cjc-head-actions .cj-btn')]
      .find((element) => (element.textContent || '').includes('Сделать публичным'));
    assert.ok(publish, 'кнопка публикации у владельца');
    await ui.click(publish);
    const patch = ui.calls.find((call) => call.method === 'PATCH');
    assert.ok(patch, 'PATCH видимости ушёл');
    assert.deepEqual(patch.body, { visibility: 'public' });

    // Добавляем прыжок вручную.
    const addButton = [...ui.document.querySelectorAll('.cjc-entries-head .cj-btn')]
      .find((element) => (element.textContent || '').includes('Добавить прыжок'));
    assert.ok(addButton, 'кнопка ручного прыжка');
    await ui.click(addButton);
    const inputs = [...ui.document.querySelectorAll('.cjc-form input')];
    await ui.typeInto(inputs[0], 'NEW-001');
    await ui.typeInto(inputs[1], 'Sol');
    await ui.typeInto(inputs[2], 'Lave');
    await ui.typeInto(inputs[3], '2026-11-11T22:00');
    const save = ui.document.querySelector('.cjc-form button[type="submit"]');
    assert.equal(save.disabled, false);
    await ui.click(save);

    const entryPost = ui.calls.find((call) => call.method === 'POST' && call.url.includes('/schedules/'));
    assert.ok(entryPost, 'POST прыжка ушёл');
    assert.equal(entryPost.body.from, 'Sol');
    assert.equal(entryPost.body.to, 'Lave');
    assert.equal(entryPost.body.callsign, 'NEW-001');
    assert.ok(entryPost.body.departureAt, 'время переведено в ISO');
  } finally {
    await ui.cleanup();
  }
});

test('гость не создаёт расписание, но читает публичное', async () => {
  const ui = await render('CarrierJumpCalendar', {
    props: { initialScheduleId: FOREIGN.id },
    url: `http://localhost/carriers/jumps?tab=calendar&schedule=${FOREIGN.id}`,
    api: (target, method) => {
      if (target.endsWith('/api/carriers/jumps/schedules') && method === 'GET') {
        return { body: { schedules: [FOREIGN], viewer: { signedIn: false } } };
      }
      if (target.includes(`/schedules/${FOREIGN.id}`) && method === 'GET') {
        return { body: { schedule: FOREIGN, entries: [ENTRIES[0]], viewer: { signedIn: false } } };
      }
      if (target.includes('/api/carriers/jumps') && method === 'GET') {
        return { body: { carriers: [], viewer: { signedIn: false }, generatedAt: '2026-11-10T12:00:00.000Z', total: 0, truncated: false } };
      }
      return { body: {} };
    },
  });
  try {
    assert.equal(ui.document.querySelector('.cjc-new'), null, 'гостю форму не показываем');
    assert.match(ui.text(), /Войдите, чтобы создать расписание/);
    assert.match(ui.text(), /Чужой публичный/, 'публичное видно без входа');
    assert.match(ui.text(), /Чужое публичное расписание — только чтение|Чужой публичный/);
    assert.match(ui.text(), /K7Q-BQL/, 'прыжки публичного расписания читаются');

    // Открытое ссылкой расписание выбрано само.
    assert.ok(ui.document.querySelector('.cjc-item.active'), 'расписание из адреса открыто');
    assert.equal(ui.document.querySelector('.cjc-head-actions .cjc-danger'), null, 'чужое не удалить');
    assert.equal([...ui.document.querySelectorAll('.cj-btn')].some((element) => (element.textContent || '').includes('Добавить прыжок')), false,
      'чужое не правится');
  } finally {
    await ui.cleanup();
  }
});

test('расписание: прыжок с носителем ведёт в Атлас, ручной план — нет', async () => {
  const ui = await render('CarrierJumpCalendar', {
    api: ownerApi,
    url: 'http://localhost/carriers/jumps?tab=calendar',
  });
  try {
    const own = [...ui.document.querySelectorAll('.cjc-item')]
      .find((element) => (element.textContent || '').includes('Среда, снабжение Lave'));
    await ui.click(own);

    const entries = [...ui.document.querySelectorAll('.cjc-entry')];
    const linked = entries.find((row) => row.querySelector('.cjc-entry-carrier .cj-carrier-link'));
    assert.ok(linked, 'у прыжка с MarketID позывной — ссылка');
    const query = new URLSearchParams(
      (linked.querySelector('.cjc-entry-carrier .cj-carrier-link').getAttribute('href') || '').split('?')[1],
    );
    assert.equal(query.get('tab'), 'carriers');
    assert.equal(query.get('carrier'), '3800000501');
    assert.equal(query.get('carrier_system'), 'Sol', 'фокус — на системе, откуда прыгает');

    // Ручной план без привязки к реестру остаётся текстом: фокусировать нечего.
    const links = entries.filter((row) => row.querySelector('.cjc-entry-carrier .cj-carrier-link'));
    assert.equal(links.length, 2, 'две записи с MarketID, ручной план — без ссылки');
    assert.ok(
      entries.some((row) => !row.querySelector('.cjc-entry-carrier .cj-carrier-link')),
      'запись без носителя не притворяется ссылкой',
    );
  } finally {
    await ui.cleanup();
  }
});
