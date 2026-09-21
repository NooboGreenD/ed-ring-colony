import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  classifyStar,
  normalizeSystemName,
  distanceFromSols,
  distanceFromSgra,
  SAGA_LY,
  encodePointsFile,
  parsePointsFile,
  id64FromParts,
  PointsBuilder,
  STAR_CLASS_LIST,
  toMapPositions,
} from '../../src/lib/galaxySystems.ts';
import { Readable } from 'node:stream';
import { streamObjects, toGalaxySystemRow } from '../import-spansh-systems.mjs';

// ─── classifyStar ───

test('classifyStar: все значения mainStar из схемы Spansh', () => {
  const cases = [
    ['O (Blue-White) Star', 'o', 'dwarf'],
    ['B (Blue-White) Star', 'b', 'dwarf'],
    ['A (Blue-White) Star', 'a', 'dwarf'],
    ['F (White) Star', 'f', 'dwarf'],
    ['G (White-Yellow) Star', 'g', 'dwarf'],
    ['K (Yellow-Orange) Star', 'k', 'dwarf'],
    ['M (Red dwarf) Star', 'm', 'dwarf'],
    ['L (Brown dwarf) Star', 'brown_dwarf', null],
    ['T (Brown dwarf) Star', 'brown_dwarf', null],
    ['Y (Brown dwarf) Star', 'brown_dwarf', null],
    ['Neutron Star', 'neutron', null],
    ['Black Hole', 'black_hole', null],
    ['Supermassive Black Hole', 'black_hole', null],
    ['White Dwarf (D) Star', 'white_dwarf', null],
    ['White Dwarf (DA) Star', 'white_dwarf', null],
    ['White Dwarf (DQ) Star', 'white_dwarf', null],
    ['Wolf-Rayet Star', 'wolf_rayet', null],
    ['Wolf-Rayet C Star', 'wolf_rayet', null],
    ['Wolf-Rayet N Star', 'wolf_rayet', null],
    ['Wolf-Rayet NC Star', 'wolf_rayet', null],
    ['Wolf-Rayet O Star', 'wolf_rayet', null],
    ['Herbig Ae/Be Star', 'herbig_ae_be', null],
    ['T Tauri Star', 't_tauri', null],
    ['C Star', 'carbon', null],
    ['CJ Star', 'carbon', null],
    ['CN Star', 'carbon', null],
    ['A (Blue-White super giant) Star', 'a', 'supergiant'],
    ['B (Blue-White super giant) Star', 'b', 'supergiant'],
    ['F (White super giant) Star', 'f', 'supergiant'],
    ['G (White-Yellow super giant) Star', 'g', 'supergiant'],
    ['M (Red super giant) Star', 'm', 'supergiant'],
    ['K (Yellow-Orange giant) Star', 'k', 'giant'],
    ['M (Red giant) Star', 'm', 'giant'],
    ['S-type Star', 's_type', null],
    ['MS-type Star', 'ms_type', null],
    ['White Dwarf (DAB) Star', 'white_dwarf', null],
    ['White Dwarf (DAV) Star', 'white_dwarf', null],
    ['White Dwarf (DAZ) Star', 'white_dwarf', null],
    ['White Dwarf (DB) Star', 'white_dwarf', null],
    ['White Dwarf (DBV) Star', 'white_dwarf', null],
    ['White Dwarf (DBZ) Star', 'white_dwarf', null],
    ['White Dwarf (DC) Star', 'white_dwarf', null],
    ['White Dwarf (DCV) Star', 'white_dwarf', null],
  ];
  for (const [mainStar, starType, giantClass] of cases) {
    const cls = classifyStar(mainStar);
    assert.equal(cls.starType, starType, `${mainStar} → starType`);
    assert.equal(cls.giantClass, giantClass, `${mainStar} → giantClass`);
  }

  // worldTypes для атласа
  assert.deepEqual(classifyStar('Neutron Star').worldTypes, ['neutron_star']);
  assert.deepEqual(classifyStar('Black Hole').worldTypes, ['black_hole']);
  assert.deepEqual(classifyStar('M (Red super giant) Star').worldTypes, ['supergiant']);
  assert.deepEqual(classifyStar('K (Yellow-Orange giant) Star').worldTypes, ['giant']);
  assert.deepEqual(classifyStar('G (White-Yellow) Star').worldTypes, []);

  // Не-звёздные значения (планетные подтипы) и мусор → unknown
  assert.equal(classifyStar('Earth-like world').starType, 'unknown');
  assert.equal(classifyStar('Ammonia world').starType, 'unknown');
  assert.equal(classifyStar(null).starType, 'unknown');
  assert.equal(classifyStar('').starType, 'unknown');
});

