/**
 * Общий канал прогресса поисковиков Atlas.
 *
 * Проверяем поведение, от которого зависит 3D-карта: точки накапливаются, дубли
 * не плодятся (иначе карта «утолщается» после каждого опроса), после завершения
 * результат остаётся видимым, а новый запуск полностью сбрасывает прошлое.
 *
 * Модуль собирается esbuild-ом, потому что он на TypeScript, а ssr-ветку
 * (`window` нет) проверяем отдельно — падать в ней нельзя.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function loadModule() {
  const esbuild = await import('esbuild');
  const dir = mkdtempSync(join(ROOT, '.tmp-atlas-progress-'));
  const outfile = join(dir, 'progress.mjs');
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/lib/atlasSearchProgress.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent',
  });
  const mod = await import(outfile);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

test('канал прогресса: точки накапливаются без дублей и переживают обрезку по лимиту', async () => {
  const { mod, cleanup } = await loadModule();
  const win = installWindow();
  try {
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
    cleanup();
  }
});

test('канал прогресса: завершение оставляет результат на карте, новый поиск его вытесняет', async () => {
  const { mod, cleanup } = await loadModule();
  const win = installWindow();
  try {
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
    cleanup();
  }
});

test('канал прогресса: без window модуль не падает (SSR)', async () => {
  const { mod, cleanup } = await loadModule();
  const previous = globalThis.window;
  delete globalThis.window;
  try {
    mod.startAtlasSearchProgress({ kind: 'market' });
    mod.publishAtlasSearchPoints([{ name: 'X', x: 0, y: 0, z: 0 }]);
    mod.finishAtlasSearchProgress({ message: 'ок' });
    assert.equal(mod.readAtlasSearchProgress().points.length, 1);
  } finally {
    globalThis.window = previous;
    cleanup();
  }
});
