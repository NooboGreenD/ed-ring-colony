/**
 * Раздел Atlas и меню: проверки, которые ловят именно те ошибки, что уже
 * случались в проде.
 *
 *  1. Чистые помощники (`src/lib/atlas.ts`): CSV с BOM и CRLF, экранирование,
 *     безопасное имя файла, фильтрация/сортировка кандидатов.
 *  2. Регрессии интерфейса: в Atlas-компонентах не осталось «двойного»
 *     экранирования `\\ufeff`/`\\n` (CSV открывался одной строкой) и склейки
 *     JSX-элемента со строкой через `+` (в журнале рынка печаталось
 *     «[object Object]»).
 *  3. Меню: пункт Atlas присутствует и в боковом меню, и в нижней мобильной
 *     навигации, а все ссылки меню ведут на существующие страницы.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCsv,
  candidateMatchesQuery,
  countByWorldType,
  escapeCsvValue,
  favoriteKey,
  filterCandidates,
  formatArrivalLs,
  formatCoordinates,
  formatCredits,
  formatDistanceLy,
  normalizeSystemKey,
  relativeTime,
  routeToCsvRows,
  sanitizeFileName,
  sortCandidates,
  worldTypeLabel,
} from '../../src/lib/atlas.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function candidate(overrides = {}) {
  return {
    id: '1',
    system_name: 'Sol',
    world_type: 'earth_like',
    x: 0, y: 0, z: 0,
    distance_from_ref: 10,
    estimated_value: 1000,
    ...overrides,
  };
}

test('Atlas helpers: CSV пригоден для Excel', async (t) => {
  await t.test('BOM ставится первым символом, строки разделяются CRLF', () => {
    const csv = buildCsv([['A', 'B'], [1, 2]]);
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.equal(csv.slice(1), '"A";"B"\r\n"1";"2"');
    assert.ok(!csv.includes('\\ufeff'), 'в CSV не должно быть литерального \\ufeff');
    assert.ok(!csv.includes('\\n"'), 'переносы должны быть настоящими, а не «\\n»');
  });

  await t.test('кавычки и разделители экранируются', () => {
    assert.equal(escapeCsvValue('он сказал "да"'), '"он сказал ""да"""');
    assert.equal(escapeCsvValue(null), '""');
    const csv = buildCsv([['a;b', 'c"d']]);
    assert.ok(csv.includes('"a;b";"c""d"'));
  });

  await t.test('имя файла очищается от путей и служебных символов', () => {
    assert.equal(sanitizeFileName('route-../etc/Sol:Colonia?.csv'), 'route-.._etc_Sol_Colonia_.csv');
    assert.equal(sanitizeFileName('   '), 'atlas');
    assert.ok(sanitizeFileName('a'.repeat(400)).length <= 120);
  });

  await t.test('строки маршрута считают прыжок от предыдущей точки', () => {
    const rows = routeToCsvRows([
      { name: 'Sol', x: 0, y: 0, z: 0 },
      { name: 'Alpha Centauri', x: 3, y: 4, z: 0, source: 'triangulated' },
    ]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0][0], 'Порядок');
    assert.equal(rows[1][6], '');
    assert.equal(rows[2][6], '5.00');
    assert.equal(rows[2][5], 'Триангуляция');
  });
});

test('Atlas helpers: фильтрация и сортировка кандидатов', async (t) => {
  const rows = [
    candidate({ id: 'a', system_name: 'Sol', world_type: 'earth_like', distance_from_ref: 30, estimated_value: 500 }),
    candidate({ id: 'b', system_name: 'Colonia', world_type: 'water_world', distance_from_ref: 10, estimated_value: 9000 }),
    candidate({ id: 'c', system_name: 'Beagle Point', world_type: 'earth_like', body_name: 'Beagle Point 5', distance_from_ref: 20, estimated_value: 100 }),
  ];

  await t.test('фильтр по типу мира', () => {
    const filtered = filterCandidates(rows, { worldTypes: ['earth_like'] });
    assert.deepEqual(filtered.map((row) => row.id), ['a', 'c']);
  });

  await t.test('текстовый запрос ищет по системе, телу и типу', () => {
    assert.deepEqual(filterCandidates(rows, { query: 'beagle' }).map((row) => row.id), ['c']);
    assert.deepEqual(filterCandidates(rows, { query: 'water' }).map((row) => row.id), ['b']);
    assert.ok(candidateMatchesQuery(rows[0], 'EARTH'));
  });

  await t.test('фильтр «только избранное» работает по ключу системы и типа', () => {
    const keys = new Set([favoriteKey('Colonia', 'water_world')]);
    const filtered = filterCandidates(rows, { favoritesOnly: true, favoriteKeys: keys });
    assert.deepEqual(filtered.map((row) => row.id), ['b']);
  });

  await t.test('пустой запрос и пустой набор типов ничего не отбрасывают', () => {
    assert.equal(filterCandidates(rows, {}).length, 3);
    assert.equal(filterCandidates(rows, { query: '   ', worldTypes: [] }).length, 3);
  });

  await t.test('сортировка по дистанции не меняет исходный массив', () => {
    const sorted = sortCandidates(rows, 'distance');
    assert.deepEqual(sorted.map((row) => row.id), ['b', 'c', 'a']);
    assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
  });

  await t.test('сортировка по стоимости и имени', () => {
    assert.deepEqual(sortCandidates(rows, 'value').map((row) => row.id), ['b', 'a', 'c']);
    assert.deepEqual(sortCandidates(rows, 'name').map((row) => row.id), ['c', 'b', 'a']);
  });

  await t.test('подсчёт по типам отсортирован по количеству', () => {
    assert.deepEqual(countByWorldType(rows), [
      { type: 'earth_like', count: 2 },
      { type: 'water_world', count: 1 },
    ]);
  });
});

test('Atlas helpers: форматирование', async (t) => {
  await t.test('дистанции и кредиты не печатают NaN', () => {
    assert.equal(formatDistanceLy(1234.56), '1 234,6 св.л.');
    assert.equal(formatDistanceLy(null), '—');
    assert.equal(formatCredits(0), '—');
    assert.equal(formatCredits(250000), '250 000 CR');
    assert.equal(formatArrivalLs(1500.4), '1 500 св.с.');
    assert.equal(formatArrivalLs(undefined), '');
    assert.equal(formatCoordinates({ x: 1.25, y: -2.5, z: 25899.94 }), '1.3, -2.5, 25899.9');
  });

  await t.test('ключи систем и избранного нормализуются', () => {
    assert.equal(normalizeSystemKey('  Sol   A  '), 'sol a');
    assert.equal(favoriteKey('Sol A', 'earth_like'), 'sol a|earth_like');
    assert.equal(worldTypeLabel('rocky_bio'), 'Rocky + Bio');
    assert.equal(worldTypeLabel('unknown_type'), 'unknown type');
  });

  await t.test('относительное время не падает на некорректной дате', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    assert.equal(relativeTime(new Date('2026-10-10T11:58:00Z').toISOString(), now), '2 мин назад');
    assert.equal(relativeTime(new Date('2026-10-10T09:00:00Z').toISOString(), now), '3 ч назад');
    assert.equal(relativeTime('не дата', now), '');
  });
});

test('Atlas: в компонентах нет регрессий экспорта и журнала', () => {
  const files = fs.readdirSync(path.join(ROOT, 'src/components/Atlas'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => `src/components/Atlas/${name}`);
  assert.ok(files.length >= 8, 'папка Atlas должна содержать компоненты раздела');

  for (const file of files) {
    const source = read(file);
    // Двойное экранирование ломало CSV: файл открывался одной строкой с «\ufeff».
    assert.ok(!/\\\\ufeff/.test(source), `${file}: литеральный \\ufeff в CSV`);
    assert.ok(!/\\\\n'\)/.test(source), `${file}: литеральный \\n вместо переноса строки`);
    // `<Icon/> + ' '` печатало «[object Object]» в журнале сканирования.
    assert.ok(!/\/>\s*\+\s*['"]/.test(source), `${file}: склейка JSX-элемента со строкой через +`);
  }
});

test('Меню: Atlas доступен с любого устройства, ссылки ведут на существующие страницы', async (t) => {
  const sidebar = read('src/components/Sidebar.tsx');
  const mobileNav = read('src/components/MobileNav.tsx');

  await t.test('боковое меню содержит Atlas и разделы навигации', () => {
    assert.ok(sidebar.includes("href: '/atlas'"), 'в боковом меню нет пункта Atlas');
    for (const href of ['/atlas', '/map', '/systems', '/projects', '/wiki', '/architect']) {
      assert.ok(sidebar.includes(`href: '${href}'`), `в меню нет пункта ${href}`);
    }
  });

  await t.test('персональные разделы живут в меню пользователя, а не в навигации', () => {
    // Магазин, поддержка и личный кабинет убраны из бокового меню: это
    // персональные сервисы, и дублировать их в навигации по разделам не нужно.
    const userMenu = read('src/components/UserMenu.tsx');
    for (const href of ['/support', '/premium-shop', '/account']) {
      assert.ok(!sidebar.includes(`href: '${href}'`), `пункт ${href} остался в боковом меню`);
      assert.ok(userMenu.includes(`href="${href}"`), `пункт ${href} отсутствует в меню пользователя`);
      const page = `src/app${href}/page.tsx`;
      assert.ok(fs.existsSync(path.join(ROOT, page)), `нет страницы для пункта меню ${href} (${page})`);
    }
    // Меню пользователя должно оставаться доступным с клавиатуры.
    assert.ok(userMenu.includes('role="menuitem"'), 'пункты меню пользователя без role=menuitem');
    assert.ok(userMenu.includes('ArrowDown') && userMenu.includes('ArrowUp'), 'в меню пользователя нет навигации стрелками');
  });

  await t.test('нижняя мобильная навигация использует переводы и активный пункт', () => {
    assert.ok(mobileNav.includes("translation: 'nav.atlas'"), 'Atlas отсутствует в мобильной навигации');
    assert.ok(mobileNav.includes('mobile-nav-item.active') || mobileNav.includes("' active'"), 'нет подсветки активного пункта');
    // Комментарии не считаем: подписи пунктов обязаны приходить из словаря.
    const mobileNavCode = mobileNav.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/[А-Яа-я]/.test(mobileNavCode), 'в MobileNav не должно быть захардкоженного русского текста');
  });

  await t.test('все href меню ведут на страницы приложения', () => {
    const hrefs = new Set();
    for (const source of [sidebar, mobileNav]) {
      for (const match of source.matchAll(/href:\s*'([^']+)'/g)) hrefs.add(match[1]);
    }
    assert.ok(hrefs.size >= 15, `найдено слишком мало пунктов меню: ${hrefs.size}`);
    for (const href of hrefs) {
      const page = href === '/' ? 'src/app/page.tsx' : `src/app${href}/page.tsx`;
      assert.ok(fs.existsSync(path.join(ROOT, page)), `нет страницы для пункта меню ${href} (${page})`);
    }
  });
});
