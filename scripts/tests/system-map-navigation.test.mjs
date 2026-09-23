/**
 * Тесты навигации по 3D-карте системы: список тел, кластеры, поиск, фильтры
 * и переходы «выбрал тело — увидел его в адресе страницы».
 *
 * Карта живёт в состоянии страницы (`?body=…`): клик по телу сообщает наружу
 * новое имя, а ссылка на систему с телом в адресе открывает карту уже
 * сфокусированной. Это и проверяем — вместе с тем, что список тел честно
 * фильтруется и сортируется.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderOrreryMap, binaryBodies, solBodies, solStructures } from './orrery-harness.mjs';

let esbuild = null;
let jsdomAvailable = false;
try {
  esbuild = await import('esbuild');
  await import('jsdom');
  jsdomAvailable = true;
} catch {
  // devDependencies не установлены — пропускаем, но говорим об этом.
}

const maybe = esbuild && jsdomAvailable ? test : test.skip;

/** Строки тел в списке: кнопки «Показать <тело> на карте». */
function rows(view) {
  return Array.from(view.document.querySelectorAll('button'))
    .filter((item) => /^Показать .+ на карте$/.test(item.getAttribute('title') || ''));
}

maybe('клик по телу в списке фокусирует карту и сообщает имя наружу', async () => {
  const changes = [];
  const view = await renderOrreryMap({
    bodies: solBodies(), projects: solStructures(), onFocusChange: (name) => changes.push(name),
  });
  try {
    const target = rows(view).find((item) => /Sol 3(?! a)/.test(item.getAttribute('title') || ''));
    assert.ok(target, 'в списке нет землеподобной планеты');
    await view.click(target);
    assert.ok(view.viewerCall('focus').some(([, name]) => name === 'Sol 3'),
      `focus('Sol 3') не вызван: ${JSON.stringify(view.viewerCall('focus'))}`);
    assert.deepEqual(changes.slice(-1), ['Sol 3'], 'страница не узнала о выбранном теле');
    // Карточка фокуса обновилась на выбранное тело.
    assert.match(view.text(), /От входа/, 'карточка тела не открылась');
  } finally {
    await view.cleanup();
  }
});

maybe('кластер двойной звезды фокусируется по заголовку группы', async () => {
  const view = await renderOrreryMap({ bodies: binaryBodies() });
  try {
    const cluster = view.buttonByTitle('Показать кластер этой звезды');
    assert.ok(cluster, 'нет заголовка кластера в списке');
    assert.match(cluster.textContent || '', /★ Alpha/, 'кластер не подписан своей звездой');
    await view.click(cluster);
    assert.ok(view.viewerCall('focus').some(([, name]) => name === 'Alpha'),
      `фокус на звезду кластера не поставлен: ${JSON.stringify(view.viewerCall('focus'))}`);
  } finally {
    await view.cleanup();
  }
});

maybe('поиск по списку оставляет только совпавшие тела', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures() });
  try {
    assert.equal(rows(view).length, 5, `в списке не 5 тел: ${rows(view).length}`);
    const search = view.document.querySelector('input[aria-label="Поиск тела"]');
    await view.typeInto(search, '3 a');
    const found = rows(view);
    assert.equal(found.length, 1, `поиск вернул ${found.length} строк`);
    assert.match(found[0].getAttribute('title') || '', /Sol 3 a/);

    await view.typeInto(search, 'ничего-не-нашли');
    assert.equal(rows(view).length, 0);
    assert.match(view.text(), /Ничего не найдено/, 'нет сообщения о пустом результате');

    await view.typeInto(search, '');
    assert.equal(rows(view).length, 5, 'сброс поиска не вернул список');
  } finally {
    await view.cleanup();
  }
});

maybe('чип фильтра в списке управляет картой и составом списка', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures() });
  try {
    await view.click(view.button('стройки'));
    assert.deepEqual(view.viewerCall('setFilter').slice(-1), [['setFilter', 'sites']],
      'фильтр не уехал во вьюер');
    const titles = rows(view).map((item) => item.getAttribute('title'));
    assert.deepEqual(titles, ['Показать Sol 3 на карте', 'Показать Sol 5 на карте'],
      `список не отфильтровался: ${JSON.stringify(titles)}`);

    await view.click(view.button('посадка'));
    // Порядок строк — по дистанции орбиты: луна (4 св. с вокруг планеты)
    // идёт впереди самой планеты.
    assert.deepEqual(rows(view).map((item) => item.getAttribute('title')),
      ['Показать Sol 3 a на карте', 'Показать Sol 3 на карте'], 'фильтр посадки работает неверно');
  } finally {
    await view.cleanup();
  }
});

maybe('сортировка списка: по имени и по стройкам', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures() });
  try {
    const sort = view.document.querySelector('select[aria-label="Сортировка тел"]');
    assert.ok(sort, 'нет выбора сортировки');
    await view.setSelect(sort, 'name');
    assert.equal(rows(view)[0].getAttribute('title'), 'Показать Sol 1 на карте',
      'сортировка по имени не применилась');
    await view.setSelect(sort, 'progress');
    // Сортировка «по стройкам» — по сумме готовности: готовая станция у Sol 5
    // (100%) выше незавершённой стройки у Sol 3 (29%).
    assert.equal(rows(view)[0].getAttribute('title'), 'Показать Sol 5 на карте',
      'сортировка по стройкам не подняла тело с готовой постройкой');
  } finally {
    await view.cleanup();
  }
});

maybe('ссылка с телом в адресе открывает карту сфокусированной', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures(), focusTarget: 'Sol 3' });
  try {
    // Тело из адреса сцена получает сразу при создании — без прыжка камеры.
    assert.equal(view.stub.options?.focus, 'Sol 3', 'вьюер создан без стартового фокуса');
    assert.equal(view.stub.options?.zoom, 2, 'стартовый уровень приближения не «окрестность»');
    assert.match(view.text(), /От входа/, 'карточка стартового тела не показана');
  } finally {
    await view.cleanup();
  }
});

maybe('смена системы пересоздаёт сцену и убирает старую', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures() });
  try {
    assert.equal(view.stub.installed, 1, 'вьюер поднялся не один раз');
    await view.cleanup();
    const second = await renderOrreryMap({ bodies: binaryBodies(), systemName: 'Alpha' });
    try {
      assert.equal(second.stub.installed, 1, 'сцена поднялась повторно на ту же систему');
      assert.match(second.text(), /Alpha/, 'новая система не показана');
    } finally {
      await second.cleanup();
    }
  } catch (error) {
    throw error;
  }
});

maybe('фокус снимается кнопкой в карточке тела', async () => {
  const view = await renderOrreryMap({ bodies: solBodies(), projects: solStructures(), focusTarget: 'Sol 3' });
  try {
    await view.flush(10);
    const clear = view.buttonByTitle('Снять фокус');
    assert.ok(clear, 'в карточке нет кнопки снятия фокуса');
    await view.click(clear);
    assert.ok(view.viewerCall('fit').length >= 1, 'снятие фокуса не вернуло обзор системы');
    assert.match(view.text(), /Выберите тело на карте или в списке/, 'подсказка о выборе тела не вернулась');
  } finally {
    await view.cleanup();
  }
});
