/**
 * Интерфейс «Архитектора системы» в jsdom: страница грузит тела, открывает
 * каталог, кладёт постройки в план и пересчитывает сводку.
 *
 * Сборка идёт тем же приёмом, что и тесты карты системы (`orrery-harness.mjs`):
 * esbuild собирает компонент, `next/dynamic` и `next/link` подменяются
 * заглушками, а сеть — подставным `fetch` с телами тестовой системы.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NEXT_DYNAMIC_STUB = `
import * as React from 'react';
export default function dynamic(_loader: unknown, _options?: unknown) {
  return function DynamicStub() { return null; };
}
export function loadable() { return null; }
`;

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  return React.createElement('a', { href: props.href }, props.children);
}
`;

const SYSTEM = 'Architest';

function fixtureBodies() {
  return [
    { body_name: `${SYSTEM} A`, body_id: 1, body_type: 'Star', sub_type: 'K (Yellow-Orange) Star', distance_ls: 0, radius_m: 500_000_000, surface_temp_k: 4500, gravity: 0, is_landable: false, rings: [], raw_data: {} },
    { body_name: `${SYSTEM} A 1`, body_id: 2, body_type: 'Planet', sub_type: 'Rocky body', distance_ls: 12, parents: [{ Star: 1 }], radius_m: 3_000_000, gravity: 1, surface_temp_k: 250, is_landable: true, rings: [], bio_signals_count: 3, geo_signals_count: 2, human_signals_count: 1, bio_genuses: ['Бактерии'], raw_data: {} },
    { body_name: `${SYSTEM} A 2`, body_id: 3, body_type: 'Planet', sub_type: 'Sudarsky Class III gas giant', distance_ls: 900, parents: [{ Star: 1 }], radius_m: 60_000_000, gravity: 2.1, surface_temp_k: 120, is_landable: false, rings: [{ name: `${SYSTEM} A 2 A Ring` }], raw_data: {} },
    { body_name: `${SYSTEM} A 1 a`, body_id: 4, body_type: 'Planet', sub_type: 'Rocky body', distance_ls: 12.4, parents: [{ Planet: 2 }], radius_m: 900_000, gravity: 0.3, surface_temp_k: 240, is_landable: true, rings: [], raw_data: {} },
  ];
}

/**
 * Заглушка сети: по умолчанию отвечает телами системы на любой адрес, но
 * тест может передать свой обработчик `api(url, init)`, вернув `{ status, body }`.
 * Так проверяются панели прогресса, публикации и «где купить» без Supabase.
 */
