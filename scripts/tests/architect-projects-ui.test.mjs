/**
 * Интерфейс «Проектов систем» в jsdom: список и создание проекта, страница
 * проекта со вкладками (обзор, системы, лидеры, участники, авианосцы,
 * настройки) и панель проектов в планировщике.
 *
 * Компоненты собираются esbuild'ом (`next/link` и `next/navigation` —
 * заглушки), сеть — подставной `fetch`. Ответы API строятся теми же чистыми
 * функциями, что и на сервере (`buildProjectProgress`, `buildProjectLeaders`),
 * поэтому форма данных у интерфейса и маршрутов одна.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { buildProjectProgress } from '../../src/lib/architect/projectProgress.ts';
import { buildProjectLeaders } from '../../src/lib/architect/projectLeaders.ts';
import { projectPermissions, PROJECT_LIMITS } from '../../src/lib/architect/projects.ts';

const ENTRY = `
export { default as ProjectsHub } from '@/components/Architect/projects/ProjectsHub';
export { default as ProjectView } from '@/components/Architect/projects/ProjectView';
export { default as SystemProjectsPanel } from '@/components/Architect/SystemProjectsPanel';
export { default as ArchitectNav } from '@/components/Architect/ArchitectNav';
`;

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { href, children, prefetch, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;

const NEXT_NAVIGATION_STUB = `
const g: any = globalThis as any;
g.__routerPushes = g.__routerPushes || [];
export function useRouter() {
  return { push: (url: string) => g.__routerPushes.push(url), replace: (url: string) => g.__routerPushes.push(url), refresh: () => {}, back: () => {} };
}
export function usePathname() { return '/architect/projects'; }
export function useSearchParams() { return new URLSearchParams(); }
`;

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const MEMBER = '00000000-0000-4000-8000-0000000000b2';

function fixtureDetail(role = 'owner') {
  const viewerId = role === 'owner' ? OWNER : MEMBER;
  const editable = role === 'owner' ? ['stage', 'priority', 'planId', 'responsibleId', 'targetDate', 'notes', 'sortOrder', 'name'] : [];
  return {
    project: {
      id: PROJECT_ID, name: 'Кольцо Пегаса', description: 'Строим кольцо из трёх систем', status: 'active', color: '#3498db',
      targetDate: '2026-12-31', trackingSince: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
    },
    viewer: { userId: viewerId, role, isAdmin: false, permissions: projectPermissions(role) },
    members: [
      { userId: OWNER, name: 'Owner Pilot', avatarUrl: null, squadron: 'ALPHA', role: 'owner', duty: '', joinedAt: '2026-10-01T00:00:00Z', addedByName: null, isYou: viewerId === OWNER },
      { userId: MEMBER, name: 'Member Pilot', avatarUrl: null, squadron: null, role: 'member', duty: 'вожу сталь', joinedAt: '2026-10-02T00:00:00Z', addedByName: 'Owner Pilot', isYou: viewerId === MEMBER },
    ],
    systems: [
      { id: 's1', name: 'HIP 100', key: 'hip 100', stage: 'building', priority: 1, planId: null, plan: null, responsibleId: MEMBER, responsibleName: 'Member Pilot', targetDate: null, notes: '', sortOrder: 1, createdAt: null, updatedAt: null, editable },
      { id: 's2', name: 'HIP 200', key: 'hip 200', stage: 'planned', priority: 2, planId: null, plan: null, responsibleId: null, responsibleName: null, targetDate: null, notes: '', sortOrder: 2, createdAt: null, updatedAt: null, editable },
    ],
    carriers: [{
      carrierId: '3700000002', systemId: 's1', systemName: 'HIP 100', purpose: 'склад стали', shareCargo: true, addedById: MEMBER,
      addedByName: 'Member Pilot', createdAt: null, canManage: role === 'owner', canShare: false,
      carrier: {
        carrierId: '3700000002', type: 'FleetCarrier', callsign: 'MEM-002', name: 'Member Depot', relation: 'public', ownerSource: null, squadronId: null,
        location: { system: 'HIP 100', systemAddress: null, body: null, coords: null, at: null, source: null, estimated: false, previousSystem: null },
        jump: null, status: { dockingAccess: 'all', dockingLabel: 'все', allowNotorious: null, fuelLevel: null, jumpRangeCurr: null, jumpRangeMax: null, pendingDecommission: false, statsAt: null },
        services: [], stationServices: [], space: { totalCapacity: 25000, cargo: 4000, freeSpace: 16000, reserved: 0, cargoCapacity: 20000, statsAt: null },
        finance: null, cargo: { items: [{ commodity: 'steel', name: 'Steel', quantity: 4000, baselineAt: null, baselineSource: null, updatedAt: null }], trackedTotal: 4000, baselineAt: null, baselineSource: null, updatedAt: null },
        orders: [], market: null, updatedAt: null, sharedCargo: true,
      },
    }],
    limits: PROJECT_LIMITS,
  };
}

function fixtureProgress() {
  return buildProjectProgress(
    [{ id: 's1', name: 'HIP 100', planId: null }, { id: 's2', name: 'HIP 200', planId: null }],
    {
      raven: [{
        system_key: 'hip 100', system_name: 'HIP 100', updated_at: new Date(Date.now() - 3600_000).toISOString(),
        data: { projects: [{ buildId: 'b1', marketId: '3900000001', buildName: 'Alpha Port', buildType: 'coriolis', complete: false, progress: 50, bodyName: 'HIP 100 A',
          resources: [{ name: 'Steel', key: 'steel', required: null, provided: null, remaining: 500, exact: false }], totalRequired: 1000, totalProvided: 500, totalRemaining: 500 }] },
      }],
      depots: [],
      plans: [],
    },
  );
}

function fixtureLeaders() {
  return buildProjectLeaders({
    rows: [
      { user_id: MEMBER, target: 'site', system_name: 'HIP 100', market_id: '3900000001', station_name: null, commodity: 'Steel', tons: 800, ops: 4, first_at: '2026-10-01T00:00:00Z', last_at: '2026-10-03T00:00:00Z' },
      { user_id: OWNER, target: 'site', system_name: 'HIP 100', market_id: '3900000001', station_name: null, commodity: 'Titanium', tons: 300, ops: 2, first_at: '2026-10-02T00:00:00Z', last_at: '2026-10-02T00:00:00Z' },
      { user_id: OWNER, target: 'carrier', system_name: null, market_id: '3700000002', station_name: null, commodity: 'steel', tons: 2000, ops: 1, first_at: null, last_at: null },
    ],
    activity: [
      { day: '2026-10-01', user_id: MEMBER, target: 'site', tons: 400 },
      { day: '2026-10-03', user_id: MEMBER, target: 'site', tons: 400 },
      { day: '2026-10-02', user_id: OWNER, target: 'site', tons: 300 },
    ],
    pilots: new Map([
      [OWNER, { name: 'Owner Pilot', member: true, role: 'owner', hidden: false }],
      [MEMBER, { name: 'Member Pilot', member: true, role: 'member', hidden: false }],
    ]),
    sites: new Map([['3900000001', { name: 'Alpha Port', systemName: 'HIP 100' }]]),
    carriers: new Map([['3700000002', 'Member Depot · MEM-002']]),
    viewerId: OWNER,
  });
}

async function render(createElement, options = {}) {
  const { JSDOM } = await import('jsdom');
  const bundle = await bundleFile({
    entrySource: ENTRY,
    stubs: { 'next/link': NEXT_LINK_STUB, 'next/navigation': NEXT_NAVIGATION_STUB },
    external: ['react', 'react-dom', 'react-dom/client'],
  });

  const fetchCalls = [];
  const previousFetch = global.fetch;
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  global.fetch = async (url, init) => {
    const target = String(url);
    const call = { method: init?.method ?? 'GET', url: target, body: init?.body ? JSON.parse(init.body) : undefined };
    fetchCalls.push(call);
    const custom = options.api?.(call);
    if (custom) return json(custom.body, custom.status ?? 200);
    return json({ error: 'not found' }, 404);
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: options.url ?? 'http://localhost/architect/projects',
  });
  const previous = {
    window: global.window, document: global.document, HTMLElement: global.HTMLElement, Element: global.Element, Node: global.Node,
    navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT, getComputedStyle: global.getComputedStyle,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.getComputedStyle = dom.window.getComputedStyle;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  dom.window.confirm = () => true;
  globalThis.__routerPushes = [];

  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  const mod = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async (ms = 20) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  await act(async () => { root.render(createElement(React, mod)); });
  await flush(40);

  const document = dom.window.document;
  const text = () => document.body.textContent || '';
  const click = async (element) => {
    assert.ok(element, 'элемент для клика найден');
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush(25);
  };
  const typeInto = async (element, value) => {
    assert.ok(element, 'поле ввода найдено');
    const proto = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype
      : element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype
        : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
      element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
    await flush(10);
  };
  const button = (pattern) => Array.from(document.querySelectorAll('button')).find((item) => (typeof pattern === 'string'
    ? (item.textContent || '').trim() === pattern
    : pattern.test(item.textContent || '')));
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'navigator') Object.defineProperty(global, 'navigator', { value, configurable: true });
      else global[key] = value;
    }
  };
  return { dom, document, text, click, typeInto, button, flush, cleanup, fetchCalls };
}

test('список проектов: карточки со сводкой, создание проекта ведёт на его страницу', async () => {
  const ui = await render((React, mod) => React.createElement(mod.ProjectsHub), {
    api: (call) => {
      if (call.method === 'GET' && call.url === '/api/architect/projects') {
        return { body: { isAdmin: false, all: false, owned: 1, projects: [{
          id: PROJECT_ID, name: 'Кольцо Пегаса', description: 'Три системы', status: 'active', color: '#3498db', role: 'owner',
          targetDate: null, createdAt: null, updatedAt: '2026-10-10T00:00:00Z', counts: { systems: 3, members: 4, carriers: 1 },
          progress: { progress: 42.5, systems: 3, systemsDone: 1, systemsBuilding: 1, sites: 6, sitesComplete: 2, doneTons: 42000, totalTons: 100000, remaining: 58000 },
          progressAt: new Date().toISOString(), ownerName: 'Owner Pilot',
        }] } };
      }
      if (call.method === 'POST' && call.url === '/api/architect/projects') return { status: 201, body: { id: 'new-project-id' } };
      return null;
    },
  });
  try {
    const text = ui.text();
    assert.match(text, /Проекты систем/);
    assert.match(text, /Кольцо Пегаса/);
    assert.match(text, /1\/3/, 'готовые системы из сводки');
    assert.match(text, /Планировщик системы/, 'вкладки раздела архитектора на месте');
    const card = ui.document.querySelector(`a[href="/architect/projects/${PROJECT_ID}"]`);
    assert.ok(card, 'карточка ведёт на страницу проекта');

    await ui.click(ui.button('+ Новый проект'));
    await ui.typeInto(ui.document.querySelector('input[placeholder="Например: Кольцо Пегаса"]'), 'Новый проект');
    await ui.typeInto(ui.document.querySelector('textarea[placeholder^="HIP 90297"]'), 'HIP 1\nhip 1\nHIP 2');
    assert.match(ui.text(), /Систем: 2 · повторы пропущены: 1/);
    await ui.click(ui.button('Создать проект'));
    const post = ui.fetchCalls.find((call) => call.method === 'POST');
    assert.deepEqual(post.body.systems, ['HIP 1', 'HIP 2']);
    assert.equal(post.body.name, 'Новый проект');
    assert.deepEqual(globalThis.__routerPushes, ['/architect/projects/new-project-id']);
  } finally {
    await ui.cleanup();
  }
});

test('список проектов гостю: просит войти, форму не показывает', async () => {
  const ui = await render((React, mod) => React.createElement(mod.ProjectsHub), {
    api: (call) => (call.url === '/api/architect/projects' ? { status: 401, body: { error: 'Войдите' } } : null),
  });
  try {
    assert.match(ui.text(), /Нужен вход/);
    assert.equal(ui.button('+ Новый проект'), undefined);
  } finally {
    await ui.cleanup();
  }
});

function projectApi(role = 'owner') {
  const detail = fixtureDetail(role);
  const progress = { ...fixtureProgress(), computedAt: new Date().toISOString() };
  const leaders = { ...fixtureLeaders(), trackingSince: null, generatedAt: new Date().toISOString() };
  const base = `/api/architect/projects/${PROJECT_ID}`;
  return (call) => {
    if (call.method === 'GET' && call.url === base) return { body: detail };
    if (call.method === 'GET' && call.url === `${base}/progress`) return { body: progress };
    if (call.method === 'GET' && call.url.startsWith(`${base}/leaderboard`)) return { body: leaders };
    if (call.method === 'POST' && call.url === `${base}/progress`) return { body: { ...progress, refreshed: 1, failed: [], pending: 0, throttled: false } };
    if (call.url.startsWith('/api/architect/plans')) return { body: { plans: [] } };
    if (call.method === 'PATCH') return { body: { ok: true } };
    return null;
  };
}

test('страница проекта: обзор, лидеры с разбивкой «что и куда», участники, системы, авианосцы', async () => {
  const ui = await render((React, mod) => React.createElement(mod.ProjectView, { projectId: PROJECT_ID }), {
    url: `http://localhost/architect/projects/${PROJECT_ID}`,
    api: projectApi('owner'),
  });
  try {
    let text = ui.text();
    assert.match(text, /Кольцо Пегаса/);
    assert.match(text, /Общий прогресс/);
    assert.match(text, /Прогресс по системам/);
    assert.match(text, /HIP 100/);
    assert.match(text, /Member Pilot/, 'топ лидеров в обзоре');
    assert.match(text, /Что ещё везти/);
    assert.match(text, /Сталь/);

    await ui.click(ui.button(/^Лидеры$/));
    text = ui.text();
    assert.match(text, /Рейтинг пилотов/);
    assert.match(text, /Кто и куда: пилот × площадка/);
    assert.match(text, /По товарам — кто сколько привёз/);
    assert.match(text, /По площадкам — кто сколько сдал/);
    assert.match(text, /Alpha Port/);
    assert.match(text, /Member Depot · MEM-002/, 'груз на авианосцы — отдельным блоком');
    assert.equal(ui.dom.window.location.hash, '#leaders', 'вкладка в адресе страницы');

    const row = Array.from(ui.document.querySelectorAll('tr[aria-expanded]')).find((item) => (item.textContent || '').includes('Member Pilot'));
    await ui.click(row);
    const headers = Array.from(ui.document.querySelectorAll('th')).map((item) => item.textContent);
    assert.ok(headers.includes('Товар'), 'раскрылась разбивка пилота: площадка × товар');

    await ui.click(ui.button('7 дней'));
    assert.ok(ui.fetchCalls.some((call) => call.url.includes('/leaderboard?period=7d&scope=all')), 'период уходит на сервер');

    await ui.click(ui.button(/^Участники/));
    text = ui.text();
    assert.match(text, /Состав проекта/);
    assert.match(text, /вожу сталь/);
    assert.ok(ui.button('Сделать модератором'), 'создатель может назначить модератора');
    assert.ok(ui.button('Передать проект'));

    await ui.click(ui.button(/^Системы/));
    text = ui.text();
    assert.match(text, /Добавить системы/);
    assert.match(text, /по тоннажу площадок/);
    await ui.click(ui.button(/HIP 100/));
    assert.match(ui.text(), /Площадки/);
    await ui.click(ui.button('Изменить'));
    const stage = Array.from(ui.document.querySelectorAll('select')).find((item) => Array.from(item.options).some((option) => option.value === 'on_hold'));
    assert.ok(stage, 'редактор этапа');
    await ui.flush(20);

    await ui.click(ui.button(/^Авианосцы/));
    text = ui.text();
    assert.match(text, /Member Depot · MEM-002/);
    assert.match(text, /груз виден проекту/);
    assert.match(text, /склад стали/);

    await ui.click(ui.button(/^Настройки/));
    assert.match(ui.text(), /Удалить проект/);
    assert.match(ui.text(), /Передать проект/);

    await ui.click(ui.button('Обновить из Raven'));
    assert.ok(ui.fetchCalls.some((call) => call.method === 'POST' && call.url.endsWith('/progress')));
    assert.match(ui.text(), /Из Raven обновлено систем: 1/);
  } finally {
    await ui.cleanup();
  }
});

test('страница проекта участнику: только просмотр, без управления составом и удаления', async () => {
  const ui = await render((React, mod) => React.createElement(mod.ProjectView, { projectId: PROJECT_ID }), {
    url: `http://localhost/architect/projects/${PROJECT_ID}#members`,
    api: projectApi('member'),
  });
  try {
    assert.match(ui.text(), /Состав проекта/, 'вкладка из адреса');
    assert.equal(ui.button('Сделать модератором'), undefined);
    assert.equal(ui.text().includes('Добавить участника'), false);
    assert.ok(ui.button('Выйти'), 'участник может выйти сам');
    await ui.click(ui.button(/^Настройки/));
    assert.equal(ui.text().includes('Удалить проект'), false);
    assert.match(ui.text(), /Покинуть проект/);
  } finally {
    await ui.cleanup();
  }
});

test('закрытый проект: постороннему — «Проект недоступен»', async () => {
  const ui = await render((React, mod) => React.createElement(mod.ProjectView, { projectId: PROJECT_ID }), {
    url: `http://localhost/architect/projects/${PROJECT_ID}`,
    api: () => ({ status: 404, body: { error: 'Проект не найден' } }),
  });
  try {
    assert.match(ui.text(), /Проект недоступен/);
    assert.ok(ui.document.querySelector('a[href="/architect/projects"]'));
  } finally {
    await ui.cleanup();
  }
});

test('панель планировщика: проекты системы, привязка плана, добавление в проект', async () => {
  const ui = await render((React, mod) => React.createElement('div', null,
    React.createElement(mod.ArchitectNav, { active: 'planner' }),
    React.createElement(mod.SystemProjectsPanel, { systemName: 'HIP 100', planId: 'plan-42', onNotice: () => {} })), {
    url: 'http://localhost/architect?system=HIP%20100',
    api: (call) => {
      if (call.method === 'GET' && call.url.startsWith('/api/architect/projects?system=')) {
        return { body: {
          system: 'HIP 100',
          projects: [{ id: 'p1', name: 'Кольцо Пегаса', color: '#3498db', status: 'active', role: 'owner', systemId: 's1', stage: 'building', planId: null }],
          manageable: [{ id: 'p2', name: 'Второй проект', color: '#e67e22' }],
        } };
      }
      if (call.method === 'PATCH' || call.method === 'POST') return { status: call.method === 'POST' ? 201 : 200, body: { ok: true } };
      return null;
    },
  });
  try {
    const active = ui.document.querySelector('a[aria-current="page"]');
    assert.equal(active.textContent, 'Планировщик системы');
    assert.ok(ui.document.querySelector('a[href="/architect/projects"]'));
    assert.match(ui.text(), /Кольцо Пегаса/);
    assert.match(ui.text(), /строится/);

    await ui.click(ui.button('Привязать этот план к проекту'));
    const patch = ui.fetchCalls.find((call) => call.method === 'PATCH');
    assert.equal(patch.url, '/api/architect/projects/p1/systems');
    assert.deepEqual(patch.body, { systemId: 's1', planId: 'plan-42' });

    const select = ui.document.querySelector('select[aria-label="Проект"]');
    await ui.typeInto(select, 'p2');
    await ui.click(ui.button('Добавить'));
    const post = ui.fetchCalls.find((call) => call.method === 'POST');
    assert.equal(post.url, '/api/architect/projects/p2/systems');
    assert.deepEqual(post.body, { systems: ['HIP 100'] });
  } finally {
    await ui.cleanup();
  }
});
