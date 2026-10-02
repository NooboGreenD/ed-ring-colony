import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';

import {
  COPY_CHUNK_ROWS,
  GALAXY_STAGE_TABLE,
  copyLine,
  copySql,
  copyValue,
  createPgCopyWriter,
  mergeStatements,
  stageDdlSql,
} from '../../src/lib/galaxyCopyWriter.ts';
import { GALAXY_ROW_COLUMNS } from '../../src/lib/galaxyImport.ts';

/* ──────────────────────────────────────────────────────────────────────────
   «каталог грузится по 20 систем в секунду».

   Пачечный путь (INSERT … VALUES + DELETE … WHERE name_lc IN (…) OR id64 IN (…))
   на 2×10⁸ строк упирается в парсинг мегабайтного SQL и в seq scan от OR по
   двум уникальным индексам. Быстрый путь — COPY в UNLOGGED staging и merge
   пачками. Контракт ниже:
     · строка каталога кодируется текстовым форматом COPY без потерь;
     · staging создаётся без индексов и без WAL;
     · merge схлопывает дубли по ОБОИМ уникальным ключам до вставки;
     · merge идёт одной транзакцией и всегда оставляет staging пустым.
   ────────────────────────────────────────────────────────────────────────── */

const DB_URL = 'postgresql://postgres:s3cr3t@db:5432/postgres';

