/**
 * Требования к поисковикам Atlas, которые легко потерять при рефакторинге:
 *
 *   1. каждый поисковик публикует прогресс в общий канал, а 3D-карта его рисует
 *      (раньше визуализация была только у маршрута A→B и только полоской);
 *   2. всё найденное сохраняется в БД проекта, поэтому повторный поиск в том же
 *      районе идёт без внешних API;
 *   3. галактическое кольцо идёт шагами с сохранением сессии — длинный запрос
 *      рвался на 3–4-м сегменте («network error»);
 *   4. сеть — последний источник: сначала каталог Spansh в БД и кэш Atlas.
 *
 * Тест читает исходники: так проверяются связки между файлами, которые иначе
 * ловятся только руками в браузере.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');

test('Atlas: каждый поисковик публикует процесс на 3D-карту', async (t) => {
  const page = read('src/app/atlas/page.tsx');
  const ring = read('src/components/Atlas/AtlasRingRouteFinder.tsx');
  const route = read('src/components/Atlas/AtlasRouteFinder.tsx');
  const market = read('src/components/Atlas/AtlasMarketSearch.tsx');

  await t.test('миры: прогресс, этап и точки из ответа сервера', () => {
    assert.ok(page.includes('startAtlasSearchProgress'), 'поиск миров не объявляет старт');
    assert.ok(page.includes("kind: 'world'"), 'поиск миров публикуется с другим видом');
    assert.ok(page.includes('publishAtlasSearchPoints'), 'найденные миры не попадают на карту');
    assert.ok(page.includes('serverProgress'), 'страница не читает живой прогресс сессии');
    assert.ok(page.includes('finishAtlasSearchProgress'), 'итог поиска миров не публикуется');
  });

  await t.test('кольцо: кольцо, луч и опоры рисуются по ходу сегментов', () => {
    assert.ok(ring.includes("kind: 'ring'"), 'кольцо публикуется с другим видом');
    assert.ok(ring.includes('publishAtlasSearchProgress'), 'кольцо не публикует прогресс');
    assert.ok(ring.includes('ring:'), 'на карту не передаётся окружность кольца');
    assert.ok(ring.includes('beam'), 'на карту не передаётся текущий сегмент');
  });

  await t.test('маршрут A→B: коридор и движущийся луч сканирования', () => {
    assert.ok(route.includes("kind: 'route'"), 'маршрут публикуется с другим видом');
    assert.ok(route.includes('corridor'), 'на карту не передаётся коридор поиска');
    assert.ok(route.includes('sample_systems'), 'найденные системы не показываются на карте');
  });

  await t.test('рынок: очередь систем, курсор сканирования и найденные станции', () => {
    assert.ok(market.includes("kind: 'market'"), 'рынок публикуется с другим видом');
    assert.ok(market.includes('beam'), 'на карту не передаётся сканируемая система');
    assert.ok(market.includes("kind: 'station'"), 'найденные станции не попадают на карту');
    assert.ok(market.includes("kind: 'no-market'") || market.includes("'no-market'"), 'нет отметок «рынка нет»');
  });
});

test('Atlas: карта умеет рисовать прогресс любого поисковика', () => {
  const map = read('src/components/GalaxyMap/GalaxyMap.tsx');
  const scene = read('src/components/GalaxyMap/GalaxyScene.tsx');
  const layer = read('src/components/GalaxyMap/SearchProgressLayer.tsx');

  assert.ok(existsSync(join(ROOT, 'src/hooks/useAtlasSearchProgress.ts')), 'нет хука подписки на прогресс');
  assert.ok(map.includes('useAtlasSearchProgress'), 'карта не подписана на канал прогресса');
  assert.ok(map.includes('map-search-hud'), 'на карте нет оверлея прогресса');
  assert.ok(map.includes('summary'), 'оверлей не показывает итог поиска');
  assert.ok(scene.includes('SearchProgressLayer'), 'слой прогресса не подключён к сцене');
  assert.ok(map.includes('searchProgress={searchProgress}'), 'прогресс не передаётся в сцену');

  for (const marker of ['ring', 'corridor', 'cube', 'path', 'beam']) {
    assert.ok(layer.includes(marker), `слой прогресса не рисует «${marker}»`);
  }
});

test('Atlas: найденное кольцо остаётся на карте после завершения поиска', () => {
  const channel = read('src/lib/atlasSearchProgress.ts');
  const hook = read('src/hooks/useAtlasSearchProgress.ts');
  const map = read('src/components/GalaxyMap/GalaxyMap.tsx');
  const scene = read('src/components/GalaxyMap/GalaxyScene.tsx');
  const layer = read('src/components/GalaxyMap/SearchProgressLayer.tsx');

  // Оверлей прогресса живёт 30 секунд после финиша: без закреплённого итога
  // найденное кольцо исчезало с карты ровно в момент готовности маршрута.
  assert.ok(channel.includes('pinAtlasSearchProgress'), 'итог поиска не закрепляется');
  assert.ok(channel.includes('clearAtlasSearchResult'), 'закреплённый итог нельзя убрать');
  assert.ok(
    channel.indexOf('pinAtlasSearchProgress(state)') > channel.indexOf('export function finishAtlasSearchProgress'),
    'завершение поиска не закрепляет итог автоматически',
  );
  assert.ok(hook.includes('useAtlasSearchResult'), 'нет подписки на закреплённый итог');
  assert.ok(map.includes('useAtlasSearchResult'), 'карта не читает закреплённый итог');
  assert.ok(map.includes('clearAtlasSearchResult'), 'на карте нет кнопки «убрать результат»');
  assert.ok(scene.includes('searchResult'), 'итог не передаётся в сцену');
  assert.ok(layer.includes('ResultGeometry'), 'слой не рисует закреплённый результат');
  assert.ok(
    layer.includes('if (result) return <ResultGeometry result={result} />'),
    'после завершения слой должен показывать итог, а не пустоту',
  );
});

test('Atlas: длинный маршрут кольца не ломает слой маркеров карты', () => {
  const markers = read('src/components/GalaxyMap/RouteMarkers.tsx');

  // Dense-режим удалён: теперь все маркеры рисуются поточечно, что сохраняет
  // кликабельность и единообразие отображения (planned/building/done со
  // статусными цветами). Длинные маршруты не должны вызывать тормозов при
  // взаимодействии с картой, поэтому проверяем, что плотный режим убран.
  assert.ok(!markers.includes('DENSE_ROUTE_LIMIT'), 'должен отсутствовать порог плотности');
  assert.ok(!markers.includes('DenseRoutePoints'), 'должна отсутствовать функция облака точек');
  assert.ok(!markers.includes('THREE.PointsMaterial'), 'облако точек не должно собираться одной геометрией');
  assert.ok(
    markers.includes('points.map((point) =>'),
    'маркеры должны рендериться посредством точечного отображения',
  );
});

test('Atlas: кольцо можно сохранить в проект эскадрильи и выгрузить в CSV', () => {
  const saveRoute = read('src/app/api/atlas/ring-route/save/route.ts');
  const ring = read('src/components/Atlas/AtlasRingRouteFinder.tsx');
  const page = read('src/app/atlas/page.tsx');

  assert.ok(saveRoute.includes("from('project_systems')"), 'сохранение не пишет системы проекта');
  assert.ok(saveRoute.includes('x: Number(point.x)'), 'системы кольца сохраняются без координат');
  assert.ok(saveRoute.includes("['leader', 'officer']"), 'сохранение не проверяет роль в проекте');
  assert.ok(saveRoute.includes('triangulated'), 'расчётные точки не отсеиваются');
  assert.ok(saveRoute.includes('INSERT_BATCH'), 'тысячи строк вставляются одним запросом');
  assert.ok(saveRoute.includes('loadRingRoute'), 'маршрут не читается из сессии');

  assert.ok(ring.includes('/api/atlas/ring-route/save'), 'панель кольца не сохраняет маршрут в проект');
  assert.ok(ring.includes('Скачать CSV'), 'выгрузка CSV спрятана: у кнопки нет подписи');
  assert.ok(ring.includes('Копировать текстом'), 'копирование маршрута не подписано');
  assert.ok(ring.includes('ring-save-project'), 'в панели кольца нет выбора проекта');
  assert.ok(page.includes('projects={projects}'), 'страница не передаёт проекты в поиск кольца');
});

test('Atlas: найденное сохраняется в базе проекта для ускорения повторных поисков', () => {
  const migration = read('supabase/migrations/20261011000000_atlas_search_caches.sql');
  const snapshot = read('supabase/full_schema.sql');
  const cache = read('src/lib/atlasSystemCache.ts');
  const world = read('src/lib/atlasWorldSearch.ts');
  const ring = read('src/lib/atlasRingSearch.ts');
  const routeApi = read('src/app/api/atlas/route-finder/route.ts');
  const marketApi = read('src/app/api/market/find/start/route.ts');

  for (const table of ['atlas_system_cache', 'atlas_body_cache', 'atlas_ring_sessions']) {
    assert.ok(migration.includes(`public.${table}`), `нет таблицы ${table}`);
    assert.ok(snapshot.includes(`MIGRATION: 20261011000000_atlas_search_caches.sql`), 'миграция не попала в снимок схемы');
  }
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS progress'), 'у atlas_searches нет живого прогресса');
  assert.ok(migration.includes('ENABLE ROW LEVEL SECURITY'), 'таблицы без RLS');
  assert.ok(cache.includes('saveCachedSystems') && cache.includes('saveCachedBodies'), 'кэш не сохраняет данные');

  assert.ok(world.includes('saveCachedBodies'), 'поиск миров не сохраняет тела');
  assert.ok(world.includes('saveCachedSystems'), 'поиск миров не сохраняет координаты систем');
  assert.ok(world.includes('listCachedBodiesInBox'), 'поиск миров не читает кэш тел');
  assert.ok(ring.includes('saveCachedSystems'), 'кольцо не сохраняет найденные системы');
  assert.ok(routeApi.includes('saveCachedSystems'), 'маршрут не сохраняет найденные системы');
  assert.ok(routeApi.includes('listCachedSystemsInBox'), 'маршрут не смотрит в кэш перед EDSM');
  assert.ok(marketApi.includes('saveCachedSystems'), 'рынок не сохраняет список систем');
  assert.ok(marketApi.includes('findSystemsInCube'), 'рынок не использует каталог проекта');
});

test('Atlas: кольцо строится шагами и продолжается после обрыва связи', () => {
  const route = read('src/app/api/atlas/ring-route/route.ts');
  const finalize = read('src/app/api/atlas/ring-route/finalize/route.ts');
  const client = read('src/components/Atlas/AtlasRingRouteFinder.tsx');
  const search = read('src/lib/atlasRingSearch.ts');

  assert.ok(existsSync(join(ROOT, 'src/app/api/atlas/ring-route/route.ts')), 'нет шагового маршрута кольца');
  assert.ok(existsSync(join(ROOT, 'src/app/api/atlas/ring-route/finalize/route.ts')), 'нет сборки кольца');
  assert.ok(route.includes('step_sectors') || route.includes('stepRingSession'), 'шаг не обрабатывает пачку сегментов');
  assert.ok(route.includes('session_id'), 'нет продолжения сессии');
  assert.ok(route.includes("status: 404"), 'неизвестная сессия должна возвращать 404, а не падать');
  assert.ok(finalize.includes('finalizeRingSession'), 'нет финализации маршрута');
  assert.ok(client.includes('MAX_STEP_RETRIES'), 'клиент не повторяет упавший шаг');
  assert.ok(client.includes('resume'), 'нет продолжения прерванного поиска');
  assert.ok(search.includes('atlas_ring_sessions'), 'сессии не сохраняются в БД');
  assert.ok(search.includes('STEP_TIME_BUDGET_MS'), 'шаг не ограничен по времени');
});

test('Atlas: сеть — последний источник, сначала каталог Spansh и кэш', () => {
  const ring = read('src/lib/atlasRingSearch.ts');
  const world = read('src/lib/atlasWorldSearch.ts');
  const spansh = read('src/lib/spanshClient.ts');

  const cachedAt = ring.indexOf('listCachedSystemsNear');
  const edsmAt = ring.indexOf('async function edsmSystemsNear');
  assert.ok(cachedAt > 0 && edsmAt > 0, 'в кольце должны быть и кэш, и EDSM');
  const catalogUsage = ring.indexOf('findSystemsInCube');
  assert.ok(catalogUsage > 0 && catalogUsage < edsmAt, 'каталог проекта должен использоваться раньше EDSM');

  assert.ok(world.includes('listCachedBodiesInBox'), 'поиск миров не начинается с кэша тел');
  assert.ok(world.includes('findStarCandidates'), 'поиск звёзд не использует каталог');
  assert.ok(spansh.includes('/systems/search'), 'нет поиска систем Spansh по расстоянию');
  assert.ok(spansh.includes('spanshSystemsNear'), 'Spansh-поиск систем не экспортируется');
});

test('Atlas: прогресс поиска миров доходит до клиента вместе с точками', () => {
  const api = read('src/app/api/atlas/search/route.ts');
  const world = read('src/lib/atlasWorldSearch.ts');
  const panel = read('src/components/Atlas/AtlasSearchPanel.tsx');

  assert.ok(api.includes('progress'), 'ответ поиска миров не содержит прогресса');
  assert.ok(api.includes('processSearchAsync'), 'поиск миров не выполняется в фоне');
  assert.ok(world.includes('writeSearchProgress'), 'прогресс не пишется в БД');
  assert.ok(world.includes('batch'), 'прогресс не отдаёт найденные точки');
  assert.ok(panel.includes('serverPercent') && panel.includes('serverMessage'), 'панель игнорирует серверный прогресс');
});
