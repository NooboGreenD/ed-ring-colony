/**
 * Правила карты, у которых нет визуальной проверки:
 *
 *   1. какие слои включены при открытии (Atlas открывается почти пустым —
 *      10.11.2026; «Карта кольца» показывает маршрут сразу);
 *   2. куда ведёт кнопка «Последняя стройка» — к последней **завершённой**
 *      системе маршрута, а не к последней в списке;
 *   3. где живёт фильтр авианосцев (вкладка «Авианосцы», а не панель слоёв).
 *
 * Последний пункт проверяется по исходникам: компонент карты в jsdom не
 * поднимается (three.js → «Dynamic require of react»), поэтому правило
 * закреплено явным контрактом файлов.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATLAS_LAYER_DEFAULTS,
  RING_MAP_LAYER_DEFAULTS,
  lastBuildTarget,
  mapLayerDefaults,
  mapSystemStatus,
} from '../../src/lib/mapLayerDefaults.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('Atlas открывается почти пустым: имена и границы секторов, оранжевый пояс, туманности', () => {
  assert.deepEqual(mapLayerDefaults(false), ATLAS_LAYER_DEFAULTS);

  const on = Object.entries(ATLAS_LAYER_DEFAULTS).filter(([, value]) => value).map(([key]) => key);
  assert.deepEqual(on.sort(), ['nebulae', 'regionBoundaries', 'regionLabels', 'ringZone'],
    'включены ровно имена секторов, границы секторов, оранжевый пояс и туманности');

  for (const off of ['knownSystems', 'projectRoute', 'atlasCandidates', 'pilots', 'marketResults', 'noMarketSystems']) {
    assert.equal(ATLAS_LAYER_DEFAULTS[off], false, `${off}: слой выключен по умолчанию`);
  }
});

test('«Карта кольца» показывает маршрут сразу — иначе страница открывалась бы пустой', () => {
  assert.deepEqual(mapLayerDefaults(true), RING_MAP_LAYER_DEFAULTS);
  assert.equal(RING_MAP_LAYER_DEFAULTS.knownSystems, true);
  assert.equal(RING_MAP_LAYER_DEFAULTS.projectRoute, true);
  assert.equal(RING_MAP_LAYER_DEFAULTS.regionLabels, true, 'оранжевый пояс и сектора остаются');
  assert.equal(RING_MAP_LAYER_DEFAULTS.ringZone, true);
});

test('карта берёт начальные значения слоёв из общих правил', () => {
  const map = read('src/components/GalaxyMap/GalaxyMap.tsx');
  assert.ok(map.includes("from '@/lib/mapLayerDefaults'"), 'карта не использует общие правила слоёв');
  assert.ok(map.includes('mapLayerDefaults(showOnlyMainRoute)'), 'компактная карта должна иметь свои значения');
  for (const field of ['knownSystems', 'projectRoute', 'atlasCandidates', 'pilots', 'marketResults', 'noMarketSystems', 'regionLabels', 'regionBoundaries', 'ringZone', 'nebulae']) {
    assert.ok(map.includes(`layerDefaults.${field}`), `поле ${field} не берётся из правил`);
  }
});

test('статус системы: процент Raven главнее записанного статуса, мусор — «planned»', () => {
  assert.equal(mapSystemStatus({ status: 'done', progress: 42 }), 'building', 'процент важнее устаревшего статуса');
  assert.equal(mapSystemStatus({ status: 'planned', progress: 100 }), 'done');
  assert.equal(mapSystemStatus({ status: 'done', progress: null }), 'done');
  assert.equal(mapSystemStatus({ status: 'что-то', progress: null }), 'planned');
  assert.equal(mapSystemStatus({}), 'planned');
});

test('«Последняя стройка» ведёт к последней завершённой, а не к концу маршрута', () => {
  const route = [
    { id: 1, sort_order: 1, system_name: 'Alpha', status: 'done', progress: 100 },
    { id: 2, sort_order: 2, system_name: 'Beta', status: 'done', progress: 100 },
    { id: 3, sort_order: 3, system_name: 'Gamma', status: 'building', progress: 40 },
    { id: 4, sort_order: 4, system_name: 'Delta', status: 'planned', progress: 0 },
  ];
  assert.equal(lastBuildTarget(route).system_name, 'Beta', 'последняя сданная, а не последняя в маршруте');

  // Идущая стройка не считается завершённой, даже если она дальше по маршруту.
  assert.equal(lastBuildTarget(route.slice(0, 3)).system_name, 'Beta');

  // Хабы/дубли с тем же именем не важны: порядок задаёт sort_order, при равенстве — id.
  const ties = [
    { id: 10, sort_order: 7, system_name: 'Ring A', status: 'done', progress: 100 },
    { id: 11, sort_order: 7, system_name: 'Ring B', status: 'done', progress: 100 },
  ];
  assert.equal(lastBuildTarget(ties).system_name, 'Ring B');
});

test('без завершённых кнопка не молчит: строящаяся, затем конец маршрута', () => {
  const building = [
    { id: 1, sort_order: 1, system_name: 'Alpha', status: 'planned' },
    { id: 2, sort_order: 2, system_name: 'Beta', status: 'building', progress: 10 },
    { id: 3, sort_order: 3, system_name: 'Gamma', status: 'planned' },
  ];
  assert.equal(lastBuildTarget(building).system_name, 'Beta');

  const planned = [
    { id: 1, sort_order: 1, system_name: 'Alpha', status: 'planned' },
    { id: 2, sort_order: 2, system_name: 'Beta', status: 'planned' },
  ];
  assert.equal(lastBuildTarget(planned).system_name, 'Beta');

  assert.equal(lastBuildTarget([]), null);
});

test('карта использует общий выбор кнопки «Последняя стройка»', () => {
  const map = read('src/components/GalaxyMap/GalaxyMap.tsx');
  assert.ok(map.includes('lastBuildTarget(uniqueRouteSystems)'), 'кнопка не использует общее правило');
  assert.ok(!/uniqueRouteSystems\[uniqueRouteSystems\.length - 1\]/.test(map),
    'кнопка всё ещё ведёт к последней системе маршрута');
  assert.ok(map.includes("t('gmap.lastBuildTitle')"), 'у кнопки нет подсказки, куда она ведёт');
  // В Atlas маршрут по умолчанию скрыт — кнопка обязана показать слой,
  // иначе камера летит к невидимой системе.
  assert.ok(map.includes('setShowKnownSystems(true)'), 'кнопка не включает слой маршрута');
});

test('фильтр авианосцев живёт во вкладке «Авианосцы», а не в панели слоёв карты', () => {
  const map = read('src/components/GalaxyMap/GalaxyMap.tsx');
  const atlas = read('src/app/atlas/page.tsx');
  const panel = read('src/components/Atlas/AtlasCarriersPanel.tsx');

  // В Atlas фильтр рендерит вкладка; карта — только когда ведёт слой сама.
  assert.ok(map.includes('{!carrierLayerProp && ('), 'панель карты не прячет фильтр в Atlas');
  assert.ok(atlas.includes('useCarrierLayer({ defaultVisible: false })'),
    'в Atlas слой авианосцев по умолчанию выключен, как и остальные слои');
  assert.ok(atlas.includes('carriers={carrierLayer}'), 'карта не получает общий слой');
  assert.ok(atlas.includes('<AtlasCarriersPanel carrierLayer={carrierLayer}'), 'вкладка не получает слой');
  assert.ok(panel.includes("t('acw.layerTitle')"), 'у блока слоя нет заголовка');
  assert.ok(panel.includes('<CarrierLayerControls'), 'во вкладке нет управления фильтром');
  assert.ok(panel.includes("'atlas-select-carrier-group'"), 'строка списка не ведёт камеру карты');
  assert.ok(map.includes("'atlas-select-carrier-group'"), 'карта не слушает выбор из вкладки');
});
