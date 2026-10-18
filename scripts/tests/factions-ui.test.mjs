/**
 * Минорные фракции: интерфейс в jsdom и подключение по исходникам.
 *
 *   * карточка системы на карте (`FactionSystemCard`): кто у власти, все
 *     фракции с влиянием и состояниями, «добавить на карту» / «убрать»;
 *   * раздел админки «Игровые данные → Фракции» (`FactionsAdminTab`): данные
 *     в базе, карточки «архив на сервере» и «куски → база» (как у каталога
 *     систем), этапы импорта с прогресс-барами, журнал, обновления пилотов,
 *     кнопки «Загрузить», «Остановить», «Скачать архив», «Разбить на куски»,
 *     «Загрузить куски в базу», «Удалить архив и куски», число соединений;
 *     «Загрузить архив с компьютера» — кусками, с продолжением после обрыва;
 *   * подключение: вкладка Atlas и слой карты, общий выбор точек с PowerPlay,
 *     раздел админки, загрузчик журналов в личном кабинете, Colonial Helper,
 *     миграция в снимке схемы, задача планировщика.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleFile } from './helpers/bundle.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const NOW = Date.parse('2026-10-18T12:00:00Z');

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props: any) {
  const { href, children, prefetch, ...rest } = props;
  return React.createElement('a', { href, ...rest }, children);
}
`;

const SUPABASE_CLIENT_STUB = `
export async function authFetch(input, init) {
  return globalThis.__bgsAdminFetch(String(input), init || {});
}
export const supabase = {};
`;

const ENTRY = `
export { FactionSystemCard } from '@/components/GalaxyMap/FactionSystemCard';
export { default as FactionsAdminTab } from '@/components/Admin/FactionsAdminTab';
`;

async function setup() {
  const { JSDOM } = await import('jsdom');
  const bundle = await bundleFile({
    entrySource: ENTRY,
    stubs: { 'next/link': NEXT_LINK_STUB, '@/lib/supabaseClient': SUPABASE_CLIENT_STUB },
    external: ['react', 'react-dom', 'react-dom/client'],
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/atlas' });
  const previous = {
    window: global.window, document: global.document, HTMLElement: global.HTMLElement, Element: global.Element, Node: global.Node,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT, fetch: global.fetch,
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
  const flush = async (ms = 20) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  const render = async (element) => {
    await act(async () => { root.render(element); });
    await flush(30);
  };
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush(30);
  };
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };
  return { React, mod, render, click, flush, cleanup, dom, act, document: dom.window.document };
}

const POINT = {
  key: '10477373803', id64: '10477373803', name: 'Sol', nameLc: 'sol', x: 0, y: 0, z: 0, color: '#f0af28', shape: 2, size: 12,
  background: false, influence: 0.7, observedAt: NOW - 2 * 3600_000,
  system: { id64: '10477373803', name: 'Sol', nameLc: 'sol', x: 0, y: 0, z: 0, allegiance: 'Federation', government: 'Democracy', controllingId: 1, controlling: 'Mother Gaia', population: 22780919531, factionsCount: 3, observedAt: NOW - 2 * 3600_000, source: 'helper' },
  entries: [{ factionId: 1, name: 'Mother Gaia', color: '#f0af28', influence: 0.7, state: 'Election', controls: true }],
};

const DETAIL = {
  system: {
    id64: '10477373803', name: 'Sol', x: 0, y: 0, z: 0, allegiance: 'Federation', government: 'Democracy', economy: 'Refinery',
    second_economy: 'Service', security: 'High', state: 'Election', population: 22780919531, controlling_faction_id: 1,
    controlling_faction: 'Mother Gaia', factions_count: 3, observed_at: '2026-10-18T10:00:00+00:00', source: 'helper',
  },
  factions: [
    { id: 1, name: 'Mother Gaia', allegiance: 'Federation', government: 'Democracy', is_player: false, influence: 0.7, state: 'Election', active_states: ['Election'], pending_states: [], recovering_states: ['Boom'], happiness: 'Happy', systems_count: 4, controlled_count: 2 },
    { id: 2, name: 'Sol Workers Party', allegiance: 'Federation', government: 'Democracy', is_player: false, influence: 0.2, state: 'Election', active_states: ['Election'], pending_states: ['Expansion'], recovering_states: [], happiness: 'Discontented', systems_count: 1, controlled_count: 0 },
    { id: 9, name: 'Sol Pilots Club', allegiance: 'Independent', government: 'Cooperative', is_player: true, influence: 0.1, state: 'None', active_states: [], pending_states: [], recovering_states: [], happiness: null, systems_count: 1, controlled_count: 0 },
  ],
};

test('карточка системы слоя «Фракции»: власть, фракции с влиянием, «на карту» и «убрать»', async () => {
  const ui = await setup();
  const requests = [];
  global.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => DETAIL };
  };
  try {
    const added = [];
    const removed = [];
    let closed = 0;
    await ui.render(ui.React.createElement(ui.mod.FactionSystemCard, {
      point: POINT,
      selectedColors: new Map([[1, '#f0af28']]),
      now: NOW,
      onClose: () => { closed += 1; },
      onAddFaction: (faction) => added.push(faction),
      onRemoveFaction: (id) => removed.push(id),
    }));
    await ui.flush(40);
    assert.deepEqual(requests, ['/api/factions/system?id64=10477373803']);
    const card = ui.document.querySelector('.bgs-system-card');
    assert.ok(card, 'карточка отрисована');
    assert.equal(card.getAttribute('role'), 'dialog');
    const text = card.textContent;
    assert.match(text, /У власти: Mother Gaia · Выборы/);
    assert.match(text, /Федерация · Демократия · безопасность высокая/);
    assert.match(text, /Экономика: Переработка \/ Сфера услуг · население 22,8 млрд/);
    assert.match(text, /Фракции системы \(3\)/);
    assert.match(text, /Данные: 18\.10\.2026 \(сегодня\) · Colonial Helper/);
    const rows = Array.from(card.querySelectorAll('[data-bgs-faction]')).map((item) => item.getAttribute('data-bgs-faction'));
    assert.deepEqual(rows, ['Mother Gaia', 'Sol Workers Party', 'Sol Pilots Club'], 'по убыванию влияния');
    const gaia = card.querySelector('[data-bgs-faction="Mother Gaia"]').textContent;
    assert.match(gaia, /70,0 %/);
    assert.match(gaia, /у власти/);
    assert.match(gaia, /затухает:Бум/);
    assert.match(card.querySelector('[data-bgs-faction="Sol Workers Party"]').textContent, /ожидается:Экспансия/);
    assert.match(card.querySelector('[data-bgs-faction="Sol Pilots Club"]').textContent, /PMF/);

    const links = Array.from(card.querySelectorAll('a')).map((link) => link.getAttribute('href'));
    assert.ok(links.includes('/system/Sol'));
    assert.ok(links.includes('https://www.edsm.net/en/system?systemName=Sol'));
    assert.ok(links.includes('https://spansh.co.uk/system/10477373803'));

    await ui.click(card.querySelector('button[aria-label="Показать Sol Workers Party на карте"]'));
    assert.deepEqual(added, [{ id: 2, name: 'Sol Workers Party', allegiance: 'Federation' }]);
    await ui.click(card.querySelector('button[aria-label="Убрать Mother Gaia с карты"]'));
    assert.deepEqual(removed, [1]);
    await ui.click(card.querySelector('button[aria-label="Закрыть карточку"]'));
    assert.equal(closed, 1);
  } finally {
    await ui.cleanup();
  }
});

/* ── Админка ───────────────────────────────────────────────────────────── */

