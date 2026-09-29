/**
 * Блоки лидерборда в jsdom: «Самые застроенные системы» и «Топ архитекторов».
 *
 * Тот же приём, что в `architect-ui.test.mjs`: esbuild собирает компонент,
 * `next/link` подменяется якорем, сеть — заглушкой `fetch`, отвечающей
 * выдачей `/api/leaderboard/stats` прямо из теста.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  return React.createElement('a', { href: props.href }, props.children);
}
`;

const STATS_PAYLOAD = {
  period: 'all',
  builtSystems: [
    { rank: 1, system_name: 'HIP 90297', total_amount: 25_400, deliveries_count: 7, pilots: 3, progress: 75, status: 'building' },
    { rank: 2, system_name: 'Sol', total_amount: 12_100, deliveries_count: 4, pilots: 2, progress: 100, status: 'done' },
    { rank: 3, system_name: 'Col 285 Sector A', total_amount: 900, deliveries_count: 1, pilots: 1, progress: null, status: null },
  ],
  topArchitects: [
    { rank: 1, user_id: 'u-1', cmdr_name: 'CMDR Builder', plans_count: 4, sites_count: 18, haul_tons: 50_000, assigned_systems: 1, assigned_names: ['HIP 90297'] },
    { rank: 2, user_id: 'u-2', cmdr_name: 'CMDR Silent', plans_count: 0, sites_count: 0, haul_tons: 0, assigned_systems: 2, assigned_names: ['Sol', 'BX Andromedae'] },
  ],
};

async function renderStats(options = {}) {
  const esbuild = await import('esbuild');
  const { JSDOM } = await import('jsdom');

  const dir = mkdtempSync(join(ROOT, '.tmp-leaderboard-ui-'));
  const entry = join(dir, 'entry.tsx');
  const bundle = join(dir, 'bundle.mjs');
  writeFileSync(join(dir, 'next-link.tsx'), NEXT_LINK_STUB);
  writeFileSync(entry, "export { default as LeaderboardStats } from '@/components/LeaderboardStats';\n");

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client'],
    alias: {
      'next/link': join(dir, 'next-link.tsx'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    logLevel: 'silent',
  });

  const fetchCalls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    fetchCalls.push(target);
    if (target.includes('/api/leaderboard/stats')) {
      const body = options.statsBody ?? STATS_PAYLOAD;
      const status = options.statsStatus ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }
    // Косметика пилотов и прочие вспомогательные запросы — пусто.
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/leaderboard',
  });
  const previous = {
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
    Element: global.Element,
    Node: global.Node,
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
  const raf = (callback) => setTimeout(() => callback(Date.now()), 0);
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = raf;

  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const mod = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async (ms = 20) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  await act(async () => {
    root.render(React.createElement(mod.LeaderboardStats, { period: options.period ?? 'all' }));
  });
  await flush(60);

  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) global[key] = value;
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    dom,
    document: dom.window.document,
    text: () => dom.window.document.body.textContent || '',
    cleanup,
    fetchCalls,
    flush,
  };
}

test('блоки лидерборда: застроенные системы с тоннажом и прогрессом', async () => {
  const ui = await renderStats();
  try {
    assert.ok(ui.fetchCalls.some((url) => url.includes('/api/leaderboard/stats?period=all')));
    const text = ui.text();
    assert.match(text, /Самые застроенные системы/);
    assert.match(text, /Топ архитекторов/);
    assert.match(text, /HIP 90297/);
    assert.match(text, new RegExp(`${(25_400).toLocaleString('ru')} т`), 'тоннаж системы с русским разделителем');
    assert.match(text, /строится · 75%/);
    assert.match(text, /построена/);
    assert.match(text, /3 пил\. · 7 рейс\./);

    const link = Array.from(ui.document.querySelectorAll('a'))
      .find((item) => (item.textContent || '').includes('HIP 90297'));
    assert.ok(link, 'имя системы — ссылка на страницу системы');
    assert.equal(link.getAttribute('href'), `/system/${encodeURIComponent('HIP 90297')}`);
  } finally {
    await ui.cleanup();
  }
});

test('блоки лидерборда: архитекторы с закреплёнными системами и планами', async () => {
  const ui = await renderStats();
  try {
    const text = ui.text();
    assert.match(text, /CMDR Builder/);
    assert.match(text, /планов: 4 · построек: 18 ·/);
    assert.match(text, /★ архитектор: HIP 90297/);
    assert.match(text, /CMDR Silent/);
    assert.match(text, /без публичных планов/, 'архитектор без планов тоже в топе — по назначению');
    assert.match(text, /2 сист\./);
  } finally {
    await ui.cleanup();
  }
});

test('блоки лидерборда: пустая выдача — честные заглушки, а не пустые карточки', async () => {
  const ui = await renderStats({ statsBody: { period: 'week', builtSystems: [], topArchitects: [] } });
  try {
    const text = ui.text();
    assert.match(text, /Поставок за этот период не было/);
    assert.match(text, /Публичных планов пока нет/);
  } finally {
    await ui.cleanup();
  }
});

test('блоки лидерборда: ошибка API показывается сообщением', async () => {
  const ui = await renderStats({ statsStatus: 500, statsBody: { error: 'boom' } });
  try {
    assert.match(ui.text(), /Статистика недоступна: boom/);
  } finally {
    await ui.cleanup();
  }
});
