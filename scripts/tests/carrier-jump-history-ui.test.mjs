/**
 * Вкладка «История» страницы `/carriers/jumps` в jsdom.
 *
 * Правила и SQL проверяет `carrier-jump-history.test.mjs`, здесь то, что видит
 * пилот:
 *   1. третья вкладка переключает панель и пишется в адрес (`?tab=history`);
 *   2. история грузится только когда вкладку открыли — лишнего запроса за год
 *      при загрузке страницы нет;
 *   3. график интенсивности стоит вверху вкладки: столбцов столько, сколько
 *      корзин у периода, и их высота растёт вместе со счётчиком;
 *   4. переключатель периода меняет окно (12 / 24 / 30 / 12 корзин) и адрес;
 *   5. список прыжков ищется по позывному, системе и имени;
 *   6. пустое окно, ошибка загрузки и повтор — без падения страницы.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { I18N_CONTEXT_STUB } from './helpers/i18nStub.mjs';
import { historyBuckets } from '../../src/lib/carrierJumpHistory.ts';

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { children, href, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;

const ENTRY = `
export { CarrierJumpsPage } from '@/components/Carriers/CarrierJumpsPage';
`;

const JUMPS = [
  {
    id: '1',
    carrierId: '3800000501',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    from: 'Sol',
    to: 'Lave',
    jumpedAt: '2026-11-12T11:40:00.000Z',
    source: 'site',
  },
  {
    id: '2',
    carrierId: '3800000502',
    callsign: 'STE-777',
    name: null,
    from: 'Lave',
    to: 'Alioth',
    jumpedAt: '2026-11-12T11:10:00.000Z',
    source: 'eddn',
  },
  {
    id: '3',
    carrierId: '3800000503',
    callsign: 'ABC-123',
    name: 'Big Ship',
    from: 'Alioth',
    to: 'Sol',
    jumpedAt: '2026-11-12T10:20:00.000Z',
    source: 'site',
  },
];

/** Ответ маршрута: корзины строим теми же правилами, что и страница. */
function payload(period, now = Date.now(), overrides = {}) {
  const buckets = historyBuckets(period, now);
  const counts = buckets.map((start, index) => (index % 4 === 0 ? index + 1 : 0));
  const total = counts.reduce((sum, value) => sum + value, 0);
  return {
    period,
    granularity: period === '1h' ? '5min' : period === '1d' ? 'hour' : period === '1m' ? 'day' : 'month',
    since: new Date(buckets[0]).toISOString(),
    generatedAt: new Date(now).toISOString(),
    chart: buckets.map((start, index) => ({ start: new Date(start).toISOString(), jumps: counts[index] })),
    summary: {
      total,
      carriers: 3,
      routes: 3,
      bySource: { site: Math.ceil(total / 2), eddn: Math.floor(total / 2) },
      top: [
        { carrierId: '3800000501', callsign: 'K7Q-BQL', name: 'Hippione', jumps: 4 },
        { carrierId: '3800000502', callsign: 'STE-777', name: null, jumps: 2 },
      ],
    },
    jumps: JUMPS,
    total,
    shown: JUMPS.length,
    truncated: false,
    ...overrides,
  };
}

async function render(options = {}) {
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
  global.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const period = new URL(target, 'http://localhost').searchParams.get('period') ?? '1d';
    if (target.includes('/api/carriers/jumps/history')) {
      if (options.failHistory) return json({ error: 'История недоступна' }, 503);
      const custom = options.history?.(period);
      return json(custom ?? payload(period));
    }
    if (target.includes('/api/carriers/jumps')) {
      return json({ carriers: [], viewer: { signedIn: false }, generatedAt: new Date().toISOString(), total: 0 });
    }
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
  const flush = async (ms = 30) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  await act(async () => {
    root.render(React.createElement(mod.CarrierJumpsPage, options.props ?? {}));
  });
  await flush(80);

  const document = dom.window.document;
  const text = () => document.body.textContent || '';
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush(60);
  };
  const typeInto = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(40);
  };
  const tab = (index) => document.querySelectorAll('.cj-tab')[index];
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };

  return { document, text, click, typeInto, flush, tab, calls, cleanup, dom };
}

