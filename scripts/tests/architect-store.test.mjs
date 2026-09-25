import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE_VERSION } from '../../src/lib/architect/catalogue.ts';
import { PLAN_FORMAT_VERSION, addSite, createPlan } from '../../src/lib/architect/planner.ts';
import {
  PLAN_TABLE,
  PLAN_VISIBILITIES,
  VISIBILITY_HINTS_RU,
  VISIBILITY_LABELS_RU,
  buildPlanInsert,
  buildPlanUpdate,
  isPlanVisibility,
  planMetrics,
  rowToStoredPlan,
  rowToView,
  sharePath,
} from '../../src/lib/architect/store.ts';

const AUTHOR = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';

function samplePlan() {
  let plan = createPlan('HIP 90297', 'CMDR Tester');
  plan = addSite(plan, 'HIP 90297 A', 'no_truss');
  plan = addSite(plan, 'HIP 90297 A 1', 'consus');
  return plan;
}

function storedRow(overrides = {}) {
  return {
    id: 'plan-1',
    system_name: 'HIP 90297',
    title: 'Первая очередь',
    author_id: AUTHOR,
    author_name: 'CMDR Tester',
    visibility: 'public',
    plan: samplePlan(),
    format_version: PLAN_FORMAT_VERSION,
    catalogue_version: CATALOGUE_VERSION,
    site_count: 2,
    haul_tons: 56_562,
    score: 9,
    tier2_points: 1,
    tier3_points: 1,
    cargo_items: 25,
    notes: '',
    published_at: '2026-09-25T10:00:00.000Z',
    created_at: '2026-09-25T09:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

test('сводные числа считает движок, а не доверие клиенту', () => {
  const metrics = planMetrics(samplePlan());
  assert.equal(metrics.siteCount, 2);
  assert.equal(metrics.haulTons, 53_723 + 2_839);
  assert.equal(metrics.score, 8 + 1);
  assert.equal(metrics.tier2Points, 1, 'аванпост T1 дал очко T2, порт T2 его потратил');
  assert.equal(metrics.tier3Points, 1, 'порт T2 дал очко T3');
  assert.ok(metrics.cargoItems > 10);
});

test('вставка на сервер: приватный план без даты публикации, публичный — с датой', () => {
  const plan = samplePlan();
  const privateInsert = buildPlanInsert(plan, { authorId: AUTHOR, authorName: 'CMDR Tester' });
  assert.equal(privateInsert.system_name, 'HIP 90297');
  assert.equal(privateInsert.author_id, AUTHOR);
  assert.equal(privateInsert.visibility, 'private');
  assert.equal(privateInsert.published_at, null);
  assert.equal(privateInsert.catalogue_version, CATALOGUE_VERSION);
  assert.equal(privateInsert.format_version, PLAN_FORMAT_VERSION);
  assert.equal(privateInsert.haul_tons, 56_562);
  assert.deepEqual(Object.keys(privateInsert.plan).sort(), Object.keys(plan).sort());

  const publicInsert = buildPlanInsert(plan, { authorId: AUTHOR, visibility: 'public', title: 'Кольцо' });
  assert.equal(publicInsert.visibility, 'public');
  assert.equal(typeof publicInsert.published_at, 'string');
  assert.equal(publicInsert.title, 'Кольцо');

  assert.equal(isPlanVisibility('public'), true);
  assert.equal(isPlanVisibility('secret'), false);
  assert.equal(isPlanVisibility(null), false);
  assert.deepEqual(PLAN_VISIBILITIES, ['private', 'unlisted', 'public']);
  assert.equal(VISIBILITY_LABELS_RU.unlisted, 'по ссылке');
  assert.ok(VISIBILITY_HINTS_RU.public.length > 10);
});

test('обновление сохраняет прежнюю дату публикации и снимает её у приватного', () => {
  const previous = storedRow();
  const toUnlisted = buildPlanUpdate(samplePlan(), { visibility: 'unlisted', previous });
  assert.equal(toUnlisted.published_at, previous.published_at, 'дата первой публикации не перезаписывается');

  const toPrivate = buildPlanUpdate(samplePlan(), { visibility: 'private', previous });
  assert.equal(toPrivate.published_at, null);

  const backToPublic = buildPlanUpdate(samplePlan(), { visibility: 'public', previous: { ...previous, published_at: null } });
  assert.equal(typeof backToPublic.published_at, 'string');

  const withoutVisibility = buildPlanUpdate(samplePlan(), { previous });
  assert.equal(withoutVisibility.visibility, 'public', 'видимость не сбрасывается, если её не меняли');
});

test('строка таблицы превращается в представление плана', () => {
  const view = rowToView(storedRow(), AUTHOR);
  assert.equal(view.id, 'plan-1');
  assert.equal(view.system, 'HIP 90297');
  assert.equal(view.title, 'Первая очередь');
  assert.equal(view.authorName, 'CMDR Tester');
  assert.equal(view.visibility, 'public');
  assert.equal(view.haulTons, 56_562);
  assert.deepEqual(view.tierPoints, { tier2: 1, tier3: 1 });
  assert.equal(view.stale, false);
  assert.equal(view.own, true, 'автор видит свой план как собственный');
  assert.equal(rowToView(storedRow(), OTHER).own, false);
  assert.equal(rowToView(storedRow(), null).own, false);
});

test('план по другому каталогу помечается как устаревший', () => {
  const view = rowToView(storedRow({ catalogue_version: CATALOGUE_VERSION - 1 }));
  assert.equal(view.stale, true);
  assert.equal(view.catalogueVersion, CATALOGUE_VERSION - 1);
});

test('строка без JSON плана (список) и битый JSON разбираются по-разному', () => {
  const summaryOnly = rowToView(storedRow({ plan: undefined }));
  assert.equal(summaryOnly.id, 'plan-1');
  assert.equal(summaryOnly.siteCount, 2, 'число построек берётся из колонки');
  assert.equal(summaryOnly.system, 'HIP 90297');

  assert.equal(rowToView(storedRow({ plan: 'не план' })), null);
  assert.equal(rowToView(storedRow({ plan: { sites: 'мусор' } })), null);
  assert.equal(rowToView(null), null);
  assert.equal(rowToView(undefined), null);
});

test('открытие по ссылке отдаёт и представление, и сам план', () => {
  const stored = rowToStoredPlan(storedRow(), OTHER);
  assert.equal(stored.view.id, 'plan-1');
  assert.equal(stored.plan.sites.length, 2);
  assert.equal(stored.view.own, false);

  assert.equal(rowToStoredPlan(storedRow({ plan: undefined })), null, 'без JSON плана открывать нечего');
  assert.equal(rowToStoredPlan(storedRow({ plan: 42 })), null);
  assert.equal(rowToStoredPlan(null), null);
});

test('ссылка, которой делятся планом', () => {
  assert.equal(sharePath('plan-1'), '/architect?plan=plan-1');
  assert.equal(sharePath('id с пробелом'), '/architect?plan=id%20%D1%81%20%D0%BF%D1%80%D0%BE%D0%B1%D0%B5%D0%BB%D0%BE%D0%BC');
  assert.equal(PLAN_TABLE, 'system_plans');
});
