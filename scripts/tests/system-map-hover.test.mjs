/**
 * Тесты подсказок, карточки фокуса и списка построек 3D-карты системы.
 *
 * Проверяем три слоя:
 *
 * 1. Подсказка при наведении (`bodyTooltipHtml`) — факты тела, метки посадки,
 *    био, колец и первооткрывателей, прогресс построек на этом теле.
 * 2. Подсказка постройки (`structureTooltipHtml`) — готовность, тоннаж и
 *    остатки по товарам.
 * 3. Панель интерфейса: карточка выбранного тела, чипы и полосы прогресса,
 *    подсказка «сейчас под курсором» и предупреждение без WebGL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadEngineModules, renderOrreryMap, solBodies, solStructures } from './orrery-harness.mjs';

let esbuild = null;
let jsdomAvailable = false;
try {
  esbuild = await import('esbuild');
  await import('jsdom');
  jsdomAvailable = true;
} catch {
  // devDependencies не установлены — пропускаем, но говорим об этом.
}

const maybe = esbuild ? test : test.skip;
const maybeUi = esbuild && jsdomAvailable ? test : test.skip;

const enginePromise = esbuild ? loadEngineModules() : null;

function buildPayload(engine, bodies = solBodies(), structures = solStructures()) {
  const layout = engine.buildOrreryLayout(bodies, 'Sol');
  return engine.buildOrreryView(layout, engine.toStructures(structures), { systemName: 'Sol' });
}

maybe('подсказка тела: факты, метки и прогресс построек', async () => {
  const engine = await enginePromise;
  try {
    const payload = buildPayload(engine);
    const body = payload.bodies.find((item) => item.name === 'Sol 3');
    assert.ok(body, 'в пакете нет землеподобной планеты');
    const html = engine.bodyTooltipHtml(body, payload.structures.filter((item) => item.body === body.name));

    assert.match(html, /Sol 3/, 'в подсказке нет имени тела');
    assert.match(html, /Earthlike/, 'в подсказке нет класса планеты');
    assert.match(html, /св\. с/, 'в подсказке нет дистанции');
    assert.match(html, /посадка/, 'пропала метка посадки');
    // Сигналы показываются по видам: «био: 2», «гео: 1» и т.д.
    assert.match(html, /био: 2/, 'пропало число биосигналов');
    assert.match(html, /обитаемой зоне/, 'не показано попадание в обитаемую зону');
    assert.match(html, /Заря/, 'в подсказке нет стройки на теле');
    assert.match(html, /29%/, 'в подсказке нет процента готовности');
    assert.match(html, /осталось/, 'в подсказке нет остатка груза');

    const star = payload.bodies.find((item) => item.kind === 'star');
    const starHtml = engine.bodyTooltipHtml(star, []);
    assert.match(starHtml, /звезда/, 'для звезды не подписан тип');
    assert.doesNotMatch(starHtml, /Полуось/, 'у звезды показана полуось орбиты');
  } finally {
    await engine.cleanup();
  }
});

maybe('подсказка тела: луна показывает планету-родителя', async () => {
  const engine = await enginePromise;
  try {
    const payload = buildPayload(engine);
    const moon = payload.bodies.find((item) => item.kind === 'moon');
    assert.ok(moon, 'в пакете нет луны');
    assert.match(engine.bodyTooltipHtml(moon, []), /луна/, 'луна не подписана');
    assert.equal(moon.parent, 'Sol 3', 'луна потеряла родителя');
  } finally {
    await engine.cleanup();
  }
});

maybe('подсказка постройки: готовность, тоннаж и остатки по товарам', async () => {
  const engine = await enginePromise;
  try {
    const payload = buildPayload(engine);
    const site = payload.structures.find((item) => item.name.includes('Заря'));
    assert.ok(site, 'в пакете нет стройки');
    const html = engine.structureTooltipHtml(site);
    assert.match(html, /Заря/);
    assert.match(html, /29%/);
    assert.match(html, /Доставлено/);
    assert.match(html, /Осталось/);
    assert.match(html, /Сталь/, 'не показаны остатки по товарам');
  } finally {
    await engine.cleanup();
  }
});

maybeUi('наведение: подсказка «сейчас под курсором» без выбранного тела', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures() });
  try {
    assert.match(view.text(), /Выберите тело на карте или в списке/, 'нет подсказки о выборе тела');
    view.emitHover({ kind: 'body', name: 'Sol 3', body: 'Sol 3' });
    await view.flush(10);
    assert.match(view.text(), /Сейчас под курсором: 3/, 'наведение не отразилось в панели');
    view.emitHover({ kind: 'structure', id: 'build-1', body: 'Sol 3' });
    await view.flush(10);
    assert.match(view.text(), /Сейчас под курсором: 3/, 'наведение на постройку не отразилось');
    view.emitHover(null);
    await view.flush(10);
    assert.doesNotMatch(view.text(), /Сейчас под курсором/, 'подсказка не убралась');
  } finally {
    await view.cleanup();
  }
});

maybeUi('карточка фокуса: факты, чипы и прогресс стройки', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures(), focusTarget: 'Sol 3' });
  try {
    const text = view.text();
    assert.match(text, /Sol 3/, 'в карточке нет имени тела');
    assert.match(text, /Класс/, 'в карточке нет класса');
    assert.match(text, /Землеподобн|Earthlike/, 'класс планеты не показан');
    assert.match(text, /От входа/, 'нет дистанции от точки входа');
    assert.match(text, /Обитаемая зона/, 'нет отметки обитаемой зоны');
    assert.match(text, /посадка/, 'нет чипа посадки');
    assert.match(text, /биологические сигналы: 2/, 'нет чипа био');
    assert.match(text, /Тестировщик/, 'нет первооткрывателя');
    assert.match(text, /Заря/, 'нет стройки на теле');
    assert.match(text, /29%/, 'нет процента готовности');
    assert.match(text, /осталось/, 'нет остатка груза');
  } finally {
    await view.cleanup();
  }
});

maybeUi('клик по телу ставит фокус, клик по пустоте — снимает', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures() });
  try {
    view.emitSelect({ kind: 'body', name: 'Sol 5', body: 'Sol 5' });
    await view.flush(10);
    assert.ok(view.viewerCall('focus').length >= 1 || /Газовый|Gas giant|Sol 5/.test(view.text()),
      'клик по телу не выбрал его');
    assert.match(view.text(), /кольца: 1|💍 колец: 1/, 'не показаны кольца газового гиганта');

    view.emitSelect(null);
    await view.flush(10);
    assert.match(view.text(), /Выберите тело на карте или в списке/, 'фокус не снялся');
  } finally {
    await view.cleanup();
  }
});

maybeUi('список тел: стройки, посадка и био видны в строках', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures() });
  try {
    const text = view.text();
    assert.match(text, /Заря/, 'в списке нет стройки');
    assert.match(text, /🏗/, 'в списке нет отметки процента стройки');
    assert.match(text, /обитаемая зона/, 'в списке не отмечена обитаемая зона');
    assert.match(text, /посадка/, 'в списке не отмечена посадка');
    assert.match(text, /осталось/, 'в списке нет остатка груза по стройке');
  } finally {
    await view.cleanup();
  }
});

maybeUi('легенда и подсказка по управлению объясняют карту', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures() });
  try {
    const text = view.text();
    assert.match(text, /звезда/, 'в легенде нет звезды');
    assert.match(text, /стройка в работе/, 'в легенде нет активной стройки');
    assert.match(text, /обитаемая зона/, 'в легенде нет обитаемой зоны');
    assert.match(text, /колесо — зум/, 'нет подсказки по управлению мышью');
    assert.match(text, /клик по телу — фокус/, 'нет подсказки по выбору тела');
  } finally {
    await view.cleanup();
  }
});