test('вкладка «История»: третья вкладка, панель и адрес', async () => {
  const ui = await render();
  try {
    const tabs = ui.document.querySelectorAll('.cj-tab');
    assert.equal(tabs.length, 3, 'три вкладки: прыжки, расписание, история');
    assert.equal(tabs[2].textContent.trim(), 'История');
    assert.equal(tabs[2].getAttribute('aria-selected'), 'false');
    assert.equal(
      ui.calls.filter((url) => url.includes('/history')).length,
      0,
      'пока вкладку не открыли, историю не грузим',
    );

    await ui.click(ui.tab(2));
    assert.equal(ui.tab(2).getAttribute('aria-selected'), 'true');
    assert.equal(ui.dom.window.location.search, '?tab=history&period=1d', 'вкладка и период в адресе');
    assert.match(ui.text(), /История прыжков/);
    assert.equal(ui.calls.filter((url) => url.includes('/history')).length, 1);
  } finally {
    await ui.cleanup();
  }
});

test('график интенсивности: вверху вкладки, столбцов по числу корзин, высота по счётчику', async () => {
  const ui = await render({ url: 'http://localhost/carriers/jumps?tab=history' });
  try {
    const chart = ui.document.querySelector('.cjh-chart-card');
    assert.ok(chart, 'карточка графика есть');
    assert.match(chart.textContent, /Интенсивность прыжков/);

    // График должен идти раньше таблицы — «вверху страницы».
    const list = ui.document.querySelector('.cjh-list');
    assert.ok(chart.compareDocumentPosition(list) & ui.dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      'график выше списка прыжков');

    const bars = chart.querySelectorAll('.cjh-bar');
    assert.equal(bars.length, 24, 'за сутки — 24 часовых столбца');
    assert.equal(ui.document.querySelectorAll('.cjh-axis span').length, 24, 'подпись у каждой корзины');
    assert.ok(bars.length > 0);

    const height = (bar) => Number(bar.getAttribute('height'));
    assert.ok(height(bars[0]) < height(bars[4]), 'где прыжков больше, столбец выше');
    assert.equal(height(bars[1]), 0, 'пустая корзина не рисуется');
    assert.ok(height(bars[20]) > 0, 'корзина со счётчиком видна');
    assert.equal(height(bars[23]), 0, 'пустая последняя корзина остаётся плоской');

    assert.match(ui.text(), /Прыжков|всего/i, 'итог за период подписан');
    assert.match(ui.text(), /Чаще всех прыгали/, 'топ носителей на месте');
    assert.match(ui.text(), /K7Q-BQL/);
    assert.match(ui.text(), /Hippione/);
    assert.equal(ui.document.querySelectorAll('.cjh-table tbody tr').length, 3, 'все три прыжка в таблице');
    assert.match(ui.text(), /EDDN/, 'источник строки виден');
  } finally {
    await ui.cleanup();
  }
});

