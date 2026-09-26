/**
 * Тесты панели управления 3D-картой системы.
 *
 * Раньше эти проверки дёргали Plotly-сцену; теперь карта рисуется движком
 * three.js (`@/lib/orrery3d`), и панель обязана звать именно его методы:
 * уровни приближения, вид камеры, слои, фильтры, подписи, масштаб, движение
 * по орбитам и возврат к дате сканов. Подставной вьюер (см.
 * `orrery-harness.mjs`) записывает вызовы — по ним и проверяем.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderOrreryMap, solBodies, solStructures } from './orrery-harness.mjs';

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем, но говорим об этом.
}

const maybe = esbuild ? test : test.skip;

async function boot(extra = {}) {
  return renderOrreryMap({ bodies: solBodies(), projects: solStructures(), ...extra });
}

maybe('уровни приближения: без выбранного тела доступен только обзор системы', async () => {
  const view = await boot();
  try {
    const level0 = view.buttonByTitle(/Вся система целиком/);
    const level1 = view.buttonByTitle(/Тела выбранной звезды/);
    const level2 = view.buttonByTitle(/Тело и его соседи/);
    const level3 = view.buttonByTitle(/Постройки на поверхности тела/);
    for (const [name, level] of [['кластер', level1], ['окрестность', level2], ['поверхность', level3]]) {
      assert.ok(level, `нет кнопки уровня «${name}»`);
      assert.equal(level.disabled, true, `уровень «${name}» доступен без выбранного тела`);
      assert.equal(level.getAttribute('aria-disabled'), null);
    }
    assert.equal(level0.disabled, false, 'обзор системы должен работать всегда');
  } finally {
    await view.cleanup();
  }
});

maybe('уровни приближения: с выбранным телом кнопки зовут setZoom', async () => {
  const view = await boot({ focusTarget: 'Sol 3' });
  try {
    const level2 = view.buttonByTitle(/Тело и его соседи/);
    assert.equal(level2.disabled, false, 'уровень не разблокировался при выбранном теле');
    await view.click(level2);
    assert.deepEqual(view.viewerCall('setZoom').slice(-1), [['setZoom', 2]]);
  } finally {
    await view.cleanup();
  }
});

maybe('вид камеры: кнопки «сверху» и «сбоку» переключают проекцию', async () => {
  const view = await boot();
  try {
    await view.click(view.buttonByTitle(/Вид на плоскость системы/));
    await view.click(view.buttonByTitle(/Вид вдоль плоскости системы/));
    await view.click(view.buttonByTitle(/Изометрия/));
    const views = view.viewerCall('setView').map(([, preset]) => preset);
    assert.deepEqual(views, ['top', 'side', 'iso'], `переключения вида: ${JSON.stringify(views)}`);
  } finally {
    await view.cleanup();
  }
});

maybe('«вся система» возвращает камеру и снимает фокус', async () => {
  const changes = [];
  const view = await boot({ focusTarget: 'Sol 3', onFocusChange: (name) => changes.push(name) });
  try {
    await view.click(view.buttonByTitle(/Показать всю систему/));
    assert.ok(view.viewerCall('fit').length >= 1, 'fit() не вызван');
    assert.deepEqual(changes.slice(-1), [''], 'фокус не снят в адресе страницы');
  } finally {
    await view.cleanup();
  }
});

maybe('слои сцены: панель открывается и гасит слой', async () => {
  const view = await boot();
  try {
    const layersButton = view.buttonByTitle('Слои сцены');
    assert.ok(layersButton, 'нет кнопки слоёв');
    await view.click(layersButton);
    const orbits = view.buttonByTitle(/Орбиты планет и звёзд/);
    assert.ok(orbits, 'в панели слоёв нет переключателя орбит');
    await view.click(orbits);
    assert.deepEqual(view.viewerCall('setLayer').slice(-1), [['setLayer', 'orbits', false]],
      `слой не переключился: ${JSON.stringify(view.viewerCall('setLayer'))}`);

    const moons = view.buttonByTitle(/Сами луны/);
    await view.click(moons);
    assert.deepEqual(view.viewerCall('setLayer').slice(-1), [['setLayer', 'moons', false]]);
  } finally {
    await view.cleanup();
  }
});

maybe('фильтры, подписи и масштаб уезжают во вьюер', async () => {
  const view = await boot();
  try {
    const filterSelect = view.select('Показать только нужные тела — остальные притухают');
    assert.ok(filterSelect, 'нет выбора фильтра');
    await view.setSelect(filterSelect, 'landable');
    assert.deepEqual(view.viewerCall('setFilter').slice(-1), [['setFilter', 'landable']]);

    const labelsSelect = view.select('Подписи тел на карте');
    assert.ok(labelsSelect, 'нет выбора подписей');
    await view.setSelect(labelsSelect, 'none');
    assert.deepEqual(view.viewerCall('setLabels').slice(-1), [['setLabels', 'none']]);

    const scaleSelect = view.select('Сжатый масштаб делает систему обозримой, линейный сохраняет пропорции');
    assert.ok(scaleSelect, 'нет выбора масштаба');
    const before = view.viewerCall('setPayload').length;
    await view.setSelect(scaleSelect, 'linear');
    const payloads = view.viewerCall('setPayload');
    assert.ok(payloads.length > before, 'смена масштаба не пересобрала пакет данных');
    assert.equal(payloads[payloads.length - 1][1].scaleMode, 'linear');
    assert.ok(payloads[payloads.length - 1][1].bodies.length >= 4, 'пакет потерял тела при смене масштаба');
  } finally {
    await view.cleanup();
  }
});

maybe('камера: наведение и тиканье времени не пересобирают сцену', async () => {
  // Регрессия на «камера постоянно возвращается в исходное состояние».
  // Компонент отдавал вьюеру НОВЫЙ пакет данных на каждый свой рендер
  // (пустые постройки создавались заново), вьюер пересобирал сцену и
  // кадрировал её заново, а его же событие состояния вызывало следующий
  // рендер — петля, из которой камеру было не вывести.
  const view = await renderOrreryMap({ bodies: solBodies() });
  try {
    const before = view.viewerCall('setPayload').length;

    // Наведение курсора на тело: компонент показывает подсказку и
    // перерисовывается — но данные сцены не менялись.
    view.emitHover({ kind: 'body', name: 'Sol 3' });
    await view.flush(20);
    view.emitHover(null);
    await view.flush(20);

    // Проигрывание орбит: вьюер шлёт состояние каждым кадром.
    for (let step = 1; step <= 5; step += 1) {
      view.emitState({ playing: true, timeDays: step * 0.5 });
      await view.flush(10);
    }

    assert.equal(view.viewerCall('setPayload').length, before,
      'пакет данных пересобрался без причины — сцена и камера сбросятся');

    // Смена масштаба по-прежнему обязана доехать до вьюера.
    const scaleSelect = view.select('Сжатый масштаб делает систему обозримой, линейный сохраняет пропорции');
    await view.setSelect(scaleSelect, 'linear');
    assert.ok(view.viewerCall('setPayload').length > before, 'смена масштаба должна обновлять пакет');
    // Фокус при обновлении данных сохраняется — камера остаётся на месте.
    assert.deepEqual(view.viewerCall('setPayload').slice(-1)[0][2], { keepFocus: true });
  } finally {
    await view.cleanup();
  }
});

maybe('движение по орбитам: старт, скорость и возврат к дате сканов', async () => {
  const view = await boot();
  try {
    await view.click(view.buttonByTitle(/Движение тел по орбитам/));
    assert.deepEqual(view.viewerCall('setMotion').slice(-1), [['setMotion', true, undefined]]);

    const speed = view.select('Сколько суток проходит за секунду');
    assert.ok(speed, 'нет выбора скорости движения');
    await view.setSelect(speed, '16');
    assert.deepEqual(view.viewerCall('setMotion').slice(-1), [['setMotion', true, 16]]);

    await view.click(view.buttonByTitle('Вернуться к дате сканов'));
    assert.ok(view.viewerCall('resetTime').length >= 1, 'resetTime() не вызван');
  } finally {
    await view.cleanup();
  }
});

maybe('список тел сворачивается и разворачивается кнопкой «список»', async () => {
  const view = await boot();
  try {
    const search = () => view.document.querySelector('input[aria-label="Поиск тела"]');
    assert.ok(search(), 'список не показан сразу');
    await view.click(view.buttonByTitle('Список тел и построек'));
    assert.equal(search(), null, 'список не свернулся');
    await view.click(view.buttonByTitle('Список тел и построек'));
    assert.ok(search(), 'список не вернулся');
  } finally {
    await view.cleanup();
  }
});

maybe('без WebGL панель остаётся рабочей и предупреждает пользователя', async () => {
  const view = await boot({ sceneAvailable: false });
  try {
    assert.ok(/не дал доступ к WebGL/i.test(view.text()),
      'нет предупреждения о недоступном WebGL');
    assert.ok(view.buttonByTitle('Слои сцены'), 'панель пропала без WebGL');
    assert.ok(view.document.querySelector('input[aria-label="Поиск тела"]'),
      'список тел исчез без WebGL');
    const filterSelect = view.select('Показать только нужные тела — остальные притухают');
    await view.setSelect(filterSelect, 'sites');
    assert.deepEqual(view.viewerCall('setFilter').slice(-1), [['setFilter', 'sites']],
      'без WebGL фильтры перестали работать');
  } finally {
    await view.cleanup();
  }
});
