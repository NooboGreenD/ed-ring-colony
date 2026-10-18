/**
 * Единая идентичность системы (`src/lib/systemIdentity.ts`).
 *
 * Все разделы сайта сравнивают системы одним ключом: старые имена функций
 * (`carrierSystemKey`, `coordinateNameKey`, `normalizeSystemKey`,
 * `nearbyNameKey`, `systemNameKey`, `systemKey` Архитектора) теперь ссылки
 * на общий `systemKey`, а отдельная быстрая функция импорта Spansh
 * (`galaxySystems.normalizeSystemName`) обязана давать тот же ключ.
 * Ссылки между разделами строятся одинаково и понимаются Атласом.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atlasSystemHref,
  cleanSystemName,
  externalSystemLinks,
  sameSystem,
  stationSearchHref,
  systemId64,
  systemKey,
  systemPageHref,
} from '../../src/lib/systemIdentity.ts';
import { normalizeSystemName as galaxyKey } from '../../src/lib/galaxySystems.ts';
import { carrierSystemKey } from '../../src/lib/carrierMap.ts';
import { coordinateNameKey } from '../../src/lib/systemCoordinateTypes.ts';
import { normalizeSystemKey } from '../../src/lib/atlas.ts';
import { nearbyNameKey } from '../../src/lib/atlasNearby.ts';
import { systemKey as governanceKey } from '../../src/lib/architect/governance.ts';
import { normalizeSystemName as projectName, systemKey as projectKey } from '../../src/lib/architect/projects.ts';
import { systemNameKey } from '../../src/lib/systemProgress.ts';
import { atlasFocusFromParams } from '../../src/lib/stationSearch.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const NAMES = [
  'Col 285 Sector AB-C d14-3',
  '  Col   285 Sector AB-C d14-3 ',
  'HIP 90297',
  'hip 90297',
  'Sagittarius A*',
  "Synuefe EN-H d11-96",
  'Swoilz BX-Y c15-3',
  'Wregoe\tXX-X c1-1',
  'Lagrange Point',
];

test('ключ системы: регистр, пробелы, управляющие символы', () => {
  assert.equal(systemKey('  Col   285 Sector AB-C d14-3 '), 'col 285 sector ab-c d14-3');
  assert.equal(systemKey('HIP\u000190297'), 'hip 90297');
  assert.equal(systemKey(null), '');
  assert.equal(cleanSystemName('  Sol \n'), 'Sol');
  assert.ok(sameSystem('hip 90297', 'HIP  90297'));
  assert.ok(!sameSystem('', ''), 'пустое имя не равно пустому');
});

test('старые функции ключа — тот же общий ключ', () => {
  for (const name of NAMES) {
    const key = systemKey(name);
    assert.equal(galaxyKey(name), key, `galaxy_systems.name_lc для «${name}»`);
    assert.equal(carrierSystemKey(name), key, 'carrierSystemKey');
    assert.equal(coordinateNameKey(name), key, 'coordinateNameKey');
    assert.equal(normalizeSystemKey(name), key, 'normalizeSystemKey');
    assert.equal(nearbyNameKey(name), key, 'nearbyNameKey');
    assert.equal(governanceKey(name), key, 'Архитектор: governance');
    assert.equal(projectKey(name), key, '«Проекты систем»');
    assert.equal(systemNameKey(name), key, 'кэш Raven (systemProgress)');
    assert.equal(projectName(name), cleanSystemName(name), 'отображаемое имя проекта');
  }
});

test('копий функции ключа в коде больше нет', () => {
  const files = [
    'src/lib/systemProgress.ts', 'src/lib/carrierMap.ts', 'src/lib/systemCoordinateTypes.ts', 'src/lib/atlas.ts',
    'src/lib/atlasNearby.ts', 'src/lib/architect/governance.ts', 'src/lib/architect/projects.ts',
    'src/lib/journalParser.ts', 'src/app/api/leaderboard/route.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!/\.trim\(\)\.replace\(\/\\s\+\/g, ' '\)\.toLowerCase\(\)/.test(source), `${file}: своя копия ключа системы`);
    assert.ok(source.includes('systemIdentity'), `${file} берёт ключ из systemIdentity.ts`);
  }
});

test('адрес системы: строкой, без потери разрядов', () => {
  assert.equal(systemId64('36028797018963971'), '36028797018963971');
  assert.equal(systemId64(10477373803), '10477373803');
  assert.equal(systemId64(36028797018963971), null, 'double уже потерял разряды');
  assert.equal(systemId64('9223372036854775808'), null, 'шире BIGINT');
  assert.equal(systemId64('-5'), null);
  assert.equal(systemId64('0'), null);
  assert.equal(systemId64('12a'), null);
  assert.equal(systemId64(BigInt('36028797018963971')), '36028797018963971');
});

test('ссылки между разделами строятся одинаково и понимаются Атласом', () => {
  assert.equal(systemPageHref(' HIP 90297 '), '/system/HIP%2090297');
  assert.equal(systemPageHref('Sol', { body: 'Earth' }), '/system/Sol?body=Earth');

  const href = atlasSystemHref('Col 285 Sector AB-C d14-3', {
    tab: 'factions', point: { x: -24.5, y: -33.75, z: 108.8 }, id64: '36028797018963971', from: 'system',
  });
  const params = new URL(href, 'https://edringcolony.ru').searchParams;
  assert.equal(params.get('tab'), 'factions');
  assert.equal(params.get('focus_id64'), '36028797018963971');
  assert.equal(params.get('from'), 'system');
  // Тот же разбор, которым Атлас читает фокус из поиска станций.
  assert.deepEqual(atlasFocusFromParams(params), { name: 'Col 285 Sector AB-C d14-3', x: -24.5, y: -33.75, z: 108.8 });

  assert.equal(atlasSystemHref('Sol', { tab: 'market' }), '/atlas?tab=market&system=Sol');
  assert.equal(atlasSystemHref('Sol'), '/atlas', 'без координат и адреса фокусировать нечего');
  assert.equal(atlasSystemHref('Sol', { point: { x: NaN, y: 0, z: 0 } }), '/atlas', 'битые координаты не попадают в ссылку');

  assert.equal(stationSearchHref('HIP 90297'), '/station-search?reference=HIP+90297');
  assert.equal(stationSearchHref('Sol', { kind: 'shipyard', q: 'Python' }), '/station-search?reference=Sol&kind=shipyard&q=Python');

  const external = externalSystemLinks('HIP 90297', '36028797018963971');
  assert.equal(external.spansh, 'https://spansh.co.uk/system/36028797018963971');
  assert.equal(external.edsm, 'https://www.edsm.net/en/system?systemName=HIP%2090297');
  assert.equal(externalSystemLinks('Sol').spansh, null);
});

test('страницы ведут в карточку системы и обратно', () => {
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  assert.ok(read('src/app/station-search/page.tsx').includes('systemPageHref(row.system_name)'), 'поиск станций → карточка системы');
  assert.ok(read('src/app/station-search/page.tsx').includes("params.get('reference')"), 'поиск станций принимает систему из ссылки');
  assert.ok(read('src/app/projects/[id]/page.tsx').includes('systemPageHref(s.system_name)'), 'проект эскадрильи → карточка системы');
  const atlas = read('src/app/atlas/page.tsx');
  assert.ok(atlas.includes("searchParams.get('focus_id64')"), 'Атлас понимает focus_id64');
  assert.ok(atlas.includes('showPowerplaySystem') && atlas.includes('showFactionSystem'), 'вкладки PowerPlay и «Фракции» открывают систему из ссылки');
  const page = read('src/app/system/[name]/page.tsx');
  assert.ok(page.includes('/api/systems/overview'), 'карточка системы читает сводку');
  assert.ok(page.includes('<SystemOverviewSections'), 'карточка системы показывает разделы сводки');
});
