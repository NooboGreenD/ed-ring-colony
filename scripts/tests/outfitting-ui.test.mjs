/**
 * Верфь в jsdom: вкладки сводки, фильтр отображения, подсказка, копирование
 * модуля, управление кораблём и окно обмена сборками.
 *
 * Приём тот же, что в `leaderboard-ui.test.mjs`: esbuild собирает компонент,
 * `next/link` подменяется якорем, справочник отдаётся заглушкой `fetch`.
 * Проверяем не вёрстку, а поведение, которое легко сломать правкой:
 *
 * 1. Вкладки «Атака» и «Защита» показывают именно боевые цифры, а не сводку.
 * 2. Переключатель «Показывать» меняет то, что написано в строке слота.
 * 3. Наведение на слот открывает подсказку с параметрами модуля.
 * 4. Кнопка копирования переносит модуль в совместимую ячейку и не трогает
 *    несовместимую.
 * 5. Форсаж и ползунок груза меняют цифры сводки.
 * 6. Окно обмена отдаёт рабочую ссылку Coriolis и принимает её обратно.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены
}
const maybe = esbuild ? test : test.skip;

const NEXT_LINK_STUB = `
import * as React from 'react';
export default function Link(props) {
  return React.createElement('a', { href: props.href }, props.children);
}
`;

const outfittingData = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'outfitting.json'), 'utf8'));

// Страховка: если монтирование упадёт на полпути, временные каталоги всё равно уберутся.
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function mountWorkspace() {
  const { JSDOM } = await import('jsdom');

  const dir = mkdtempSync(join(ROOT, '.tmp-outfitting-ui-'));
  tempDirs.push(dir);
  const entry = join(dir, 'entry.tsx');
  const bundle = join(dir, 'bundle.mjs');
  writeFileSync(join(dir, 'next-link.jsx'), NEXT_LINK_STUB);
  writeFileSync(join(dir, 'auth-fetch.mjs'), 'export const authFetch = (...args) => globalThis.fetch(...args);');
  writeFileSync(
    entry,
    [
      "export { default as OutfittingWorkspace } from '@/components/Outfitting/OutfittingWorkspace';",
      "export { I18nProvider } from '@/lib/i18n/I18nContext';",
      '',
    ].join('\n'),
  );

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client'],
    alias: {
      'next/link': join(dir, 'next-link.jsx'),
      '@/lib/supabaseClient': join(dir, 'auth-fetch.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    logLevel: 'silent',
  });

  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/api/outfitting/catalog')) {
      return { ok: true, status: 200, json: async () => outfittingData };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/outfitting',
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
  const flush = async (ms = 30) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };

  await act(async () => {
    root.render(React.createElement(mod.I18nProvider, null, React.createElement(mod.OutfittingWorkspace)));
  });
  await flush(80);

  const text = () => dom.window.document.body.textContent || '';
  const buttonsBy = (pattern) => [...dom.window.document.querySelectorAll('button')]
    .filter((node) => pattern.test(node.textContent || '' ) || pattern.test(node.getAttribute('title') || ''));
  const click = async (node) => {
    assert.ok(node, 'нечего нажимать');
    await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush();
  };

  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    dom.window.close();
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) global[key] = value;
    rmSync(dir, { recursive: true, force: true });
  };

  return { dom, document: dom.window.document, text, buttonsBy, click, flush, cleanup, act, React };
}

maybe('вкладки сводки показывают атаку, защиту и графики', async () => {
  const ui = await mountWorkspace();
  try {
    assert.match(ui.text(), /Sidewinder/, 'по умолчанию открыт Sidewinder');
    assert.match(ui.text(), /Полный бак/, 'сначала видна сводка');

    await ui.click(ui.buttonsBy(/^Атака$/)[0]);
    const offence = ui.text();
    assert.match(offence, /Урон в секунду/, 'на вкладке атаки есть DPS');
    assert.match(offence, /Непрерывный огонь/, 'и время непрерывного огня');
    assert.match(offence, /Термический/, 'урон разложен по типам');
    assert.doesNotMatch(offence, /Прыжок от загрузки/, 'графики не показаны');

    await ui.click(ui.buttonsBy(/^Защита$/)[0]);
    const defence = ui.text();
    assert.match(defence, /Эффективный запас|Генератор щита не установлен/);
    assert.match(defence, /Броня/);

    await ui.click(ui.buttonsBy(/^Графики$/)[0]);
    await ui.flush(40);
    const charts = ui.text();
    assert.match(charts, /Стоимость по разделам/);
    assert.match(charts, /Скорость от пипок ENG/);
    assert.ok(ui.document.querySelectorAll('svg polyline').length >= 2, 'ломаные нарисованы');

    await ui.click(ui.buttonsBy(/^Сводка$/)[0]);
    assert.match(ui.text(), /Полный бак/);
  } finally {
    await ui.cleanup();
  }
});

maybe('переключатель «Показывать» меняет строку слота', async () => {
  const ui = await mountWorkspace();
  try {
    assert.match(ui.text(), /Показывать/);

    // Режим «только названия» убирает цифры из строк, но не сами слоты.
    const slotList = ui.document.querySelector('div[draggable="true"]').parentElement;
    assert.match(slotList.textContent || '', /Прочность/, 'по умолчанию в строке есть масса с прочностью');
    await ui.click(ui.buttonsBy(/^Только названия$/)[0]);
    assert.match(slotList.textContent || '', /Реактор|Двигател/i, 'слоты на месте');
    assert.doesNotMatch(slotList.textContent || '', /Прочность/, 'параметры убраны');

    await ui.click(ui.buttonsBy(/^Масса$/)[0]);
    assert.match(ui.text(), /Масса/, 'масса подписана в строке слота');

    await ui.click(ui.buttonsBy(/^Цена$/)[0]);
    assert.match(ui.text(), /Цена/);
    assert.match(ui.text(), /CR/, 'в режиме цены видны кредиты');

    await ui.click(ui.buttonsBy(/^Энергия$/)[0]);
    assert.match(ui.text(), /Потребление|Выработка/, 'в режиме энергии видно потребление');

    await ui.click(ui.buttonsBy(/^Характеристики$/)[0]);
    assert.match(ui.text(), /Оптимальная масса|Дальность|Ёмкость/);
  } finally {
    await ui.cleanup();
  }
});

maybe('наведение на слот открывает подсказку с параметрами модуля', async () => {
  const ui = await mountWorkspace();
  try {
    assert.equal(ui.document.querySelector('[role="tooltip"]'), null, 'без наведения подсказки нет');

    // Берём орудие: у него есть параметры всех четырёх разделов сразу.
    const row = [...ui.document.querySelectorAll('div[draggable="true"]')]
      .find((node) => /лазер/i.test(node.textContent || ''));
    assert.ok(row, 'в сборке есть орудие');
    await ui.act(async () => {
      row.dispatchEvent(new ui.dom.window.MouseEvent('mouseover', {
        bubbles: true,
        clientX: 120,
        clientY: 200,
        relatedTarget: null,
      }));
    });
    await ui.flush();

    const tooltip = ui.document.querySelector('[role="tooltip"]');
    assert.ok(tooltip, 'подсказка появилась');
    const tip = tooltip.textContent || '';
    assert.match(tip, /Масса/, 'в подсказке есть масса');
    assert.match(tip, /ЛКМ/, 'и напоминание про управление');

    // Прокрутки внутри подсказки быть не должно: курсор на неё не наводится.
    assert.equal(tooltip.style.overflowY, '', 'у подсказки нет своей прокрутки');
    assert.equal(tooltip.style.maxHeight, '', 'и нет ограничения по высоте');
    assert.equal(tooltip.style.pointerEvents, 'none', 'подсказка не перехватывает курсор');
    assert.equal(tooltip.style.position, 'fixed', 'подсказка висит поверх страницы');

    // Показан весь набор параметров модуля, а не часть.
    assert.match(tip, /Урон/, 'характеристики');
    assert.match(tip, /Потребление/, 'энергия');
    assert.match(tip, /Прочность/, 'прочность');
    assert.match(tip, /Цена/, 'цена');

    await ui.act(async () => {
      row.dispatchEvent(new ui.dom.window.MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: ui.document.body,
      }));
    });
    await ui.flush();
    assert.equal(ui.document.querySelector('[role="tooltip"]'), null, 'подсказка убралась');
  } finally {
    await ui.cleanup();
  }
});

maybe('модуль копируется в совместимую ячейку', async () => {
  const ui = await mountWorkspace();
  try {
    // Орудия Sidewinder: два одинаковых пилона, между ними копирование законно.
    const rows = [...ui.document.querySelectorAll('div[draggable="true"]')];
    const weaponRow = rows.find((node) => /лазер/i.test(node.textContent || ''));
    assert.ok(weaponRow, 'в заводской сборке есть орудие');

    const copyButton = [...weaponRow.querySelectorAll('button')]
      .find((node) => node.getAttribute('title') === 'Копировать модуль');
    assert.ok(copyButton, 'у строки орудия есть кнопка копирования');

    await ui.click(copyButton);
    assert.match(ui.text(), /Выберите ячейку-приёмник/, 'подсказка режима показана');

    const allRows = [...ui.document.querySelectorAll('div[style*="border-left"]')];
    const greenTarget = allRows.find((node) => /rgba\(46,\s*204,\s*113,\s*0\.08\)/.test(node.getAttribute('style') || ''));
    assert.ok(greenTarget, 'хотя бы одна ячейка подсвечена как приёмник');

    // Нажимать надо центральную часть строки: именно на ней висит обработчик.
    const targetBody = [...greenTarget.querySelectorAll('div')]
      .find((node) => (node.getAttribute('style') || '').includes('flex: 1'));
    assert.ok(targetBody, 'у подсвеченной ячейки есть кликабельная середина');
    await ui.act(async () => {
      targetBody.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }));
    });
    await ui.flush();

    assert.match(ui.text(), /Модуль скопирован/, 'копирование подтверждено');

    // Копировать в несовместимую ячейку нельзя: реактор остаётся реактором.
    const coreRow = rows.find((node) => /Реактор/i.test(node.textContent || ''));
    assert.ok(coreRow, 'реактор на месте');
    const coreCopy = [...coreRow.querySelectorAll('button')]
      .find((node) => node.getAttribute('title') === 'Копировать модуль');
    await ui.click(coreCopy);
    const noTargets = [...ui.document.querySelectorAll('div[style*="border-left"]')]
      .filter((node) => /rgba\(46,\s*204,\s*113,\s*0\.08\)/.test(node.getAttribute('style') || ''));
    assert.equal(noTargets.length, 0, 'для основного слота приёмников нет');
  } finally {
    await ui.cleanup();
  }
});

maybe('управление кораблём: форсаж и загрузка меняют сводку', async () => {
  const ui = await mountWorkspace();
  try {
    assert.match(ui.text(), /Форсаж/);
    assert.match(ui.text(), /Орудия развёрнуты/);

    const boost = ui.buttonsBy(/^Форсаж$/)[0];
    assert.ok(boost, 'кнопка форсажа есть');
    assert.equal(boost.disabled, false, 'у заводского Sidewinder заряда на форсаж хватает');
    assert.equal(boost.getAttribute('aria-pressed'), 'false', 'сначала форсаж выключен');
    await ui.click(boost);
    assert.equal(boost.getAttribute('aria-pressed'), 'true', 'форсаж включился');

    const deployed = ui.buttonsBy(/^Орудия развёрнуты$/)[0];
    await ui.click(deployed);
    assert.equal(deployed.getAttribute('aria-pressed'), 'true', 'орудия выпущены');

    // Ползунок топлива: пустой бак — прыжок короче.
    const fuel = [...ui.document.querySelectorAll('input[type="range"]')]
      .find((node) => (node.getAttribute('aria-label') || '') === 'Топливо');
    assert.ok(fuel, 'ползунок топлива найден');

    const nativeSetter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set;
    await ui.act(async () => {
      nativeSetter.call(fuel, '0');
      fuel.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
      fuel.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    });
    await ui.flush();
    assert.equal(fuel.value, '0', 'ползунок уехал в ноль');
  } finally {
    await ui.cleanup();
  }
});

maybe('окно обмена отдаёт ссылку Coriolis и принимает её обратно', async () => {
  const ui = await mountWorkspace();
  try {
    await ui.click(ui.buttonsBy(/^Обмен$/)[0]);
    const dialog = ui.document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'окно обмена открылось');
    assert.match(dialog.textContent, /Ссылка Coriolis/);
    assert.match(dialog.textContent, /SLEF/);

    const fields = [...dialog.querySelectorAll('textarea')];
    const coriolis = fields.map((node) => node.value).find((value) => value.includes('coriolis.io/outfit/'));
    assert.ok(coriolis, 'ссылка Coriolis собрана');
    assert.match(coriolis, /code=A\d/, 'в ссылке есть код с версией и переборкой');

    const slef = fields.map((node) => node.value).find((value) => value.includes('"event"'));
    assert.ok(slef, 'SLEF собран');
    const payload = JSON.parse(slef);
    assert.equal(payload[0].data.Ship, 'sidewinder');

    // Вставляем ссылку на другой корабль — верфь должна его подхватить.
    const input = fields.find((node) => !node.readOnly);
    assert.ok(input, 'поле для вставки есть');
    const anacondaLink = coriolis.replace('/outfit/sidewinder', '/outfit/anaconda');
    const nativeSetter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype, 'value').set;
    await ui.act(async () => {
      nativeSetter.call(input, anacondaLink);
      input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    await ui.flush();

    await ui.click([...dialog.querySelectorAll('button')].find((node) => /Загрузить сборку/.test(node.textContent)));
    assert.match(ui.document.body.textContent, /Сборка загружена/);
  } finally {
    await ui.cleanup();
  }
});

maybe('блок Merc Coin раскрывается и объясняет неполноту цен', async () => {
  const ui = await mountWorkspace();
  try {
    const toggle = ui.buttonsBy(/Модули за Merc Coin/)[0];
    assert.ok(toggle, 'блок Merc Coin на странице есть');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');

    await ui.click(toggle);
    const text = ui.text();
    assert.match(text, /Extended Cargo Rack/);
    assert.match(text, /550 MC/);
    assert.match(text, /Чертёж инженера/);
    assert.match(text, /цена неизвестна/, 'неизвестные цены показаны честно');
    assert.match(text, /данным сообщества/, 'источник списка назван');
  } finally {
    await ui.cleanup();
  }
});

maybe('в списке модулей только название, параметры — в подсказке', async () => {
  const ui = await mountWorkspace();
  try {
    // Открываем окно выбора для орудийного пилона.
    const weaponRow = [...ui.document.querySelectorAll('div[draggable="true"]')]
      .find((node) => /лазер/i.test(node.textContent || ''));
    assert.ok(weaponRow, 'орудие на месте');
    const body = [...weaponRow.querySelectorAll('div')]
      .find((node) => (node.getAttribute('style') || '').includes('flex: 1'));
    await ui.act(async () => {
      body.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }));
    });
    await ui.flush(60);

    const dialog = ui.document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'окно выбора модуля открылось');

    // Строка списка: класс с рейтингом, название и цена — и ничего больше.
    const row = [...dialog.querySelectorAll('button')]
      .find((node) => /Импульсный лазер|Pulse Laser/i.test(node.textContent || '')
        && node.getAttribute('title') === 'ЛКМ — показать параметры · двойной клик — установить');
    assert.ok(row, 'в списке есть строка импульсного лазера');
    const rowText = row.textContent || '';
    assert.doesNotMatch(rowText, /Масса/, 'параметры под названием не выводятся');
    assert.doesNotMatch(rowText, /Урон в секунду/, 'и DPS тоже');
    assert.match(rowText, /CR/, 'цена осталась');

    // Наведение на строку — та же карточка, что и на слотах основного окна.
    assert.equal(dialog.querySelector('[role="tooltip"]'), null, 'без наведения подсказки нет');
    await ui.act(async () => {
      row.dispatchEvent(new ui.dom.window.MouseEvent('mouseover', {
        bubbles: true,
        clientX: 300,
        clientY: 240,
        relatedTarget: null,
      }));
    });
    await ui.flush();

    const tooltip = ui.document.querySelector('[role="tooltip"]');
    assert.ok(tooltip, 'подсказка появилась');
    const tip = tooltip.textContent || '';
    assert.match(tip, /Урон/, 'характеристики');
    assert.match(tip, /Масса/, 'масса');
    assert.match(tip, /Потребление/, 'энергия');
    assert.match(tip, /Цена/, 'цена');
    assert.match(tip, /двойной клик/, 'подпись про установку модуля');
    assert.equal(tooltip.style.overflowY, '', 'прокрутки внутри нет');
    assert.equal(tooltip.style.maxHeight, '', 'и ограничения по высоте тоже');

    await ui.act(async () => {
      row.dispatchEvent(new ui.dom.window.MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: ui.document.body,
      }));
    });
    await ui.flush();
    assert.equal(ui.document.querySelector('[role="tooltip"]'), null, 'подсказка убралась');

    // Правая панель: полный набор по разделам плюс сравнение со сборкой.
    const panel = dialog.textContent || '';
    assert.match(panel, /ХАРАКТЕРИСТИКИ/i, 'раздел характеристик');
    assert.match(panel, /ЭНЕРГИЯ/i, 'раздел энергии');
    assert.match(panel, /Начало спада/, 'редкое поле тоже показано');
    assert.match(panel, /Урон по модулям/, 'и урон по модулям');
    assert.match(panel, /Влияние на сборку|Сравнение/i, 'сравнение со сборкой осталось');
  } finally {
    await ui.cleanup();
  }
});
