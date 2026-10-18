/**
 * Слой «PowerPlay» карты Atlas в jsdom и по исходникам.
 *
 *   * карточка системы (`PowerplaySystemCard`): держава, состояние и его зона,
 *     дата наблюдения, зоны влияния своей и чужих держав, ссылки, кнопки;
 *   * значок состояния (`PowerplayGlyph`) — те же формы, что в шейдере;
 *   * позиции 3D-слоя — тот же кадр карты, что `eliteToThreeCentered`;
 *   * подключение: вкладка и слой только в Atlas, клик по точке разбирает
 *     `MapClickLayer`, импорт — задача планировщика и ленивое обновление.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleFile } from './helpers/bundle.mjs';
import { powerplayInfluenceAt } from '../../src/lib/powerplay.ts';
import { JOBS, DEFAULT_JOBS } from '../job-schedule.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const ENTRY = `
export { PowerplaySystemCard } from '@/components/GalaxyMap/PowerplaySystemCard';
export { PowerplayGlyph, PowerSwatch } from '@/components/GalaxyMap/PowerplayGlyph';
`;

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { href, children, prefetch, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;

const NOW = Date.parse('2026-10-18T12:00:00Z');

const SYSTEMS = [
  { id64: '2557888041682', name: 'Prajan', nameLc: 'prajan', x: 56.59375, y: 139.59375, z: 10.78125, power: 'Edmund Mahon', state: 'Stronghold', observedAt: NOW - 2 * 86_400_000 },
  { id64: '2518755068267', name: 'Fedmich', nameLc: 'fedmich', x: 60, y: 140, z: 10, power: 'Edmund Mahon', state: 'Fortified', observedAt: null },
  { id64: '3657332560586', name: 'Seedi', nameLc: 'seedi', x: 55, y: 135, z: 0, power: 'Edmund Mahon', state: 'Exploited', observedAt: NOW - 3600_000 },
  { id64: '2656194005355', name: 'Rival Hold', nameLc: 'rival hold', x: 70, y: 130, z: 0, power: 'Nakato Kaine', state: 'Stronghold', observedAt: null },
];

async function setup() {
  const { JSDOM } = await import('jsdom');
  const bundle = await bundleFile({
    entrySource: ENTRY,
    stubs: { 'next/link': NEXT_LINK_STUB },
    external: ['react', 'react-dom', 'react-dom/client'],
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/atlas' });
  const previous = {
    window: global.window, document: global.document, HTMLElement: global.HTMLElement, Element: global.Element, Node: global.Node,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const mod = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = async (element) => {
    await act(async () => { root.render(element); });
  };
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };
  return { React, mod, render, click, cleanup, document: dom.window.document };
}

test('карточка системы PowerPlay: держава, состояние, дата, зоны влияния и ссылки', async () => {
  const ui = await setup();
  try {
    const system = SYSTEMS[2];
    const influence = powerplayInfluenceAt(system, SYSTEMS, { excludeId64: system.id64 });
    let closed = 0;
    const focused = [];
    await ui.render(ui.React.createElement(ui.mod.PowerplaySystemCard, {
      system, influence, now: NOW, onClose: () => { closed += 1; }, onFocus: (item) => focused.push(item.name),
    }));
    const card = ui.document.querySelector('.powerplay-system-card');
    assert.ok(card, 'карточка отрисована');
    assert.equal(card.getAttribute('role'), 'dialog');
    assert.equal(card.getAttribute('data-powerplay-system'), '3657332560586');
    const text = card.textContent;
    assert.match(text, /Seedi/);
    assert.match(text, /Edmund Mahon/);
    assert.match(text, /Альянс/);
    assert.match(text, /Эксплуатируемая · Exploited/);
    assert.match(text, /своей зоны влияния не даёт/);
    assert.match(text, /Данные EDSM: 18\.10\.2026 \(сегодня\)/);
    assert.match(text, /55\.0, 135\.0, 0\.0/);

    const zones = Array.from(card.querySelectorAll('[data-powerplay-influence]')).map((item) => item.getAttribute('data-powerplay-influence'));
    assert.deepEqual(zones, ['Edmund Mahon', 'Nakato Kaine'], 'сначала ближайшая зона');
    assert.match(card.querySelector('[data-powerplay-influence="Edmund Mahon"]').textContent, /своя держава/);
    assert.match(card.querySelector('[data-powerplay-influence="Edmund Mahon"]').textContent, /оплот Prajan, \d+,\d св\. лет · зон: 2/);
    assert.match(card.querySelector('[data-powerplay-influence="Nakato Kaine"]').textContent, /оплот Rival Hold/);

    const links = Array.from(card.querySelectorAll('a')).map((link) => link.getAttribute('href'));
    assert.ok(links.includes('/system/Seedi'), 'имя ведёт на страницу системы');
    assert.ok(links.includes('https://www.edsm.net/en/system?systemName=Seedi'));
    assert.ok(links.includes('https://inara.cz/elite/starsystem/?search=Seedi'));
    assert.ok(links.includes('https://spansh.co.uk/system/3657332560586'));

    await ui.click(Array.from(card.querySelectorAll('button')).find((button) => (button.textContent || '').includes('К системе')));
    assert.deepEqual(focused, ['Seedi']);
    await ui.click(card.querySelector('button[aria-label="Закрыть карточку"]'));
    assert.equal(closed, 1);

    // Оплот без чужих зон рядом: честное «ничего не дотягивается».
    const lonely = { ...SYSTEMS[0], x: 9000, y: 0, z: 0, observedAt: null };
    await ui.render(ui.React.createElement(ui.mod.PowerplaySystemCard, { system: lonely, influence: [], now: NOW, onClose: () => {} }));
    const lonelyText = ui.document.querySelector('.powerplay-system-card').textContent;
    assert.match(lonelyText, /Оплот · Stronghold/);
    assert.match(lonelyText, /зона влияния 30 св\. лет/);
    assert.match(lonelyText, /дата наблюдения неизвестна/);
    assert.match(lonelyText, /Ни один оплот \(30 св\. лет\) или укреплённая система \(20 св\. лет\) сюда не дотягивается/);
    assert.equal(ui.document.querySelector('.powerplay-system-card button')?.textContent?.includes('К системе'), false, 'без onFocus кнопки нет');
  } finally {
    await ui.cleanup();
  }
});

test('значок состояния: звезда, кольцо с ядром, точка', async () => {
  const ui = await setup();
  try {
    await ui.render(ui.React.createElement('div', null,
      ui.React.createElement(ui.mod.PowerplayGlyph, { state: 'Stronghold', color: '#ff0000' }),
      ui.React.createElement(ui.mod.PowerplayGlyph, { state: 'Fortified', color: '#00ff00', size: 20 }),
      ui.React.createElement(ui.mod.PowerplayGlyph, { state: 'Exploited', color: '#0000ff', title: 'своя подпись' }),
      ui.React.createElement(ui.mod.PowerSwatch, { color: '#123456' })));
    const glyphs = Array.from(ui.document.querySelectorAll('[data-powerplay-glyph]'));
    assert.deepEqual(glyphs.map((svg) => svg.getAttribute('data-powerplay-glyph')), ['Stronghold', 'Fortified', 'Exploited']);
    assert.equal(glyphs[0].getAttribute('aria-label'), 'Оплот');
    assert.equal(glyphs[0].querySelector('path').getAttribute('fill'), '#ff0000');
    assert.equal(glyphs[1].getAttribute('width'), '20');
    assert.equal(glyphs[1].querySelectorAll('circle').length, 2, 'кольцо и ядро');
    assert.equal(glyphs[1].querySelector('circle').getAttribute('stroke'), '#00ff00');
    assert.equal(glyphs[2].getAttribute('aria-label'), 'своя подпись');
    assert.equal(glyphs[2].querySelectorAll('circle').length, 1);
  } finally {
    await ui.cleanup();
  }
});

test('позиции 3D-слоя — тот же кадр карты, что eliteToThreeCentered', async () => {
  const bundle = await bundleFile({
    entrySource: `
      export { powerplayPositions } from '@/components/GalaxyMap/PowerplayPoints';
      export { eliteToThreeCentered } from '@/lib/ed3dCanon';
    `,
    external: ['react', 'react-dom', 'react-dom/client', '@react-three/fiber', 'three'],
  });
  const mod = await import(bundle);
  const positions = mod.powerplayPositions(SYSTEMS);
  assert.equal(positions.length, SYSTEMS.length * 3);
  SYSTEMS.forEach((system, index) => {
    const expected = mod.eliteToThreeCentered(system);
    assert.ok(Math.abs(positions[index * 3] - expected.x) < 1e-3, `x ${system.name}`);
    assert.ok(Math.abs(positions[index * 3 + 1] - expected.y) < 1e-3, `y ${system.name}`);
    assert.ok(Math.abs(positions[index * 3 + 2] - expected.z) < 1e-3, `z ${system.name}`);
  });
});

test('подключение: вкладка и слой — в Atlas, клик — через MapClickLayer, импорт — задача и API', () => {
  const page = read('src/app/atlas/page.tsx');
  assert.match(page, /\{ id: 'powerplay', label: 'PowerPlay'/, 'седьмая вкладка');
  assert.match(page, /useAtlasPowerplay\(\{ tabActive: activeTab === 'powerplay' \}\)/);
  assert.match(page, /<AtlasPowerplayPanel powerplay=\{powerplay\} \/>/);
  assert.match(page, /powerplay=\{powerplayLayer\}/, 'страница отдаёт слой карте');

  const mapPage = read('src/app/map/page.tsx');
  assert.doesNotMatch(mapPage, /powerplay/i, 'на /map слоя нет — он живёт во вкладке Atlas');

  const map = read('src/components/GalaxyMap/GalaxyMap.tsx');
  assert.match(map, /powerplaySystems=\{powerplaySystems\}/);
  assert.match(map, /onPickPowerplay=\{handleSelectPowerplay\}/);
  assert.match(map, /<PowerplaySystemCard/);
  assert.match(map, /'atlas-focus-powerplay'/, 'строка вкладки ведёт камеру');
  assert.match(map, /className="powerplay-layer-controls"/, 'переключатель в панели слоёв карты');

  const scene = read('src/components/GalaxyMap/GalaxyScene.tsx');
  assert.match(scene, /extraPoints=\{powerplayPick\}/);
  assert.match(scene, /<PowerplayPoints systems=\{powerplaySystems\}/);
  assert.match(scene, /<PowerplaySelection system=\{selectedPowerplay\}/);

  const points = read('src/components/GalaxyMap/PowerplayPoints.tsx');
  assert.match(points, /raycast=\{\(\) => null\}/, 'встроенный raycast по десяткам тысяч вершин выключен');
  const click = read('src/components/GalaxyMap/AllSystemsPoints.tsx');
  assert.match(click, /extraPickRef\.current\(hit\.index\)/);

  const job = JOBS.find((item) => item.name === 'powerplay-sync');
  assert.ok(job, 'задача планировщика есть');
  assert.equal(job.path, '/api/cron/powerplay-sync');
  assert.equal(job.period, 12 * 60 * 60 * 1000);
  assert.ok(DEFAULT_JOBS.includes('powerplay-sync'), 'включена по умолчанию: дамп маленький');
  const compose = read('docker-compose.yml');
  assert.equal((compose.match(/translate,powerplay-sync\}/g) || []).length, 2, 'и в jobs, и в мониторинге');
  assert.match(read('.env.example'), /^JOBS_ENABLED=.*powerplay-sync/m);
  assert.match(read('deploy/crontab.example'), /--once powerplay-sync/);
});