test('переключатель периода: меняет окно, график и адрес', async () => {
  const ui = await render({ url: 'http://localhost/carriers/jumps?tab=history&period=1h' });
  try {
    assert.equal(ui.document.querySelectorAll('.cjh-bar').length, 12, 'час — 12 пятиминуток');
    assert.equal(ui.dom.window.location.search, '?tab=history&period=1h', 'период из адреса');

    const buttons = [...ui.document.querySelectorAll('.cjh-period')];
    assert.deepEqual(buttons.map((button) => button.textContent.trim()), ['1 час', '1 день', '1 месяц', '1 год']);
    assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');

    await ui.click(buttons[2]);
    assert.equal(ui.document.querySelectorAll('.cjh-bar').length, 30, 'месяц — 30 дней');
    assert.equal(ui.dom.window.location.search, '?tab=history&period=1m');
    assert.equal(ui.document.querySelectorAll('.cjh-period')[2].getAttribute('aria-pressed'), 'true');
    assert.ok(ui.calls.some((url) => url.includes('period=1m')), 'маршрут запросили с новым периодом');

    await ui.click(ui.document.querySelectorAll('.cjh-period')[3]);
    assert.equal(ui.document.querySelectorAll('.cjh-bar').length, 12, 'год — 12 месяцев');
    assert.equal(ui.dom.window.location.search, '?tab=history&period=1y');
  } finally {
    await ui.cleanup();
  }
});

test('поиск по истории: позывной, система и пустая выдача', async () => {
  const ui = await render({ url: 'http://localhost/carriers/jumps?tab=history' });
  try {
    const input = ui.document.querySelector('.cjh-search input');
    assert.ok(input, 'поле поиска есть');

    await ui.typeInto(input, 'k7q');
    assert.equal(ui.document.querySelectorAll('.cjh-table tbody tr').length, 1);
    const tableText = () => ui.document.querySelector('.cjh-table')?.textContent ?? '';
    assert.match(tableText(), /K7Q-BQL/);
    assert.doesNotMatch(tableText(), /STE-777/, 'остальные строки скрыты');

    await ui.typeInto(input, 'sol');
    assert.equal(ui.document.querySelectorAll('.cjh-table tbody tr').length, 2, 'поиск по обеим системам маршрута');

    await ui.typeInto(input, 'zzz');
    assert.equal(ui.document.querySelectorAll('.cjh-table tbody tr').length, 0);
    assert.match(ui.text(), /Ничего не найдено/);
    assert.equal(
      ui.calls.filter((url) => url.includes('/history')).length,
      1,
      'поиск идёт по загруженному окну, без запроса на каждую букву',
    );

    await ui.click(ui.document.querySelector('.cjh-search button'));
    assert.equal(ui.document.querySelectorAll('.cjh-table tbody tr').length, 3, 'очистка возвращает все строки');
  } finally {
    await ui.cleanup();
  }
});

test('пустое окно: график без прыжков и подсказка вместо таблицы', async () => {
  const ui = await render({
    url: 'http://localhost/carriers/jumps?tab=history',
    history: (period) => payload(period, Date.now(), {
      chart: historyBuckets(period).map((start) => ({ start: new Date(start).toISOString(), jumps: 0 })),
      summary: { total: 0, carriers: 0, routes: 0, bySource: { site: 0, eddn: 0 }, top: [] },
      jumps: [],
      total: 0,
      shown: 0,
    }),
  });
  try {
    assert.equal(ui.document.querySelectorAll('.cjh-bar').length, 0, 'столбцов нет');
    assert.match(ui.text(), /За этот период прыжков не было/);
    assert.match(ui.text(), /Прыжков нет/);
    assert.equal(ui.document.querySelectorAll('.cjh-table').length, 0);
  } finally {
    await ui.cleanup();
  }
});

test('ошибка загрузки: сообщение и повторный запрос', async () => {
  const ui = await render({ url: 'http://localhost/carriers/jumps?tab=history', failHistory: true });
  try {
    assert.ok(ui.document.querySelector('.cj-error'), 'видна ошибка');
    assert.match(ui.text(), /Не удалось загрузить историю прыжков/);
    const retry = ui.document.querySelector('.cj-error .cj-btn');
    assert.ok(retry, 'есть кнопка повтора');
    const before = ui.calls.filter((url) => url.includes('/history')).length;
    await ui.click(retry);
    assert.ok(
      ui.calls.filter((url) => url.includes('/history')).length > before,
      'повтор снова идёт в маршрут',
    );
  } finally {
    await ui.cleanup();
  }
});