async function renderArchitect(options = {}) {
  const esbuild = await import('esbuild');
  const { JSDOM } = await import('jsdom');

  const dir = mkdtempSync(join(ROOT, '.tmp-architect-ui-'));
  const entry = join(dir, 'entry.tsx');
  const bundle = join(dir, 'bundle.mjs');
  writeFileSync(join(dir, 'next-dynamic.ts'), NEXT_DYNAMIC_STUB);
  writeFileSync(join(dir, 'next-link.tsx'), NEXT_LINK_STUB);
  writeFileSync(entry, "export { default as ArchitectWorkspace } from '@/components/Architect/ArchitectWorkspace';\n");

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client'],
    alias: {
      'next/dynamic': join(dir, 'next-dynamic.ts'),
      'next/link': join(dir, 'next-link.tsx'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    logLevel: 'silent',
  });

  const fetchCalls = [];
  const previousFetch = global.fetch;
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  global.fetch = async (url, init) => {
    const target = String(url);
    fetchCalls.push(`${init?.method ?? 'GET'} ${target}`);
    if (options.api) {
      const custom = options.api(target, init);
      if (custom) return json(custom.body, custom.status ?? 200);
    }
    if (target.includes('/api/atlas/system-bodies')) {
      return json({ ok: true, system: SYSTEM, source: 'edsm', count: fixtureBodies().length, bodies: fixtureBodies() });
    }
    // Прочие адреса (прогресс, планы, закупки) по умолчанию пустые: панели
    // обязаны честно говорить «данных нет», а не падать.
    return json({ ok: true });
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    // По умолчанию страница открывается по системе; тест может задать свой адрес,
    // например `/architect?plan=<id>` — так проверяется открытие плана по ссылке.
    url: options.url ?? `http://localhost/architect?system=${encodeURIComponent(SYSTEM)}`,
  });
  const previous = {
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
    Element: global.Element,
    Node: global.Node,
    navigator: global.navigator,
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
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.getComputedStyle = dom.window.getComputedStyle;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  const raf = (callback) => setTimeout(() => callback(Date.now()), 0);
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = raf;
  dom.window.confirm = () => true;

  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const mod = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async (ms = 20) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  await act(async () => {
    root.render(React.createElement(mod.ArchitectWorkspace));
  });
  await flush(40);

  const document = dom.window.document;
  const text = () => document.body.textContent || '';
  const click = async (element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await flush(15);
  };
  const typeInto = async (element, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(10);
  };
  const buttons = () => Array.from(document.querySelectorAll('button'));
  const buttonByText = (pattern) => buttons().find((item) => (typeof pattern === 'string'
    ? (item.textContent || '').trim() === pattern
    : pattern.test(item.textContent || '')));
  /** Карточка тела: ищем блок, в котором есть и имя тела, и кнопка «+ постройка». */
  const bodyCard = (name) => Array.from(document.querySelectorAll('div'))
    .filter((element) => (element.textContent || '').includes(name)
      && Array.from(element.querySelectorAll('button')).some((item) => (item.textContent || '').includes('+ постройка')))
    .sort((left, right) => (left.textContent || '').length - (right.textContent || '').length)[0];
  const cardButton = (name, label) => {
    const card = bodyCard(name);
    return card ? Array.from(card.querySelectorAll('button')).find((item) => (item.textContent || '').includes(label)) : null;
  };
  /** Строка каталога по названию постройки. */
  const pickerRow = (label) => Array.from(document.querySelectorAll('div'))
    .filter((element) => (element.textContent || '').includes(label)
      && Array.from(element.querySelectorAll('button')).some((item) => (item.textContent || '').trim() === 'В план'))
    .sort((left, right) => (left.textContent || '').length - (right.textContent || '').length)[0];
  const rowButton = (label, name = 'В план') => {
    const row = pickerRow(label);
    return row ? Array.from(row.querySelectorAll('button')).find((item) => (item.textContent || '').trim() === name) : null;
  };

  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'navigator') Object.defineProperty(global, 'navigator', { value, configurable: true });
      else global[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  return { dom, document, text, click, typeInto, buttons, buttonByText, cardButton, rowButton, pickerRow, flush, cleanup, fetchCalls };
}

test('страница загружает систему по ссылке и показывает тела со слотами', async () => {
  const ui = await renderArchitect();
  try {
    assert.ok(ui.fetchCalls.some((url) => url.includes('/api/atlas/system-bodies')), 'страница запросила тела системы');
    const text = ui.text();
    assert.match(text, /Архитектор системы/);
    assert.match(text, /тестовый режим/);
    assert.match(text, new RegExp(`${SYSTEM} A 1`));
    assert.match(text, /Тел: 4 · источник: edsm/);
    assert.match(text, /наземных слотов: 0 из 2/, 'у каменистой планеты радиусом 3000 км два наземных слота');
    assert.match(text, /звезда: только орбитальные постройки|орбитальных: 0/);
  } finally {
    await ui.cleanup();
  }
});

test('карточка тела показывает сигналы: биологию, геологию и следы людей', async () => {
  const ui = await renderArchitect();
  try {
    const text = ui.text();
    assert.match(text, /биологические сигналы: 3/, 'биология видна архитектору');
    assert.match(text, /геологические сигналы: 2/, 'геология видна архитектору');
    assert.match(text, /следы людей: 1/, 'человеческие сигналы видны архитектору');
    assert.match(text, /роды биологии: Бактерии/, 'роды подписаны');
    assert.match(text, /соберите образцы до начала стройки/, 'есть предупреждение экзобиологу');
  } finally {
    await ui.cleanup();
  }
});