function row(overrides = {}) {
  return {
    id64: '1234',
    name: 'Sol',
    name_lc: 'sol',
    x: 0,
    y: 0,
    z: 0,
    main_star: 'G (White-Yellow) Star',
    star_type: 'g',
    star_giant_class: 'dwarf',
    needs_permit: false,
    distance_from_sols: 0,
    distance_from_sgra: 25899.96875,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─────────────────────── кодирование строки ───────────────────────

test('NULL, булево и спецсимволы кодируются форматом COPY, а не SQL', () => {
  assert.equal(copyValue(null), '\\N');
  assert.equal(copyValue(undefined), '\\N');
  assert.equal(copyValue(true), 't');
  assert.equal(copyValue(false), 'f');
  assert.equal(copyValue(Number.NaN), '\\N');
  // Табы и переводы строк в имени системы разорвали бы строку COPY.
  assert.equal(copyValue('a\tb\nc\\d'), 'a\\tb\\nc\\\\d');
});

test('строка каталога идёт в том же порядке колонок, что и INSERT-путь', () => {
  const line = copyLine(row({ main_star: null }));
  const fields = line.replace(/\n$/, '').split('\t');
  assert.equal(fields.length, GALAXY_ROW_COLUMNS.length);
  assert.equal(fields[GALAXY_ROW_COLUMNS.indexOf('name_lc')], 'sol');
  assert.equal(fields[GALAXY_ROW_COLUMNS.indexOf('main_star')], '\\N');
  assert.equal(fields[GALAXY_ROW_COLUMNS.indexOf('needs_permit')], 'f');
  assert.ok(line.endsWith('\n'));
});

// ─────────────────────── SQL быстрого пути ───────────────────────

test('staging — UNLOGGED и без индексов: иначе COPY платит за них дважды', () => {
  const ddl = stageDdlSql();
  assert.match(ddl, /CREATE UNLOGGED TABLE IF NOT EXISTS galaxy_systems_stage/);
  assert.match(ddl, /EXCLUDING INDEXES/);
  assert.match(ddl, /EXCLUDING IDENTITY/);
  // EXCLUDING IDENTITY не снимает NOT NULL с id, а COPY колонку id не пишет.
  // ALTER также чинит staging-таблицу, оставшуюся от предыдущего запуска.
  assert.match(ddl, /ALTER TABLE galaxy_systems_stage ALTER COLUMN id DROP NOT NULL/);
  assert.match(copySql(), /^COPY galaxy_systems_stage \(.+\) FROM STDIN$/);
});

test('merge снимает дубли по обоим уникальным ключам ДО вставки', () => {
  const [byName, byId, purge, insert] = mergeStatements();
  assert.match(byName, /DELETE FROM galaxy_systems_stage a USING galaxy_systems_stage b .*a\.name_lc = b\.name_lc/);
  assert.match(byId, /DELETE FROM galaxy_systems_stage a USING galaxy_systems_stage b .*a\.id64 = b\.id64/);
  // Переименованная система занимает id64 под другим именем: её надо убрать,
  // но join по индексу, а не «WHERE name_lc IN (…) OR id64 IN (…)».
  assert.match(purge, /DELETE FROM galaxy_systems g USING galaxy_systems_stage s WHERE g\.id64 = s\.id64 AND g\.name_lc <> s\.name_lc/);
  assert.ok(!purge.includes(' OR '), 'OR по двум уникальным индексам = seq scan по каталогу');
  assert.match(insert, /INSERT INTO galaxy_systems \(.+\) SELECT .+ FROM galaxy_systems_stage ON CONFLICT \(name_lc\) DO UPDATE SET/);
  assert.ok(!insert.includes('name_lc = EXCLUDED.name_lc'), 'ключ конфликта не переписывается');
});

// ─────────────────────── поведение писателя ───────────────────────

/** Postgres-заглушка: пишет историю запросов и принимает COPY-поток. */
function fakePg() {
  const statements = [];
  const copied = [];
  const client = {
    async connect() {},
    query(input) {
      if (typeof input === 'string') {
        statements.push(input);
        if (/^SELECT COUNT/.test(input)) return Promise.resolve({ rows: [{ n: '7' }], rowCount: 1 });
        // rowCount merge-а читается с последнего запроса (INSERT).
        if (/^INSERT INTO galaxy_systems /.test(input)) return Promise.resolve({ rows: [], rowCount: 3 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (input && input.__copy) {
        statements.push(input.sql);
        const sink = new Writable({
          write(chunk, _enc, done) {
            copied.push(String(chunk));
            done();
          },
        });
        return sink;
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    async end() {},
  };
  const pg = {
    Client: function Client() {
      return client;
    },
    Pool: function Pool() {
      return client;
    },
    Query: function Query(text) {
      return { text, on() {} };
    },
  };
  return { pg, statements, copied, copyFrom: (sql) => ({ __copy: true, sql }) };
}

test('писатель создаёт staging и не трогает каталог до merge', async () => {
  const { pg, statements, copyFrom } = fakePg();
  const writer = await createPgCopyWriter(DB_URL, { pg, copyFrom, mergeRows: 1000 });
  assert.equal(writer.backend, 'pg');
  assert.ok(statements.includes('SET synchronous_commit = OFF'), 'bulk-заливка не fsync-ает каждый commit');
  assert.ok(statements.some((sql) => sql.startsWith('CREATE UNLOGGED TABLE')));
  assert.ok(statements.includes(`TRUNCATE ${GALAXY_STAGE_TABLE}`));
  assert.ok(!statements.some((sql) => sql.startsWith('TRUNCATE galaxy_systems ')), '--truncate не запрашивали');
  // Каталог не пуст (COUNT=7) и это не полный дамп: дельта индексы не трогает.
  assert.ok(!statements.some((sql) => sql.startsWith('DROP INDEX')), 'дельта не снимает поисковые индексы');
  await writer.close();
});

// ─────────────── полный дамп и непустой каталог ───────────────
//
// Прод-инцидент: «каталог пуст или неполный — нужен полный дамп» выбрал
// полный импорт, но писатель снимал индексы только при COUNT(*)=0. Остаток
// прерванного импорта (7 строк и больше) оставлял GIN/GiST на месте — и
// «вставка и обновление индексов» шла по 400+ секунд на каждые 250 тыс.
// строк: ~800 слияний превращали дамп в недели.

test('полный дамп снимает поисковые индексы даже на непустом каталоге и строит их заново', async () => {
  const { pg, statements, copyFrom } = fakePg();
  const writer = await createPgCopyWriter(DB_URL, { pg, copyFrom, mergeRows: 1000, fullReload: true, env: {} });
  const dropped = statements.filter((sql) => sql.startsWith('DROP INDEX IF EXISTS '));
  assert.equal(dropped.length, 7, 'сняты все семь поисковых индексов');
  assert.ok(dropped.some((sql) => sql.includes('idx_galaxy_systems_name_trgm')), 'GIN trigram — самый дорогой');
  assert.ok(dropped.some((sql) => sql.includes('idx_galaxy_systems_coord')), 'GiST cube — второй по цене');
  // Уникальные индексы держат ON CONFLICT и идемпотентность — их снимать нельзя.
  assert.ok(!statements.some((sql) => sql.startsWith('DROP INDEX') && sql.includes('uq_galaxy_systems')));

  await writer.analyze();
  const created = statements.filter((sql) => sql.startsWith('CREATE INDEX IF NOT EXISTS'));
  assert.equal(created.length, 7, 'все семь индексов построены заново после заливки');
  assert.ok(statements.some((sql) => sql.startsWith('ANALYZE ')));
  await writer.close();
});

test('GALAXY_COPY_DROP_INDEXES=0 возвращает старое поведение (снимать только на пустом каталоге)', async () => {
  const { pg, statements, copyFrom } = fakePg();
  const writer = await createPgCopyWriter(DB_URL, {
    pg,
    copyFrom,
    mergeRows: 1000,
    fullReload: true,
    env: { GALAXY_COPY_DROP_INDEXES: '0' },
  });
  assert.ok(!statements.some((sql) => sql.startsWith('DROP INDEX')), 'аварийный выключатель уважается');
  await writer.analyze();
  assert.ok(!statements.some((sql) => sql.startsWith('CREATE INDEX')), 'нечего перестраивать — индексы не снимались');
  await writer.close();
});

test('flush: COPY → merge одной транзакцией → пустой staging', async () => {
  const { pg, statements, copied, copyFrom } = fakePg();
  const writer = await createPgCopyWriter(DB_URL, { pg, copyFrom, mergeRows: 1000 });
  await writer.add(row());
  await writer.add(row({ id64: '99', name: 'Sol ', name_lc: 'sol' })); // дубль по name_lc
  assert.equal(writer.written, 0, 'до flush в каталог ничего не уходит');
  const inserted = await writer.flush();

  assert.equal(copied.join('').split('\n').filter(Boolean).length, 2, 'обе строки ушли в COPY');
  assert.equal(inserted, 3, 'счётчик берётся с rowCount финального INSERT');
  assert.equal(writer.written, 3);
  assert.equal(writer.deferred, 0, 'COPY-путь ничего не откладывает построчно');

  const txn = statements.slice(statements.indexOf('BEGIN'));
  assert.deepEqual(
    [txn[0], txn[txn.length - 2], txn[txn.length - 1]],
    ['BEGIN', `TRUNCATE ${GALAXY_STAGE_TABLE}`, 'COMMIT'],
    'merge открывает транзакцию, чистит приёмник и коммитит',
  );
  await writer.close();
});

test('упавший merge откатывается и всё равно оставляет staging пустым', async () => {
  const { pg, copyFrom } = fakePg();
  let failed = false;
  const base = pg.Client;
  pg.Client = function Client(config) {
    const client = base(config);
    const query = client.query.bind(client);
    client.query = (input) => {
      if (typeof input === 'string' && input.startsWith('INSERT INTO galaxy_systems ') && !failed) {
        failed = true;
        return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
      }
      return query(input);
    };
    return client;
  };
  const writer = await createPgCopyWriter(DB_URL, { pg, copyFrom, mergeRows: 1000 });
  await writer.add(row());
  await assert.rejects(() => writer.flush(), /deadlock detected/);
  // Приёмник пуст → повтор пачки не задвоит строки.
  const second = await writer.flush();
  assert.equal(second, 0);
  await writer.close();
});

test('пачка уходит в COPY сама, без flush, и копится в staging до порога merge', async () => {
  const { pg, statements, copyFrom } = fakePg();
  const writer = await createPgCopyWriter(DB_URL, { pg, copyFrom, mergeRows: 10 * COPY_CHUNK_ROWS });
  for (let i = 0; i < COPY_CHUNK_ROWS; i++) {
    await writer.add(row({ id64: String(i), name_lc: `s${i}` }));
  }
  assert.ok(statements.some((sql) => sql.startsWith('COPY ')), 'COPY стартовал по порогу COPY_CHUNK_ROWS');
  assert.ok(!statements.includes('BEGIN'), 'merge ждёт своего порога');
  await writer.close();
});

// ─────────────────── обслуживание индексов ───────────────────

test('есть парные maintenance-файлы: снять индексы перед заливкой и вернуть после', () => {
  const drop = readFileSync('supabase/maintenance/galaxy_systems_bulk_load.sql', 'utf8');
  const build = readFileSync('supabase/maintenance/galaxy_systems_rebuild_indexes.sql', 'utf8');
  for (const index of ['idx_galaxy_systems_name_trgm', 'idx_galaxy_systems_coord']) {
    assert.match(drop, new RegExp(`DROP INDEX CONCURRENTLY IF EXISTS public\\.${index}`));
    assert.match(build, new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index}`));
  }
  // Уникальные индексы держат идемпотентность upsert-а — их снимать нельзя.
  const dropped = drop.split('\n').filter((line) => line.startsWith('DROP INDEX')).join('\n');
  assert.ok(!dropped.includes('uq_galaxy_systems_name_lc'));
  assert.ok(!dropped.includes('uq_galaxy_systems_id64'));
  assert.match(build, /ANALYZE public\.galaxy_systems/);
});