function adminStatus(overrides = {}) {
  return {
    success: true,
    running: true,
    interrupted: false,
    mode: 'full',
    progress: {
      id: 'run-7', trigger: 'admin', force: false, mode: 'full', phase: 'running', stage: 'download', percent: 24.5,
      message: 'Скачивание архива на сервер: 120 МБ из 498 МБ', startedAt: '2026-10-18T11:50:00.000Z', updatedAt: '2026-10-18T11:59:00.000Z', finishedAt: null,
      stages: [
        { id: 'probe', status: 'done', done: 0, total: null, detail: '498 МБ · от Sat, 17 Oct 2026 04:50:00 GMT', startedAt: '2026-10-18T11:50:00.000Z', finishedAt: '2026-10-18T11:50:01.000Z' },
        { id: 'download', status: 'running', done: 125_829_120, total: 522_190_000, detail: '120 МБ из 498 МБ · соединений: 8 · 1,2 МБ/с · осталось ~5 мин 30 с', startedAt: '2026-10-18T11:50:01.000Z', finishedAt: null },
        { id: 'split', status: 'pending', done: 0, total: null, detail: '', startedAt: null, finishedAt: null },
        { id: 'import', status: 'pending', done: 0, total: null, detail: '', startedAt: null, finishedAt: null },
        { id: 'finish', status: 'pending', done: 0, total: null, detail: '', startedAt: null, finishedAt: null },
      ],
      result: null,
    },
    log: [
      { at: '2026-10-18T11:50:00.000Z', level: 'info', text: 'Запуск: вручную из админки · загрузка данных (скачать архив целиком → разбить на куски → записать в базу, по очереди)' },
      { at: '2026-10-18T11:55:00.000Z', level: 'warn', text: 'Скачивание: Кусок 12: обрыв на байте 1 000 — продолжаю' },
    ],
    state: {
      status: 'running', source_url: 'https://www.edsm.net/dump/systemsPopulated.json.gz', last_modified: null, dump_generated_at: '2026-10-11T04:50:00.000Z',
      dump_bytes: 521_000_000, systems_total: 31_250, factions_total: 76_500, presence_total: 160_000, error: null,
      attempt_at: '2026-10-18T11:50:00.000Z', checked_at: '2026-10-11T07:10:00.000Z', synced_at: '2026-10-11T07:40:00.000Z',
    },
    summary: {
      systems: 31_250, factions: 76_500, playerFactions: 1_820, presence: 160_000,
      allegiances: { Federation: 9000, Empire: 7000, Alliance: 3000, Independent: 12_000, None: 250 },
      sources: { edsm: 30_000, helper: 1_000, web: 250 },
      oldestObservation: '2024-01-01T00:00:00.000Z', newestObservation: '2026-10-18T11:00:00.000Z', fresh7d: 6_000,
      updates24h: 42, applied24h: 37, updates7d: 300, applied7d: 260, reporters7d: 5, lastUpdate: '2026-10-18T11:40:00.000Z',
    },
    summaryError: null,
    updates: [
      { received_at: '2026-10-18T11:40:00.000Z', source: 'helper', received: 3, applied: 2, stale: 1, created: 1, invalid: 0, systems: ['Sol', 'Fresh Colony'], cmdr: 'CMDR Nova' },
      { received_at: '2026-10-18T10:00:00.000Z', source: 'web', received: 120, applied: 30, stale: 90, created: 0, invalid: 2, systems: ['Lave', 'Leesti', 'Diso', 'Orrere', 'Zaonce'], cmdr: null },
    ],
    archive: {
      path: '/app/data/spansh/factions/edsm-systemsPopulated.json.gz', exists: true, bytes: 522_190_000, downloaded: 125_829_120, total: 522_190_000,
      partial: true, complete: false, lastModified: null, freeBytes: 80 * 1024 ** 3,
    },
    shards: {
      dir: '/app/data/spansh/factions/shards', exists: true, complete: false, shards: 0, imported: 0, systems: 0, importedSystems: 0,
      files: 0, bytes: 0, source: { url: 'https://www.edsm.net/dump/systemsPopulated.json.gz', lastModified: 'Sat, 17 Oct 2026 04:50:00 GMT', total: 522_190_000 },
      completedAt: null,
    },
    upload: { active: false, name: null, size: 0, received: 0, startedAt: null, chunkBytes: 8 * 1024 * 1024 },
    writer: { backend: 'pg', host: 'db', disabled: false },
    config: {
      dumpUrl: 'https://www.edsm.net/dump/systemsPopulated.json.gz', archiveKeep: false, segments: 8, maxSegments: 16, pieceBytes: 8 * 1024 * 1024,
      stallSeconds: 15, shortRequests: 'auto', shardSystems: 1000, batchSize: 250, minSystems: 1000,
      keepDays: 30, refreshDays: 7, nextScheduledRun: '2026-10-19T07:10:00.000Z', scheduleDecision: { action: 'skip', reason: 'running' },
    },
    serverTime: '2026-10-18T12:00:00.000Z',
    ...overrides,
  };
}