test('каталог честно объясняет, почему постройку нельзя поставить на тело', async () => {
  const ui = await renderArchitect();
  try {
    await ui.click(ui.cardButton(`${SYSTEM} A 1`, '+ постройка'));
    assert.match(ui.text(), /Выбор постройки/);

    // Военная установка требует военное поселение — кнопка выключена, причина видна.
    const blocked = ui.rowButton('Военная установка');
    assert.ok(blocked, 'строка военной установки есть в каталоге');
    assert.equal(blocked.disabled, true);
    assert.match(ui.text(), /Сначала нужен предшественник: военное поселение/);

    // Астероидная база — только у пояса: у каменистой планеты колец нет.
    const asteroid = ui.rowButton('Астероидная база');
    assert.equal(asteroid.disabled, true);
    assert.match(ui.text(), /пояса астероидов/);

    // Сельхозпоселение подходит — кладём его в план.
    const valid = ui.rowButton('Сельхозпоселение (малое)');
    assert.equal(valid.disabled, false);
    await ui.click(valid);

    const text = ui.text();
    assert.doesNotMatch(text, /Выбор постройки/, 'каталог закрылся после выбора');
    assert.match(text, /Сельхозпоселение \(малое\)/);
    assert.match(text, /наземных слотов: 1 из 2/);
    assert.match(text, /2 839 т|2\u00a0839 т/);
    assert.match(ui.dom.window.localStorage.getItem(`ed-architect:plan:${SYSTEM.toLowerCase()}`) || '', /consus/);
  } finally {
    await ui.cleanup();
  }
});

test('сводка пересчитывается: тоннаж, очки системы и порядок стройки', async () => {
  const ui = await renderArchitect();
  try {
    await ui.click(ui.cardButton(`${SYSTEM} A 1`, '+ постройка'));
    await ui.click(ui.rowButton('Сельхозпоселение (малое)'));
    await ui.click(ui.cardButton(`${SYSTEM} A`, '+ постройка'));
    await ui.click(ui.rowButton('Гражданский аванпост'));

    const text = ui.text();
    // 2 839 + 18 473 = 21 312 т
    assert.match(text, /21 312 т|21\u00a0312 т/);
    assert.match(text, /Порядок стройки/);
    assert.match(text, /Очки T2/);
    assert.match(text, /получаем 2/, 'поселение и аванпост T1 дают по очку T2');
    assert.match(text, /Гражданский аванпост/);
  } finally {
    await ui.cleanup();
  }
});

test('копирование сводки без доступа к буферу обмена сообщает об этом', async () => {
  const ui = await renderArchitect();
  try {
    await ui.click(ui.cardButton(`${SYSTEM} A 1`, '+ постройка'));
    await ui.click(ui.rowButton('Сельхозпоселение (малое)'));
    await ui.click(ui.buttonByText('Копировать сводку'));
    assert.match(ui.text(), /Буфер обмена|буферу обмена/);
  } finally {
    await ui.cleanup();
  }
});

test('ошибки API показываются как понятный текст, а не пустой экран', async () => {
  const ui = await renderArchitect();
  try {
    const previousFetch = global.fetch;
    const input = ui.document.querySelector('input');

    // 1. Сервер ответил 500 с текстом ошибки (например, нет ключей Supabase).
    global.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Missing env vars: NEXT_PUBLIC_SUPABASE_URL' }),
    });
    await ui.typeInto(input, 'Сломанная система');
    await ui.click(ui.buttonByText('Загрузить систему'));
    assert.match(ui.text(), /Missing env vars: NEXT_PUBLIC_SUPABASE_URL/);

    // 2. Ответ успешный, но тел в системе нет.
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, bodies: [] }) });
    await ui.typeInto(input, 'Пустая система');
    await ui.click(ui.buttonByText('Загрузить систему'));
    assert.match(ui.text(), /Тел в системе не найдено/);

    global.fetch = previousFetch;
  } finally {
    await ui.cleanup();
  }
});