// ─── normalizeSystemName / расстояния ───

test('normalizeSystemName и расстояния', () => {
  assert.equal(normalizeSystemName('  Shinrarta   Dezhra '), 'shinrarta dezhra');
  assert.equal(normalizeSystemName('SOL'), 'sol');
  assert.equal(distanceFromSols(0, 0, 0), 0);
  assert.ok(Math.abs(distanceFromSols(3, 4, 0) - 5) < 1e-12);
  // Sagittarius A* на ~25 900 ly от Sol
  const d = distanceFromSgra(0, 0, 0);
  assert.ok(Math.abs(d - Math.hypot(SAGA_LY.x, SAGA_LY.y, SAGA_LY.z)) < 1e-9);
  assert.ok(d > 25000 && d < 27000, `SgrA distance ${d}`);
});

test('toMapPositions совпадает с кадром карты (Sgr A* в нуле)', () => {
  const elite = new Float32Array([0, 0, 0, SAGA_LY.x, SAGA_LY.y, SAGA_LY.z]);
  const mapped = toMapPositions(elite, 2);
  assert.equal(mapped[0], -SAGA_LY.x);
  assert.equal(mapped[1], -SAGA_LY.y);
  assert.equal(mapped[2], SAGA_LY.z);
  assert.equal(mapped[3], 0);
  assert.equal(mapped[4], 0);
  assert.equal(mapped[5], 0);
});

// ─── бинарный файл точек ───

test('points file: round-trip, включая id64 выше 2^53', () => {
  const rows = [
    { x: -1234.5, y: 88.25, z: 19808.125, id64: '10477373803', starType: 'g' },
    { x: 0, y: 0, z: 0, id64: '18446744073709551615', starType: 'black_hole' },
    // 15000000000000000000 — влезает в u64, но далеко за 2^53
    { x: 45.21875, y: -20.90625, z: 25899.96875, id64: '15000000000000000000', starType: 'unknown' },
  ];
  const buffer = encodePointsFile(rows);
  const parsed = parsePointsFile(buffer);
  assert.equal(parsed.count, 3);
  assert.ok(Math.abs(parsed.positions[0] - -1234.5) < 1e-2);
  assert.ok(Math.abs(parsed.positions[8] - 25899.96875) < 1e-3);
  assert.equal(id64FromParts(parsed.id64Hi[0], parsed.id64Lo[0]), '10477373803');
  assert.equal(id64FromParts(parsed.id64Hi[1], parsed.id64Lo[1]), '18446744073709551615');
  assert.equal(id64FromParts(parsed.id64Hi[2], parsed.id64Lo[2]), '15000000000000000000');
  // star class index совпадает со STAR_CLASS_LIST
  assert.equal(parsed.starTypes[0], STAR_CLASS_LIST.indexOf('g'));
  assert.equal(parsed.starTypes[1], STAR_CLASS_LIST.indexOf('black_hole'));
});

test('PointsBuilder: рост ёмкости без потери данных', () => {
  const builder = new PointsBuilder(4);
  for (let i = 0; i < 1000; i++) {
    builder.add({ x: i, y: -i, z: i * 0.5, id64: String(1000000 + i), starType: 'm' });
  }
  const parsed = parsePointsFile(builder.build());
  assert.equal(parsed.count, 1000);
  assert.ok(Math.abs(parsed.positions[999 * 3] - 999) < 1e-3);
});

// ─── стриминговый парсер дампа ───