test('админка «Фракции»: данные в базе, этапы с прогресс-барами, журнал, обновления пилотов, кнопки', async () => {
  const ui = await setup();
  const posts = [];
  let payload = adminStatus();
  global.__bgsAdminFetch = async (url, init) => {
    if (init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      const action = JSON.parse(init.body).action;
      if (action === 'cleanup') return { ok: true, status: 200, json: async () => ({ success: true, removed: true, freed: 125_829_120 }) };
      return { ok: true, status: 200, json: async () => ({ success: true, cancelled: true }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
  ui.dom.window.confirm = () => true;
  try {
    await ui.render(ui.React.createElement(ui.mod.FactionsAdminTab));
    await ui.flush(40);
    const doc = ui.document;
    assert.match(doc.querySelector('[data-bgs-admin-pill]').textContent.replace(/[\u00a0\u202f]/g, ' '), /идёт загрузка дампа/);
    const data = doc.querySelector('[data-bgs-admin-data]').textContent.replace(/[\u00a0\u202f]/g, ' ');
    assert.match(data, /Населённых систем31 250/);
    assert.match(data, /Фракций76 500/);
    assert.match(data, /дамп EDSM 30 000 · Colonial Helper 1 000 · журнал на сайте 250/);
    assert.deepEqual(Array.from(doc.querySelectorAll('[data-bgs-admin-allegiance]')).map((row) => row.getAttribute('data-bgs-admin-allegiance')),
      ['Independent', 'Federation', 'Empire', 'Alliance', 'None'], 'по убыванию');

    const stages = Array.from(doc.querySelectorAll('[data-bgs-admin-stage]'));
    assert.deepEqual(stages.map((item) => [item.getAttribute('data-bgs-admin-stage'), item.getAttribute('data-status')]),
      [['probe', 'done'], ['download', 'running'], ['split', 'pending'], ['import', 'pending'], ['finish', 'pending']], 'шаги по очереди: разбивка ждёт скачивания');
    assert.match(stages[1].textContent.replace(/[\u00a0\u202f]/g, ' '), /120 МБ из 498 МБ · соединений: 8 · 1,2 МБ\/с · осталось ~5 мин 30 с/);
    assert.match(stages[1].textContent, /Скачивание архива на сервер/);
    assert.match(stages[2].textContent, /Разбивка на куски.*ждёт/);
    assert.match(stages[3].textContent, /Загрузка кусков в базу.*ждёт/);
    assert.equal(stages[1].querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '24');
    assert.match(doc.querySelector('[data-bgs-admin-progress]').textContent.replace(/[\u00a0\u202f]/g, ' '), /Идёт загрузка · 24,5 %/);
    assert.match(doc.querySelector('[data-bgs-admin-progress]').textContent, /Запуск: вручную из админки · загрузка данных/);
    const archiveCard = doc.querySelector('[data-bgs-admin-archive]').textContent.replace(/[\u00a0\u202f]/g, ' ');
    assert.match(archiveCard, /Архив на сервере/);
    assert.match(archiveCard, /Качается: 120 МБ из 498 МБ \(24 %\)/, 'скачано, а не размер выделенного файла');
    assert.match(archiveCard, /до 8 соединений, куски файла по 8 МБ · свободно на диске 80,0 ГБ/);
    const shardsCard = doc.querySelector('[data-bgs-admin-shards]').textContent.replace(/[\u00a0\u202f]/g, ' ');
    assert.match(shardsCard, /Кусков пока нет — архив разобьётся на куски, когда скачается целиком/);
    assert.match(doc.querySelector('[data-bgs-admin-writer]').textContent, /прямой Postgres \(db\) — кусок одним вызовом/);
    assert.match(doc.querySelector('[data-bgs-admin-sync]').textContent, /шаги по очереди: архив скачивается на сервер целиком.*затем разбивается на куски.*затем куски загружаются в базу/i);
    assert.match(doc.querySelector('[data-bgs-admin-sync]').textContent.replace(/[\u00a0\u202f]/g, ' '), /Соединение, молчащее 15 с \(FACTIONS_STALL_SECONDS\), переподключается/);
    assert.match(doc.querySelector('[data-bgs-admin-sync]').textContent, /сама переходит на короткие запросы/);
    assert.equal(doc.querySelector('[data-bgs-admin-action="upload"]').disabled, true, 'во время загрузки данных архив с компьютера не принимается');
    assert.equal(doc.querySelectorAll('[data-bgs-admin-log] [data-level="warn"]').length, 1);

    const updates = Array.from(doc.querySelectorAll('[data-bgs-admin-update]'));
    assert.equal(updates.length, 2);
    assert.match(updates[0].textContent.replace(/[\u00a0\u202f]/g, ' '), /Colonial Helper/);
    assert.match(updates[0].textContent.replace(/[\u00a0\u202f]/g, ' '), /CMDR Nova/);
    assert.match(updates[0].textContent.replace(/[\u00a0\u202f]/g, ' '), /3 \/ 2 \/ 1 \/ \+1/);
    assert.match(updates[1].textContent.replace(/[\u00a0\u202f]/g, ' '), /журнал на сайте/);
    assert.match(updates[1].textContent.replace(/[\u00a0\u202f]/g, ' '), /отброшено 2/);
    assert.match(updates[1].textContent.replace(/[\u00a0\u202f]/g, ' '), /и ещё 1/);
    assert.match(doc.querySelector('[data-bgs-admin-updates]').textContent.replace(/[\u00a0\u202f]/g, ' '), /Пилотов за 7 дней5/);
    assert.match(doc.querySelector('[data-bgs-admin-sync]').textContent.replace(/[\u00a0\u202f]/g, ' '), /Сейчас задача: импорт уже идёт/);

    const button = (action) => doc.querySelector(`[data-bgs-admin-action="${action}"]`);
    for (const action of ['start', 'force', 'download', 'split', 'import', 'cleanup']) {
      assert.equal(button(action).disabled, true, `во время импорта «${action}» недоступна`);
    }
    assert.equal(doc.querySelector('[data-bgs-admin-segments]').disabled, true);
    assert.equal(button('cancel').disabled, false);
    await ui.click(button('cancel'));
    assert.deepEqual(posts.at(-1), { action: 'cancel', force: false });

    // Импорт закончился: запуск и удаление архива снова доступны.
    payload = adminStatus({
      running: false,
      progress: { ...adminStatus().progress, phase: 'cancelled', finishedAt: '2026-10-18T12:00:00.000Z', result: { error: 'Импорт остановлен администратором' } },
      config: { ...adminStatus().config, scheduleDecision: { action: 'skip', reason: 'fresh' } },
    });
    await ui.click(doc.querySelector('button.btn'));
    await ui.flush(40);
    assert.equal(button('start').disabled, false);
    assert.match(button('start').textContent.replace(/[\u00a0\u202f]/g, ' '), /Загрузить сейчас/);
    assert.match(button('download').textContent, /Докачать архив/, 'архив скачан не полностью');
    assert.equal(button('split').disabled, true, 'разбивать нечего: архив не скачан целиком');
    assert.equal(button('import').disabled, true, 'и записывать в базу тоже');
    assert.match(doc.querySelector('[data-bgs-admin-progress]').textContent.replace(/[\u00a0\u202f]/g, ' '), /Импорт остановлен администратором/);

    // Число соединений уходит с запуском.
    const select = doc.querySelector('[data-bgs-admin-segments]');
    assert.equal(select.value, '8');
    assert.deepEqual(Array.from(select.options).map((option) => option.value), ['1', '2', '4', '6', '8', '12', '16']);
    await ui.act(async () => {
      select.value = '12';
      select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    });
    await ui.click(button('download'));
    assert.deepEqual(posts.at(-1), { action: 'download', force: false, segments: 12 });
    assert.match(doc.body.textContent.replace(/[\u00a0\u202f]/g, ' '), /Архив скачивается на сервер в 12 соедин/);
    await ui.click(button('start'));
    assert.deepEqual(posts.at(-1), { action: 'start', force: false, segments: 12 });
    await ui.click(button('force'));
    assert.deepEqual(posts.at(-1), { action: 'start', force: true, segments: 12 });

    await ui.click(button('cleanup'));
    assert.deepEqual(posts.at(-1), { action: 'cleanup', force: false });
    assert.match(doc.body.textContent.replace(/[\u00a0\u202f]/g, ' '), /Архив и куски удалены с сервера — освобождено 120 МБ/);

    // Архив скачан целиком, куски разбиты — доступны «Разбить» и «Загрузить куски в базу».
    payload = adminStatus({
      running: false,
      mode: null,
      progress: {
        ...adminStatus().progress, mode: 'download', phase: 'ok', finishedAt: '2026-10-18T12:00:00.000Z', percent: 100,
        message: 'Архив скачан на сервер: 498 МБ — «Загрузить данные» разобьёт его и запишет в базу без повторного скачивания',
        stages: adminStatus().progress.stages.map((stage) => ({ ...stage, status: ['probe', 'download'].includes(stage.id) ? 'done' : 'skipped' })),
        result: { archiveBytes: 522_190_000, durationMs: 600_000 },
      },
      archive: { ...adminStatus().archive, bytes: 522_190_000, downloaded: 522_190_000, partial: false, complete: true, lastModified: 'Sat, 17 Oct 2026 04:50:00 GMT' },
      shards: { ...adminStatus().shards, exists: false, shards: 0, imported: 0, systems: 0, importedSystems: 0, files: 0, bytes: 0 },
      writer: { backend: 'postgrest', host: null, disabled: false },
      config: { ...adminStatus().config, scheduleDecision: { action: 'skip', reason: 'fresh' } },
    });
    await ui.click(doc.querySelector('button.btn'));
    await ui.flush(40);
    assert.match(doc.querySelector('[data-bgs-admin-archive]').textContent.replace(/[\u00a0\u202f]/g, ' '), /Скачан целиком: 498 МБ \(дамп от Sat, 17 Oct 2026 04:50:00 GMT\)/);
    assert.match(doc.querySelector('[data-bgs-admin-shards]').textContent, /Кусков нет/);
    assert.match(doc.querySelector('[data-bgs-admin-writer]').textContent.replace(/[\u00a0\u202f]/g, ' '), /PostgREST — пачками по 250 систем/);
    assert.match(doc.querySelector('[data-bgs-admin-result]').textContent.replace(/[\u00a0\u202f]/g, ' '), /Архив на сервере: 498 МБ · за 10 мин 00 с — в базу пока ничего не записано/);
    assert.match(doc.querySelector('[data-bgs-admin-progress]').textContent, /Последний запуск: архив скачан/);
    assert.match(doc.querySelector('[data-bgs-admin-shards]').textContent, /архив скачан: «Разбить на куски» или «Загрузить данные» разобьют его/);
    assert.equal(button('split').disabled, false);
    assert.equal(button('import').disabled, false);
    await ui.click(button('split'));
    assert.deepEqual(posts.at(-1), { action: 'split', force: false });
    await ui.click(button('import'));
    assert.deepEqual(posts.at(-1), { action: 'import', force: false });
    assert.match(doc.body.textContent, /без обращения к EDSM/);
  } finally {
    delete global.__bgsAdminFetch;
    await ui.cleanup();
  }
});

test('админка «Фракции»: архив с компьютера — кусками, продолжение с принятого, 409, проверка, остановка', async () => {
  const ui = await setup();
  const calls = [];
  let payload = adminStatus({
    running: false,
    mode: null,
    progress: null,
    log: [],
    archive: { ...adminStatus().archive, exists: false, bytes: 0, downloaded: 0, total: null, partial: false, complete: false },
    shards: { ...adminStatus().shards, exists: false },
    upload: { active: true, name: 'systemsPopulated.json.gz', size: 3000, received: 1000, startedAt: '2026-10-18T11:00:00.000Z', chunkBytes: 1024 },
    config: { ...adminStatus().config, scheduleDecision: { action: 'skip', reason: 'fresh' } },
  });
  let refusedOnce = false;
  let holdPut = null;
  global.__bgsAdminFetch = async (url, init) => {
    if (url.startsWith('/api/admin/factions/upload')) {
      const offset = /offset=(\d+)/.exec(url)?.[1];
      if (init.method === 'PUT') {
        calls.push({ put: Number(offset), size: init.body.size });
        if (holdPut) await holdPut(init.signal);
        if (Number(offset) === 1000 && !refusedOnce) {
          // Сервер уже принял больше (прошлый ответ потерялся): продолжить с его размера.
          refusedOnce = true;
          return { ok: false, status: 409, json: async () => ({ success: false, error: 'Сервер принял 1024 байт', offset: 1024 }) };
        }
        const next = Number(offset) + init.body.size;
        return { ok: true, status: 200, json: async () => ({ success: true, offset: next, size: 3000, complete: next === 3000 }) };
      }
      const body = JSON.parse(init.body);
      calls.push({ post: body.action, ...(body.action === 'start' ? { name: body.name, size: body.size, lastModified: body.lastModified } : {}) });
      if (body.action === 'start') return { ok: true, status: 200, json: async () => ({ success: true, offset: 1000, size: 3000, resumed: true, chunkBytes: 1024 }) };
      if (body.action === 'finish') return { ok: true, status: 200, json: async () => ({ success: true, bytes: 3000, sameAsEdsm: true, name: 'systemsPopulated.json.gz' }) };
      if (body.action === 'cancel') return { ok: true, status: 200, json: async () => ({ success: true, removed: true, freed: 1000 }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
  ui.dom.window.confirm = () => true;
  const choose = async (file) => {
    const input = ui.document.querySelector('[data-bgs-admin-upload-input]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await ui.act(async () => {
      input.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    });
  };
  try {
    await ui.render(ui.React.createElement(ui.mod.FactionsAdminTab));
    await ui.flush(40);
    const doc = ui.document;
    const text = (selector) => doc.querySelector(selector)?.textContent.replace(/[\u00a0\u202f]/g, ' ') ?? '';
    assert.match(text('[data-bgs-admin-upload-pending]'), /Незаконченная загрузка: systemsPopulated\.json\.gz — 1 000 Б из 2,9 КБ\. Выберите тот же файл/);
    assert.match(text('[data-bgs-admin-upload]'), /Скачайте systemsPopulated\.json\.gz на этом компьютере и загрузите его сюда/);
    assert.equal(doc.querySelector('[data-bgs-admin-upload] a').getAttribute('href'), 'https://www.edsm.net/dump/systemsPopulated.json.gz');
    const upload = doc.querySelector('[data-bgs-admin-action="upload"]');
    assert.equal(upload.disabled, false);

    const file = new ui.dom.window.File([new Uint8Array(3000).fill(7)], 'systemsPopulated.json.gz', { lastModified: 1_760_000_000_000 });
    await choose(file);
    for (let i = 0; i < 40 && !calls.some((call) => call.post === 'finish'); i++) await ui.flush(20);
    assert.deepEqual(calls, [
      { post: 'start', name: 'systemsPopulated.json.gz', size: 3000, lastModified: 1_760_000_000_000 },
      { put: 1000, size: 1024 },
      { put: 1024, size: 1024 },
      { put: 2048, size: 952 },
      { post: 'finish' },
    ], 'продолжение с принятого сервером, после 409 — с его размера, кусками по chunkBytes');
    await ui.flush(40);
    assert.match(doc.body.textContent.replace(/[\u00a0\u202f]/g, ' '), /Архив загружен на сервер: 2,9 КБ — это тот же дамп, что сейчас на EDSM\. Нажмите «Загрузить данные»/);

    // Архив на сервере — загруженный с компьютера.
    payload = adminStatus({
      running: false, mode: null, progress: null, log: [],
      archive: { ...adminStatus().archive, bytes: 3000, downloaded: 3000, total: 3000, partial: false, complete: true, uploaded: true, uploadName: 'systemsPopulated.json.gz', lastModified: 'Sat, 17 Oct 2026 04:50:00 GMT' },
      shards: { ...adminStatus().shards, exists: false },
      config: { ...adminStatus().config, scheduleDecision: { action: 'skip', reason: 'fresh' } },
    });
    await ui.click(doc.querySelector('button.btn'));
    await ui.flush(40);
    assert.match(text('[data-bgs-admin-archive]'), /Загружен с компьютера целиком: 2,9 КБ \(systemsPopulated\.json\.gz\)/);
    assert.equal(doc.querySelector('[data-bgs-admin-upload-pending]'), null);

    // Остановка посреди куска: запрос обрывается, принятое остаётся на сервере.
    calls.length = 0;
    holdPut = (signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    await choose(new ui.dom.window.File([new Uint8Array(3000).fill(9)], 'systemsPopulated.json.gz', { lastModified: 1_760_000_000_000 }));
    for (let i = 0; i < 20 && !doc.querySelector('[data-bgs-admin-action="upload-stop"]'); i++) await ui.flush(20);
    assert.match(text('[data-bgs-admin-upload-progress]'), /Загружаю systemsPopulated\.json\.gz: 1 000 Б из 2,9 КБ \(33 %\)/);
    assert.equal(doc.querySelector('[data-bgs-admin-action="start"]').disabled, true, 'пока архив загружается, запуск недоступен');
    await ui.click(doc.querySelector('[data-bgs-admin-action="upload-stop"]'));
    await ui.flush(40);
    assert.match(doc.body.textContent, /Загрузка архива остановлена\. Принятое осталось на сервере/);
    assert.ok(!calls.some((call) => call.post === 'finish'));
    holdPut = null;

    // Незаконченную загрузку можно удалить.
    payload = adminStatus({
      running: false, mode: null, progress: null, log: [],
      archive: { ...adminStatus().archive, exists: false, bytes: 0, downloaded: 0, total: null, partial: false, complete: false },
      shards: { ...adminStatus().shards, exists: false },
      upload: { active: true, name: 'systemsPopulated.json.gz', size: 3000, received: 1000, startedAt: '2026-10-18T11:00:00.000Z', chunkBytes: 1024 },
      config: { ...adminStatus().config, scheduleDecision: { action: 'skip', reason: 'fresh' } },
    });
    await ui.click(doc.querySelector('button.btn'));
    await ui.flush(40);
    await ui.click(doc.querySelector('[data-bgs-admin-action="upload-discard"]'));
    assert.deepEqual(calls.at(-1), { post: 'cancel' });
    assert.match(doc.body.textContent.replace(/[\u00a0\u202f]/g, ' '), /Незаконченная загрузка удалена — освобождено 1 000 Б/);
  } finally {
    delete global.__bgsAdminFetch;
    await ui.cleanup();
  }
});

/* ── Подключение по исходникам ─────────────────────────────────────────── */

test('позиции 3D-слоя «Фракции» — тот же кадр карты, что eliteToThreeCentered', async () => {
  const bundle = await bundleFile({
    entrySource: `
      export { factionPositions } from '@/components/GalaxyMap/FactionPoints';
      export { eliteToThreeCentered } from '@/lib/ed3dCanon';
    `,
    external: ['react', 'react-dom', 'react-dom/client', '@react-three/fiber', 'three'],
  });
  const mod = await import(bundle);
  const points = [{ name: 'Sol', x: 0, y: 0, z: 0 }, { name: 'Colony', x: -24.5, y: -33.8, z: 108.8 }];
  const positions = mod.factionPositions(points);
  assert.equal(positions.length, points.length * 3);
  points.forEach((point, index) => {
    const expected = mod.eliteToThreeCentered(point);
    assert.ok(Math.abs(positions[index * 3] - expected.x) < 1e-3, `x ${point.name}`);
    assert.ok(Math.abs(positions[index * 3 + 1] - expected.y) < 1e-3, `y ${point.name}`);
    assert.ok(Math.abs(positions[index * 3 + 2] - expected.z) < 1e-3, `z ${point.name}`);
  });
});

test('подключение: вкладка Atlas, слой карты, админка, кабинет, Colonial Helper, схема, задача', () => {
  const page = read('src/app/atlas/page.tsx');
  assert.match(page, /\{ id: 'factions', label: 'Фракции'/);
  assert.match(page, /useAtlasFactions\(\{ tabActive: activeTab === 'factions' \}\)/);
  assert.match(page, /<AtlasFactionsPanel factions=\{factions\} \/>/);
  assert.match(page, /factions=\{factionsLayer\}/);

  const map = read('src/components/GalaxyMap/GalaxyMap.tsx');
  assert.match(map, /export interface GalaxyMapFactions/);
  assert.match(map, /<FactionSystemCard/);
  assert.match(map, /className="powerplay-hover-tip bgs-hover-tip"/);
  assert.match(map, /'atlas-focus-faction-system'/);
  assert.match(map, /onPickFaction=\{handleSelectFaction\}/);
  assert.match(map, /clearLayerSelections/);

  const scene = read('src/components/GalaxyMap/GalaxyScene.tsx');
  assert.match(scene, /<FactionPoints points=\{factionPoints\} positions=\{factionPositionsArray\} \/>/);
  assert.match(scene, /extraPoints=\{layerPick\}/, 'PowerPlay и фракции — одно облако выбора');
  assert.match(scene, /<LandmarkMarkers onSelect=\{onSelectRouteSystem\} interactive=\{!layerPointsVisible\} \/>/);

  const nav = read('src/components/Admin/AdminNavigation.tsx');
  assert.match(nav, /'powerplay', 'factions', 'backup'/);
  assert.match(nav, /ADMIN_ONLY_TABS: AdminTab\[\] = \[[^\]]*'factions'/);
  assert.match(nav, /\{ id: 'factions', label: 'Фракции', icon: IconShieldHalf \}/);
  assert.match(read('src/app/admin/page.tsx'), /tab === 'factions' && role === 'admin' && <FactionsAdminTab \/>/);

  const account = read('src/app/account/page.tsx');
  assert.match(account, /new BgsSnapshotCollector\(\)/);
  assert.match(account, /\(line, event\) => factionCollector\.feed\(line, event\)/);
  assert.match(account, /authFetch\('\/api\/factions\/sync'/);

  const helper = read('uploader/colonial_helper.py');
  assert.match(helper, /self\._bgs_sync_collector\(\)\.feed\(ev, live=live\)/);
  assert.match(helper, /self\._flush_bgs_sync\(\)/);
  assert.match(helper, /VERSION = "2\.16\.0"/);
  assert.match(read('uploader/api_client.py'), /\/factions\/sync/);

  const schema = read('supabase/full_schema.sql');
  const migration = read('supabase/migrations/20261019120000_minor_factions.sql');
  assert.ok(schema.includes(migration.trim().slice(0, 2000)), 'миграция в снимке full_schema.sql');

  const compose = read('docker-compose.yml');
  assert.equal((compose.match(/powerplay-sync,factions-sync\}/g) || []).length, 2, 'и в jobs, и в мониторинге');
  assert.match(read('.env.example'), /^JOBS_ENABLED=.*factions-sync/m);
  assert.match(read('deploy/crontab.example'), /--once factions-sync/);

  // Fallback-ссылки и тексты сайта не обещают несуществующего.
  assert.match(read('src/components/Atlas/AtlasFactionsPanel.tsx'), /Админка → Игровые данные → Фракции/);
});