test('прогресс стройплощадок подтягивается и сверяется с планом', async () => {
  const projects = [{
    buildId: 'b-1',
    marketId: 4242,
    buildName: 'Agricultural Settlement',
    buildType: '$Agricultural_Settlement;',
    bodyName: `${SYSTEM} A 1`,
    progress: 42,
    complete: false,
    totalRequired: 2839,
    totalProvided: 1192,
  }];
  const ui = await renderArchitect({
    api: (url) => (url.includes('/api/systems/progress')
      ? { status: 200, body: { source: 'raven', projects } }
      : null),
  });
  try {
    // Пока плана нет, площадка честно показана как «строится, но не в плане».
    assert.match(ui.text(), /Фактический прогресс/);
    assert.match(ui.text(), /Строится, но не в плане/);

    await ui.click(ui.cardButton(`${SYSTEM} A 1`, '+ постройка'));
    await ui.click(ui.rowButton('Сельхозпоселение (малое)'));

    const text = ui.text();
    assert.match(text, /площадка: 42 %/, 'бейдж прогресса у постройки плана');
    assert.match(text, /1\s?192 т из 2\s?839 т/, 'тоннаж площадки из данных Raven');
    assert.match(text, /42\s?%/, 'прогресс системы по тоннажу');
    assert.match(text, /На площадке \$Agricultural_Settlement;, в плане consus/);

    // Кнопка обновления перезапрашивает площадки, а не перерисовывает старые.
    await ui.click(ui.buttonByText('Обновить'));
    assert.ok(ui.fetchCalls.filter((call) => call.includes('/api/systems/progress')).length >= 2);
  } finally {
    await ui.cleanup();
  }
});

test('план сохраняется на сервере, публикуется и получает ссылку', async () => {
  const view = {
    id: 'plan-abc123',
    system: SYSTEM,
    title: 'Первая очередь',
    authorId: 'u-1',
    authorName: 'CMDR Tester',
    visibility: 'public',
    siteCount: 1,
    haulTons: 2839,
    score: 1,
    tierPoints: { tier2: 1, tier3: 0 },
    catalogueVersion: 3,
    stale: false,
    notes: '',
    publishedAt: '2026-09-25T10:00:00.000Z',
    createdAt: '2026-09-25T09:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    own: true,
  };
  const posts = [];
  const ui = await renderArchitect({
    api: (url, init) => {
      if (url.includes('/api/architect/plans') && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return { status: 201, body: { plan: view } };
      }
      if (url.includes('/api/architect/plans?system=')) {
        return { status: 200, body: { system: SYSTEM, plans: [view], count: 1 } };
      }
      return null;
    },
  });
  try {
    await ui.click(ui.cardButton(`${SYSTEM} A 1`, '+ постройка'));
    await ui.click(ui.rowButton('Сельхозпоселение (малое)'));
    await ui.click(ui.buttonByText('публичный'));
    await ui.click(ui.buttonByText('Сохранить на сервере'));

    assert.equal(posts.length, 1, 'план ушёл на сервер одним запросом');
    assert.equal(posts[0].system, SYSTEM);
    assert.equal(posts[0].visibility, 'public');
    assert.equal(posts[0].plan.sites[0].installationId, 'consus');

    const text = ui.text();
    assert.match(text, /Сохранение и публикация/);
    assert.match(text, /\/architect\?plan=plan-abc123/, 'ссылка, которой делятся планом');
    assert.match(text, /Первая очередь/);
    assert.match(text, /публичный · 1 постр\./);
  } finally {
    await ui.cleanup();
  }
});

