/**
 * Слой «Авианосцы» карты в jsdom: панель фильтра (переключатель, «чьи»,
 * «класс», список систем), карточка системы с носителями и значок.
 *
 * Компоненты собираются esbuild'ом (`next/link` — заглушка). Данные
 * строятся теми же функциями, что и на карте (`groupCarriersBySystem`,
 * `countMapCarriers`, `filterMapCarriers`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import {
  DEFAULT_CARRIER_FILTER,
  countMapCarriers,
  filterMapCarriers,
  groupCarriersBySystem,
} from '../../src/lib/carrierMap.ts';

const ENTRY = `
export { CarrierLayerControls } from '@/components/GalaxyMap/CarrierLayerControls';
export { CarrierSystemCard } from '@/components/GalaxyMap/CarrierSystemCard';
export { CarrierGlyph } from '@/components/GalaxyMap/CarrierGlyph';
`;

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { href, children, prefetch, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;

const NOW = Date.parse('2026-10-17T12:00:00Z');
const MIN = 60_000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const later = (ms) => new Date(NOW + ms).toISOString();

function carrier(overrides) {
  return {
    id: '1', type: 'FleetCarrier', callsign: null, name: null, relation: 'other', owner: null, ownerHidden: false, squadron: null,
    system: 'Sol', body: null, position: { x: 0, y: 0, z: 0 }, locationAt: ago(5 * MIN), estimated: false, previousSystem: null, jump: null,
    docking: 'все пилоты', notorious: false, services: [], decommission: false,
    ...overrides,
  };
}

const CARRIERS = [
  carrier({
    id: '3700000001', name: 'My Hauler', callsign: 'MYC-001', relation: 'own', owner: 'Viewer Pilot', system: 'HIP 100',
    position: { x: 10, y: 1, z: -20 }, services: ['Рынок товаров', 'Заправка', 'Ремонт', 'Перевооружение', 'Верфь', 'Снаряжение', 'Бар'],
    jump: { system: 'Achenar', departureAt: later(12 * MIN), state: 'scheduled', position: { x: 67.5, y: -119.5, z: 24.8 } },
  }),
  carrier({
    id: '3709000002', type: 'SquadronCarrier', name: 'Wing Bank', callsign: 'SQD-002', relation: 'squadron', system: 'HIP 100',
    position: { x: 10, y: 1, z: -20 }, squadron: { id: 7, name: 'Alpha Wing', tag: 'ALP', member: true }, docking: 'только эскадрилья',
  }),
  carrier({
    id: '3700000003', name: 'Shy Depot', callsign: 'SHY-003', system: 'HIP 100', position: { x: 10, y: 1, z: -20 }, ownerHidden: true,
    decommission: true, notorious: true,
  }),
  carrier({ id: '3700000004', name: 'Mate Depot', callsign: 'MAT-004', relation: 'squadron', owner: 'Mate Pilot', system: 'Lave', position: { x: 75, y: 48, z: -12 } }),
  carrier({
    id: '3700000005', callsign: 'ARR-005', system: 'Achenar', position: null, estimated: true, previousSystem: 'Lave', body: 'Achenar 3',
  }),
];

async function setup() {
  const { JSDOM } = await import('jsdom');
  const bundle = await bundleFile({
    entrySource: ENTRY,
    stubs: { 'next/link': NEXT_LINK_STUB },
    external: ['react', 'react-dom', 'react-dom/client'],
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/map' });
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

  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  const mod = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  const document = dom.window.document;
  const render = async (element) => { await act(async () => { root.render(element); }); };
  const click = async (element) => {
    assert.ok(element, 'элемент для клика найден');
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  const buttons = () => Array.from(document.querySelectorAll('button'));
  const button = (pattern) => buttons().find((item) => pattern.test((item.textContent || '').trim()));
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'navigator') Object.defineProperty(global, 'navigator', { value, configurable: true });
      else global[key] = value;
    }
  };
  return { React, mod, document, render, click, button, buttons, cleanup, text: () => document.body.textContent || '' };
}

test('панель слоя: счётчики, фильтр «чьи» и «класс», список систем ведёт к системе', async () => {
  const ui = await setup();
  try {
    const { React, mod } = ui;
    const calls = { show: [], selected: [] };

    // Обёртка с настоящим состоянием — как в GalaxyMap.
    function Harness({ signedIn = true }) {
      const [show, setShow] = React.useState(true);
      const [filter, setFilter] = React.useState(DEFAULT_CARRIER_FILTER);
      const [selected, setSelected] = React.useState(null);
      const visible = filterMapCarriers(CARRIERS, filter);
      return React.createElement(mod.CarrierLayerControls, {
        show,
        onShowChange: (value) => { calls.show.push(value); setShow(value); },
        filter,
        onFilterChange: setFilter,
        counts: countMapCarriers(CARRIERS),
        visibleCount: visible.length,
        groups: groupCarriersBySystem(visible),
        selectedKey: selected,
        onSelectGroup: (group) => { calls.selected.push(group); setSelected(group.key); },
        status: 'ready',
        signedIn,
      });
    }

    await ui.render(React.createElement(Harness));
    assert.match(ui.text(), /Авианосцы \(5\)/);
    assert.ok(ui.button(/^Мой 1$/), 'фишка «Мой» со счётчиком');
    assert.ok(ui.button(/^Эскадрилья 2$/));
    assert.ok(ui.button(/^Другие 2$/));
    assert.ok(ui.button(/^Drake 4$/));
    assert.ok(ui.button(/^Javelin 1$/));
    assert.match(ui.text(), /В каких системах \(3\)/);

    const rows = () => Array.from(ui.document.querySelectorAll('[data-carrier-system]'));
    assert.deepEqual(rows().map((row) => row.getAttribute('data-carrier-system')), ['hip 100', 'lave', 'achenar'],
      'система со своим носителем первой');
    const hip = rows()[0];
    assert.match(hip.textContent, /HIP 100/);
    assert.match(hip.textContent, /×3/);
    assert.match(hip.textContent, /My Hauler, Wing Bank и ещё 1/);
    assert.match(hip.textContent, /прыжок → Achenar/);
    assert.match(rows()[2].textContent, /нет координат системы/);
    assert.ok(hip.querySelector('svg[data-carrier-glyph="drake"][data-carrier-tone="own"]'), 'значок своего носителя в строке');

    await ui.click(hip);
    assert.equal(calls.selected.length, 1);
    assert.equal(calls.selected[0].key, 'hip 100');
    assert.equal(rows()[0].getAttribute('aria-pressed'), 'true');

    await ui.click(ui.button(/^Другие 2$/));
    assert.match(ui.text(), /Авианосцы \(3\/5\)/, 'отфильтрованный слой показывает «видно/всего»');
    assert.equal(ui.button(/^Другие 2$/).getAttribute('aria-pressed'), 'false');
    assert.deepEqual(rows().map((row) => row.getAttribute('data-carrier-system')), ['hip 100', 'lave']);

    await ui.click(ui.button(/^Drake 4$/));
    assert.deepEqual(rows().map((row) => row.getAttribute('data-carrier-system')), ['hip 100'], 'остался только Javelin эскадрильи');
    assert.match(rows()[0].textContent, /Wing Bank/);
    await ui.click(ui.button(/^Эскадрилья 2$/));
    assert.match(ui.text(), /Под выбранный фильтр носителей нет/);

    await ui.click(ui.button(/В каких системах/));
    assert.equal(rows().length, 0);
    assert.equal(ui.button(/В каких системах/).getAttribute('aria-expanded'), 'false');

    const checkbox = ui.document.querySelector('.carrier-layer-controls input[type="checkbox"]');
    await ui.click(checkbox);
    assert.deepEqual(calls.show, [false]);
    assert.ok(!ui.button(/^Мой/), 'выключенный слой прячет фильтр');

    await ui.render(React.createElement(Harness, { signedIn: false, key: 'guest' }));
    assert.match(ui.text(), /Войдите, чтобы отличать свои носители/);
  } finally {
    await ui.cleanup();
  }
});

test('карточка системы: носители по порядку, владельцы, эскадрилья, службы, прыжок и ссылки', async () => {
  const ui = await setup();
  try {
    const { React, mod } = ui;
    const [hip, , achenar] = groupCarriersBySystem(CARRIERS);
    const calls = { close: 0, focus: [] };
    await ui.render(React.createElement(mod.CarrierSystemCard, {
      group: hip,
      now: NOW,
      onClose: () => { calls.close += 1; },
      onFocus: (group) => calls.focus.push(group.key),
    }));

    const text = ui.text();
    assert.match(text, /Авианосцы: 3 носителя/);
    assert.match(text, /10\.0, 1\.0, -20\.0/);
    const links = Array.from(ui.document.querySelectorAll('a')).map((link) => link.getAttribute('href'));
    assert.ok(links.includes('/system/HIP%20100'), 'название системы ведёт на её страницу');
    assert.ok(links.includes('/account?tab=carrier'), 'свой носитель ведёт в профиль');
    assert.ok(links.includes('/squadrons/7?tab=carrier'), 'носитель эскадрильи ведёт на её вкладку');
    assert.ok(links.includes('/squadrons/7'));
    assert.ok(links.includes('/cmdr/Viewer%20Pilot'));

    const items = Array.from(ui.document.querySelectorAll('li[data-carrier-id]'));
    assert.deepEqual(items.map((item) => item.getAttribute('data-carrier-id')), ['3700000001', '3709000002', '3700000003']);
    const [mine, bank, shy] = items;
    assert.match(mine.textContent, /My Hauler/);
    assert.match(mine.textContent, /MYC-001 · Drake/);
    assert.match(mine.textContent, /ваш носитель/);
    assert.match(mine.textContent, /Службы: Рынок товаров, Заправка, Ремонт, Перевооружение, Верфь и ещё 2/);
    assert.match(mine.textContent, /прыжок → Achenar, вылет через 12 мин/);
    assert.match(mine.textContent, /данные 5 мин назад/);
    assert.match(bank.textContent, /SQD-002 · Javelin/);
    assert.match(bank.textContent, /Эскадрилья: \[ALP\] Alpha Wing/);
    assert.match(bank.textContent, /Стыковка: только эскадрилья/);
    assert.ok(bank.querySelector('svg[data-carrier-glyph="javelin"]'), 'у Javelin свой значок');
    assert.match(shy.textContent, /Владелец скрыл местоположение/);
    assert.match(shy.textContent, /списывается/);
    assert.match(shy.textContent, /пускает преступников/);
    assert.ok(shy.querySelector('svg[data-carrier-tone="decommission"]'), 'списываемый носитель серый');
    assert.ok(!text.includes('Груз') && !text.includes('Баланс'), 'груза и финансов в карточке карты нет');

    await ui.click(ui.button(/К системе/));
    assert.deepEqual(calls.focus, ['hip 100']);
    await ui.click(ui.document.querySelector('button[aria-label="Закрыть карточку"]'));
    assert.equal(calls.close, 1);

    await ui.render(React.createElement(mod.CarrierSystemCard, { group: achenar, now: NOW, onClose: () => {}, onFocus: () => {} }));
    assert.match(ui.text(), /координаты системы неизвестны/);
    assert.match(ui.text(), /≈ после прыжка/);
    assert.match(ui.text(), /≈ прибыл после прыжка из Lave/);
    assert.match(ui.text(), /У тела: Achenar 3/);
    assert.match(ui.text(), /Владелец не привязан на сайте/);
    assert.ok(!ui.button(/К системе/), 'без координат лететь некуда');
  } finally {
    await ui.cleanup();
  }
});

test('карточка системы: чужой Javelin — с тегом своей эскадрильи из позывного, а не с эскадрильей зрителя', async () => {
  const ui = await setup();
  try {
    const { React, mod } = ui;
    const [group] = groupCarriersBySystem([
      carrier({ id: '3713124352', type: 'SquadronCarrier', name: 'ENDURANCE ENDEAVOUR', callsign: 'ENEX', system: 'LHS 5333' }),
      carrier({ id: '3713000002', type: 'SquadronCarrier', callsign: null, name: null, system: 'LHS 5333' }),
      carrier({
        id: '3713000003', type: 'SquadronCarrier', name: 'The Bearded Lady', callsign: 'CWIG', system: 'LHS 5333',
        squadron: { id: 2, name: 'Circle of Wigs', tag: 'CWIG', member: false },
      }),
    ]);
    await ui.render(React.createElement(mod.CarrierSystemCard, { group, now: NOW, onClose: () => {}, onFocus: () => {} }));
    const items = new Map(Array.from(ui.document.querySelectorAll('li[data-carrier-id]'))
      .map((item) => [item.getAttribute('data-carrier-id'), item]));

    const enex = items.get('3713124352');
    assert.match(enex.textContent, /ENEX · Javelin/);
    assert.match(enex.textContent, /Эскадрилья в игре: \[ENEX\] · на сайте не привязана/);
    assert.match(enex.textContent, /чужой носитель/);
    assert.doesNotMatch(enex.textContent, /Владелец не привязан/, 'у Javelin нет личного владельца');
    assert.equal(enex.querySelector('[data-carrier-game-squadron]').getAttribute('data-carrier-game-squadron'), 'ENEX');

    const unknown = items.get('3713000002');
    assert.match(unknown.textContent, /Эскадрилья на сайте не привязана/);
    assert.doesNotMatch(unknown.textContent, /Эскадрилья в игре/);

    const bound = items.get('3713000003');
    assert.match(bound.textContent, /Эскадрилья: \[CWIG\] Circle of Wigs/);
    const links = Array.from(bound.querySelectorAll('a')).map((link) => link.getAttribute('href'));
    assert.deepEqual(links, ['/squadrons/2'], 'чужой эскадрилье — только ссылка на её страницу, без «Носитель эскадрильи»');
  } finally {
    await ui.cleanup();
  }
});

test('значок: Drake — кольцо, Javelin — заполненный круг, списываемый перечёркнут; цвет по тону', async () => {
  const ui = await setup();
  try {
    const { React, mod } = ui;
    await ui.render(React.createElement('div', null,
      React.createElement(mod.CarrierGlyph, { glyph: 'drake', tone: 'own', title: 'свой' }),
      React.createElement(mod.CarrierGlyph, { glyph: 'javelin', tone: 'squadron' }),
      React.createElement(mod.CarrierGlyph, { glyph: 'drake', tone: 'decommission', size: 20 }),
    ));
    const [own, javelin, scrapped] = Array.from(ui.document.querySelectorAll('svg'));
    assert.equal(own.getAttribute('role'), 'img');
    assert.equal(own.getAttribute('aria-label'), 'свой');
    assert.equal(own.querySelector('path').getAttribute('stroke'), '#ffd166', 'свой носитель жёлтый, как в игре');
    assert.equal(own.querySelector('circle').getAttribute('fill'), null, 'у Drake круг — контур');
    assert.equal(javelin.getAttribute('aria-hidden'), 'true');
    assert.equal(javelin.querySelector('circle').getAttribute('fill'), '#4ade80', 'у Javelin круг заполнен');
    assert.equal(scrapped.getAttribute('width'), '20');
    assert.equal(scrapped.querySelectorAll('path').length, 2, 'списываемый носитель перечёркнут');
  } finally {
    await ui.cleanup();
  }
});