async function parseText(text, { gzip = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spansh-test-'));
  const file = path.join(dir, 'dump.json' + (gzip ? '.gz' : ''));
  const bytes = gzip ? zlib.gzipSync(Buffer.from(text)) : Buffer.from(text);
  fs.writeFileSync(file, bytes);
  const stream = fs.createReadStream(file);
  const objects = [];
  for await (const obj of streamObjects(gzip ? stream.pipe(zlib.createGunzip()) : stream)) {
    objects.push(obj);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return objects;
}

test('streamObjects: utf-8, разрезанный посередине символа', async () => {
  const text = '[{"id64":1,"name":"Сириус","coords":{"x":1,"y":2,"z":3}}]';
  const buf = Buffer.from(text);
  let split = 1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) { split = i + 1; break; }
  }
  const stream = Readable.from([buf.subarray(0, split), buf.subarray(split)]);
  const objects = [];
  for await (const obj of streamObjects(stream)) objects.push(obj);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].name, 'Сириус');
  const row = toGalaxySystemRow(objects[0]);
  assert.equal(row.name, 'Сириус');
  assert.equal(row.name_lc, 'сириус');
});

test('streamObjects: одна запись на строку (канонический формат)', async () => {
  const text = [
    '[',
    '{"id64":10477373803,"name":"Sol","mainStar":"G (White-Yellow) Star","coords":{"x":0,"y":0,"z":0},"needsPermit":false,"updateTime":"2026-09-20T00:00:00Z"}',
    '{"id64":2540606888459776,"name":"Colonia","mainStar":"M (Red dwarf) Star","coords":{"x":-9530.5,"y":-910.28125,"z":19808.125},"needsPermit":false,"updateTime":"2026-09-20T00:00:00Z"}',
    ']',
  ].join('\n');
  const objects = await parseText(text);
  assert.equal(objects.length, 2);
  assert.equal(objects[0].name, 'Sol');
  assert.equal(objects[0].__id64Exact, '10477373803');
});

test('streamObjects: minified (вся запись на одной строке) и gzip', async () => {
  const rec = (i) =>
    `{"id64":${1000 + i},"name":"Sys ${i}","mainStar":"O (Blue-White) Star","coords":{"x":${i},"y":0,"z":0},"needsPermit":false,"updateTime":"2026-09-01T00:00:00Z"}`;
  const text = '[' + [0, 1, 2, 3, 4].map(rec).join(',') + ']';
  const objects = await parseText(text, { gzip: true });
  assert.equal(objects.length, 5);
  assert.equal(objects[4].name, 'Sys 4');
});

test('streamObjects: мульти-линейные записи, кавычки и скобки в именах', async () => {
  const text = [
    '[',
    '{',
    '  "id64": 42,',
    '  "name": "Sol \\"A\\" {braces}",',
    '  "mainStar": "Neutron Star",',
    '  "coords": { "x": 1.5, "y": -2.5, "z": 3.5 },',
    '  "needsPermit": true,',
    '  "updateTime": "2026-09-02T00:00:00Z"',
    '},',
    '{"id64":43,"name":"Next","coords":{"x":0,"y":0,"z":0}}',
    ']',
  ].join('\n');
  const objects = await parseText(text);
  assert.equal(objects.length, 2);
  assert.equal(objects[0].name, 'Sol "A" {braces}');
  assert.equal(objects[0].__id64Exact, '42');
  assert.equal(objects[1].name, 'Next');
});

test('toGalaxySystemRow: валидные и битые записи', () => {
  const row = toGalaxySystemRow({
    id64: 10477373803,
    __id64Exact: '10477373803',
    name: 'Sol',
    mainStar: 'G (White-Yellow) Star',
    coords: { x: 0, y: 0, z: 0 },
    needsPermit: false,
    updateTime: '2026-09-20T00:00:00Z',
  });
  assert.ok(row);
  assert.equal(row.id64, '10477373803');
  assert.equal(row.name_lc, 'sol');
  assert.equal(row.star_type, 'g');
  assert.equal(row.distance_from_sols, 0);
  assert.ok(row.distance_from_sgra > 25000);

  // Без id64 (хотя бы из-за потери точности не должно случиться — строка из парсера)
  assert.equal(toGalaxySystemRow({ name: 'X', coords: { x: 0, y: 0, z: 0 } }), null);
  // Нет координат
  assert.equal(toGalaxySystemRow({ id64: '1', name: 'X' }), null);
  // Битые координаты
  assert.equal(toGalaxySystemRow({ id64: '1', name: 'X', coords: { x: NaN, y: 0, z: 0 } }), null);
  // Пустое имя
  assert.equal(toGalaxySystemRow({ id64: '1', name: '   ', coords: { x: 0, y: 0, z: 0 } }), null);
});