test('«где купить» считает закупки по рынкам и показывает остановки', async () => {
  // Раскладку считаем настоящим движком — панель должна уметь её показать.
  const { buildOffers, planSourcing } = await import('../../src/lib/architect/sourcing.ts');
  const cargo = { steel: 14_076, titanium: 8_205 };
  const rows = [
    { station_name: 'Alpha Station', system_name: 'Near', commodity_name: '$Steel_Name;', sell_price: 500, stock: 9_000, reported_at: new Date().toISOString() },
    { station_name: 'Alpha Station', system_name: 'Near', commodity_name: 'Titanium', sell_price: 1200, stock: 5_000, reported_at: new Date().toISOString() },
    { station_name: 'Beta Hub', system_name: 'Far', commodity_name: 'Steel', sell_price: 420, stock: 6_000, reported_at: new Date().toISOString() },
  ];
  const offers = buildOffers(cargo, rows, {
    origin: { x: 0, y: 0, z: 0 },
    coordsByName: new Map([['near', { x: 8, y: 0, z: 0 }], ['far', { x: 40, y: 0, z: 0 }]]),
  });
  const plan = planSourcing(cargo, offers, { capacityTons: 720 });

  const ui = await renderArchitect({
    api: (url, init) => (url.includes('/api/architect/sourcing')
      ? { status: 200, body: { source: 'db', system: SYSTEM, originFound: true, rowsScanned: rows.length, offers: offers.length, empty: false, plan } }
      : null),
  });
  try {
    await ui.click(ui.cardButton(`${SYSTEM} A 1`, '+ постройка'));
    await ui.click(ui.rowButton('Сельхозпоселение (малое)'));

    assert.match(ui.text(), /Где купить/);
    await ui.click(ui.buttonByText('Рассчитать закупки'));

    const text = ui.text();
    // Сталь закрыта целиком (9 000 + 5 076), титан — только 5 000 из 8 205.
    assert.match(text, /85,6 %/, 'покрытие считается по тоннажу всех товаров');
    assert.match(text, /осталось 3\s?205/, 'недобор по титану показан честно');
    assert.match(text, /закрыто/);
    assert.match(text, /Остановки перевозчика/);
    assert.match(text, /Alpha Station/);
    assert.match(text, /Near · 8 св\. лет/);
    assert.match(text, /Сталь|Титан/);
    assert.ok(ui.fetchCalls.some((call) => call.startsWith('POST') && call.includes('/api/architect/sourcing')));
  } finally {
    await ui.cleanup();
  }
});

test('открытие плана по ссылке подставляет его вместо черновика', async () => {
  const draft = {
    version: 1,
    system: SYSTEM,
    architect: 'CMDR Other',
    sites: [{ id: 's1', bodyName: `${SYSTEM} A 1`, installationId: 'consus', status: 'plan' }],
  };
  const ui = await renderArchitect({
    url: 'http://localhost/architect?plan=plan-xyz',
    api: (url) => (url.includes('/api/architect/plans/plan-xyz')
      ? {
        status: 200,
        body: {
          plan: {
            id: 'plan-xyz',
            system: SYSTEM,
            title: 'Чужой план',
            authorId: 'u-2',
            authorName: 'CMDR Other',
            visibility: 'unlisted',
            siteCount: 1,
            haulTons: 2839,
            score: 1,
            tierPoints: { tier2: 1, tier3: 0 },
            catalogueVersion: 3,
            stale: false,
            notes: '',
            publishedAt: null,
            createdAt: null,
            updatedAt: '2026-09-25T10:00:00.000Z',
            own: false,
          },
          draft,
        },
      }
      : null),
  });
  try {
    const text = ui.text();
    assert.match(text, /Открыт план «Чужой план» автора CMDR Other/);
    assert.match(text, /Сельхозпоселение \(малое\)/, 'постройки плана на месте');
    assert.ok(ui.fetchCalls.some((call) => call.includes('/api/architect/plans/plan-xyz')));
  } finally {
    await ui.cleanup();
  }
});
