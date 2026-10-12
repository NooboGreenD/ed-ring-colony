/**
 * Общий канал прогресса поисковиков Atlas.
 *
 * Проверяем поведение, от которого зависит 3D-карта: точки накапливаются, дубли
 * не плодятся (иначе карта «утолщается» после каждого опроса), после завершения
 * результат остаётся видимым, закреплённый итог переживает оверлей прогресса
 * (иначе найденное кольцо пропадало с карты через 30 секунд), а новый запуск
 * полностью сбрасывает прошлое.
 *
 * Модуль собирается esbuild-ом (он на TypeScript) через общий кэш сборок, а
 * ssr-ветку (`window` нет) проверяем отдельно — падать в ней нельзя.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

/** Одна сборка на файл: состояние канала каждый тест сбрасывает сам. */
const mod = await import(await bundleFile({ entry: 'src/lib/atlasSearchProgress.ts' }));

function installWindow() {
  const events = new EventTarget();
  const previous = globalThis.window;
  globalThis.window = events;
  return {
    events,
    restore: () => {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    },
  };
}

test('канал прогресса: точки накапливаются без дублей и переживают обрезку по лимиту', () => {
  const win = installWindow();
  try {
    mod.resetAtlasSearchProgress();
    mod.startAtlasSearchProgress({ kind: 'ring', title: 'ТЕСТ', percent: 0 });
    mod.publishAtlasSearchPoints([
      { name: 'Alpha', x: 1, y: 2, z: 3, kind: 'system' },
      { name: 'Beta', x: 4, y: 5, z: 6, kind: 'anchor' },
    ]);
    mod.publishAtlasSearchPoints([
      { name: 'Alpha', x: 1, y: 2, z: 3, kind: 'system' },
      { name: 'Gamma', x: 7, y: 8, z: 9, kind: 'found' },
    ]);

    const state = mod.readAtlasSearchProgress();
    assert.deepEqual(state.points.map((point) => point.name), ['Alpha', 'Beta', 'Gamma']);
    assert.equal(state.active, true, 'поиск считается активным, пока его не завершили');

    // Подписка: карта узнаёт об изменениях событием, а не опросом.
    let received = 0;
    const unsubscribe = mod.subscribeAtlasSearchProgress(() => { received += 1; });
    mod.publishAtlasSearchProgress({ percent: 42 });
    assert.equal(received, 1);
    unsubscribe();
    mod.publishAtlasSearchProgress({ percent: 43 });
    assert.equal(received, 1, 'после отписки слушатель не должен вызываться');
  } finally {
    win.restore();
  }
});

test('канал прогресса: завершение оставляет результат на карте, новый поиск его вытесняет', () => {
  const win = installWindow();
  try {
    mod.resetAtlasSearchProgress();
    mod.startAtlasSearchProgress({ kind: 'world' });
    mod.publishAtlasSearchPoints([{ name: 'Sol', x: 0, y: 0, z: 0, kind: 'found' }]);
    mod.finishAtlasSearchProgress({ message: 'Готово', summary: 'Найдено 1' });

    const finished = mod.readAtlasSearchProgress();
    assert.equal(finished.finished, true);
    assert.equal(finished.percent, 100);
    assert.equal(finished.active, true, 'итог должен оставаться видимым, а не гаснуть мгновенно');
    assert.equal(finished.summary, 'Найдено 1');
    assert.equal(finished.points.length, 1, 'точки после завершения остаются на карте');

    mod.startAtlasSearchProgress({ kind: 'route', title: 'НОВЫЙ' });
    const restarted = mod.readAtlasSearchProgress();
    assert.equal(restarted.points.length, 0, 'новый поиск начинается с чистого листа');
    assert.equal(restarted.finished, false);
    assert.equal(restarted.summary, '');
  } finally {
    win.restore();
  }
});

test('канал прогресса: итог закреплён и остаётся на карте, когда оверлей погас', () => {
  const win = installWindow();
  try {
    mod.resetAtlasSearchProgress();
    assert.equal(mod.readAtlasSearchResult(), null, 'до поиска закреплённого итога нет');

    mod.startAtlasSearchProgress({ kind: 'ring', title: 'КОЛЬЦО' });
    mod.publishAtlasSearchProgress({
      ring: { cx: 25, cy: -21, cz: 25900, radius: 23000 },
      path: [{ name: 'A', x: 1, y: 0, z: 0 }, { name: 'B', x: 2, y: 0, z: 0 }],
    });
    mod.publishAtlasSearchPoints([{ name: 'Anchor', x: 3, y: 0, z: 0, kind: 'anchor' }]);
    assert.equal(mod.readAtlasSearchResult(), null, 'пока поиск идёт, итога ещё нет');

    // Карта получает уведомления отдельным событием: слой результата перерисуется.
    let resultEvents = 0;
    const unsubscribe = mod.subscribeAtlasSearchResult(() => { resultEvents += 1; });

    mod.finishAtlasSearchProgress({ message: 'Кольцо собрано', percent: 100 });
    const pinned = mod.readAtlasSearchResult();
    assert.ok(pinned, 'после завершения итог закреплён');
    assert.equal(pinned.ring.radius, 23000, 'контур кольца остаётся на карте');
    assert.equal(pinned.path.length, 2, 'линия маршрута остаётся на карте');
    assert.deepEqual(pinned.points.map((point) => point.name), ['Anchor'], 'опоры остаются на карте');
    assert.equal(resultEvents, 1, 'карта узнала о закреплении итога');

    // Оверлей прогресса гаснет (active: false), а результат должен остаться.
    mod.publishAtlasSearchProgress({ active: false });
    assert.equal(mod.readAtlasSearchProgress().active, false);
    assert.ok(mod.readAtlasSearchResult(), 'закреплённый итог не зависит от оверлея');

    mod.clearAtlasSearchResult();
    assert.equal(mod.readAtlasSearchResult(), null, 'пользователь убрал результат с карты');
    assert.equal(resultEvents, 2, 'карта узнала и об уборке');
    unsubscribe();

    // Новый поиск убирает прошлый итог: два результата не смешиваются.
    mod.startAtlasSearchProgress({ kind: 'ring' });
    mod.finishAtlasSearchProgress({});
    assert.ok(mod.readAtlasSearchResult(), 'итог нового поиска закрепляется заново');
    mod.startAtlasSearchProgress({ kind: 'world' });
    assert.equal(mod.readAtlasSearchResult(), null, 'новый поиск вытесняет прошлый итог');
  } finally {
    win.restore();
  }
});

test('канал прогресса: без window модуль не падает (SSR)', () => {
  const previous = globalThis.window;
  delete globalThis.window;
  try {
    mod.resetAtlasSearchProgress();
    mod.startAtlasSearchProgress({ kind: 'market' });
    mod.publishAtlasSearchPoints([{ name: 'X', x: 0, y: 0, z: 0 }]);
    mod.finishAtlasSearchProgress({ message: 'ок' });
    assert.equal(mod.readAtlasSearchProgress().points.length, 1);
    assert.ok(mod.readAtlasSearchResult(), 'закрепление итога работает и без window');
    mod.clearAtlasSearchResult();
  } finally {
    globalThis.window = previous;
  }
});
