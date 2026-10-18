/**
 * Карточка системы в браузере (jsdom): разделы сводки `SystemOverviewSections`
 * рисуются по ответу `GET /api/systems/overview` и ведут в разделы сайта.
 *
 * Ответ строится той же чистой функцией, что и на сервере
 * (`shapeSystemOverview`), из сырого результата `system_overview_sources`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { href, children, prefetch, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;

const ENTRY = `
export { default as SystemOverviewSections, SystemLinksBar } from '@/components/System/SystemOverviewSections';
export { shapeSystemOverview } from '@/lib/systemOverview';
`;

const SYSTEM = 'Col 285 Sector AB-C d14-3';
const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const RAW = {
  key: SYSTEM.toLowerCase(),
  id64: '36028797018963971',
  catalog: { id64: '36028797018963971', name: SYSTEM, x: -24.5, y: -33.8, z: 108.8, main_star: 'K', star_type: 'K', needs_permit: false },
  raven: [],
  depots: [{
    system_key: SYSTEM.toLowerCase(), market_id: '3956123401', system_name: SYSTEM,
    construction_name: 'Orbital Construction Site: Ring Hub', construction_progress: 45,
    resources_total: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 450 }], event_timestamp: iso(-3600_000),
  }],
  plans: [{ id: 'plan-1', system_name: SYSTEM, title: 'Публичный план', author_id: 'arch', author_name: 'Member', visibility: 'public', site_count: 3, haul_tons: 90000, updated_at: iso(-86400_000), plan: {} }],
  architect: { system_name: SYSTEM, user_id: 'arch', name: 'Member' },
  squadron_projects: [{ project_id: 7, name: 'Кольцо', status: 'active', color: '#e67e22', squadron_id: 3, squadron_name: 'Ring Pioneers', squadron_tag: 'RING', system_status: 'building' }],
  architect_projects: [
    { project_id: 'p-member', name: 'Мой проект', status: 'active', stage: 'building', is_member: true, progress_summary: { progress: 33.3 } },
    { project_id: 'p-hidden', name: 'Чужой проект', status: 'active', stage: 'planned', is_member: false },
  ],
  route: { id: 1, system_name: SYSTEM, sort_order: 42, status: 'building', progress: 40 },
  hub: null,
  stations: [
    { station_key: 'm:1', market_id: '128000001', station_name: 'Ring Hub', station_type: 'Coriolis', observed_at: iso(-1800_000), source: 'colonial-helper', distance_to_arrival: 512, services: ['commodities'], engineers: [], inventories: { market: { observed_at: iso(-1800_000), items: 40, source: 'colonial-helper' } } },
    { station_key: 'm:2', market_id: '3700000009', station_name: 'ABC-123', station_type: 'FleetCarrier', observed_at: iso(-7200_000), source: 'eddn', inventories: {} },
  ],
  powerplay: { id64: '36028797018963971', name: SYSTEM, power: 'Jerome Archer', state: 'Fortified', powers: ['Jerome Archer', 'Yuri Grom'], control_progress: 0.42, reinforcement: 1200, undermining: 300, observed_at: iso(-3600_000), source: 'helper' },
  factions: {
    system: { id64: '36028797018963971', name: SYSTEM, x: -24.5, y: -33.8, z: 108.8, allegiance: 'Independent', government: 'Cooperative', economy: 'Colony', security: 'Low', population: 18457, controlling_faction: 'Ring Colony Pioneers', observed_at: iso(-3600_000), source: 'helper' },
    factions: [{ id: 1, name: 'Ring Colony Pioneers', allegiance: 'Independent', government: 'Cooperative', influence: 0.612, state: 'Expansion', active_states: ['Expansion'], systems_count: 2, controlled_count: 1 }],
  },
  goals: [{ cg_id: 777, title: 'Помощь кольцу', station_name: 'Ring Hub', tier_current: 2, tier_max: 5, expiry_date: iso(3 * 86400_000), is_colonisation_related: true }],
  deliveries: { tons: 1000, pilots: 2, last_at: iso(-7200_000) },
  scans: { bodies: 2, updated_at: iso(-86400_000) },
};

const CARRIER = {
  id: '3700000009', type: 'FleetCarrier', callsign: 'ABC-123', name: 'Ring Hauler', relation: 'other', owner: 'Pilot', ownerHidden: false,
  squadron: null, system: SYSTEM, body: null, position: null, locationAt: iso(-3600_000), estimated: false, previousSystem: null,
  jump: null, docking: 'Для всех', notorious: false, services: [], decommission: false,
};

async function setup() {
  const { JSDOM } = await import('jsdom');
  const bundle = await bundleFile({
    entrySource: ENTRY,
    stubs: { 'next/link': NEXT_LINK_STUB },
    external: ['react', 'react-dom', 'react-dom/client'],
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/system/x' });
  const previous = { window: global.window, document: global.document, HTMLElement: global.HTMLElement, Element: global.Element, Node: global.Node, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
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
  const render = async (element) => { await act(async () => { root.render(element); }); };
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };
  return { React, mod, render, cleanup, document: dom.window.document };
}

test('разделы карточки системы: колонизация, проекты, фракции, PowerPlay, станции, авианосцы, сообщество', async () => {
  const { React, mod, render, cleanup, document } = await setup();
  try {
    const overview = mod.shapeSystemOverview(SYSTEM.toLowerCase(), RAW, { userId: 'viewer', isAdmin: false }, [CARRIER]);
    assert.equal(overview.projects.architect.length, 1, 'чужой «Проект системы» отброшен ещё на сервере');
    await render(React.createElement(React.Fragment, null,
      React.createElement(mod.SystemLinksBar, { overview }),
      React.createElement(mod.SystemOverviewSections, { overview })));
    const text = document.body.textContent;
    for (const expected of [
      'Колонизация — все источники', 'Публичный план', 'Проекты и кольцо', 'Кольцо', '[RING] Ring Pioneers', 'Мой проект',
      'Минорные фракции', 'Ring Colony Pioneers', '61,2%', 'PowerPlay', 'Jerome Archer', 'Укреплённая', '42%',
      'Станции (1)', 'Ring Hub', 'Авианосцы (1)', 'ABC-123', 'Помощь кольцу', 'Источники данных',
    ]) assert.ok(text.includes(expected), `нет «${expected}»`);
    assert.ok(!text.includes('Чужой проект'));

    const hrefs = Array.from(document.querySelectorAll('a')).map((link) => link.getAttribute('href'));
    assert.ok(hrefs.includes('/projects/7'), 'проект эскадрильи');
    assert.ok(hrefs.includes('/squadrons/3'), 'эскадрилья');
    assert.ok(hrefs.includes('/architect/projects/p-member'), '«Проект системы»');
    assert.ok(hrefs.some((href) => href?.startsWith('/atlas?tab=factions') && href.includes('focus_id64=36028797018963971')), 'карта фракций с системой');
    assert.ok(hrefs.some((href) => href?.startsWith('/atlas?tab=powerplay')), 'карта PowerPlay');
    assert.ok(hrefs.some((href) => href?.startsWith('/station-search?reference=')), 'поиск по станциям');
    assert.ok(hrefs.includes('https://spansh.co.uk/system/36028797018963971'));

    // Без колонизации (страница уже показала живой Raven) раздел не дублируется.
    await render(React.createElement(mod.SystemOverviewSections, { overview, showColonisation: false }));
    assert.ok(!document.body.textContent.includes('Колонизация — все источники'));

    // Пустая система — пустые разделы не рисуются.
    const empty = mod.shapeSystemOverview('Nowhere', { key: 'nowhere' }, { userId: null, isAdmin: false });
    assert.equal(empty.found, false);
    await render(React.createElement(mod.SystemOverviewSections, { overview: empty }));
    assert.equal(document.querySelectorAll('[data-testid="system-overview"] section').length, 0);
  } finally {
    await cleanup();
  }
});
