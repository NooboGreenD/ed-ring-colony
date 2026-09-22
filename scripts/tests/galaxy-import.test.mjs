import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';

import {
  JsonArrayObjects,
  streamObjects,
  toGalaxySystemRow,
} from '../../src/lib/galaxySpanshStream.ts';
import {
  SUPABASE_BATCH_SIZE,
  collapseGalaxyBatch,
  createSupabaseWriter,
  formatBytes,
  pgDeleteConflictsSql,
  pgInsertSql,
  pgLiteral,
  readPointsFromSupabase,
  runGalaxyImport,
  writeGalaxyRowsPg,
} from '../../src/lib/galaxyImport.ts';
import {
  EMPTY_IMPORT_STATE,
  importPercent,
  parseImportState,
} from '../../src/lib/galaxyImportJob.ts';
import {
  FRESH_MS,
  MAX_ATTEMPTS,
  decideScheduledImport,
} from '../../src/lib/galaxyImportSchedule.ts';
import { catalogNote } from '../../src/lib/galaxyCatalogStatus.ts';
import { id64FromParts, parsePointsFile } from '../../src/lib/galaxySystems.ts';

// ─────────────────────── helpers ───────────────────────

const STARS = ['G (White-Yellow) Star', 'M (Red dwarf) Star', 'Neutron Star', 'Black Hole', null];

function makeRecords(count) {
  const out = [];
  for (let n = 0; n < count; n++) {
    out.push({
      // Raw digits: real id64 values exceed 2^53 and JSON.parse would round them.
      id64Raw: String(18446744073709551000n + BigInt(n)),
      name: n % 7 === 0 ? `Synthetic System ${n}` : `Synthetic-System-${n}`,
      mainStar: STARS[n % STARS.length],
      coords: { x: (n % 100) * 10.5, y: ((n % 37) - 18) * 3.25, z: -(n % 53) * 7.75 },
      needsPermit: n % 5 === 0,
      updateTime: '2026-09-20T00:00:00Z',
    });
  }
  return out;
}

/** One record per line, id64 as a raw number — exactly the Spansh layout. */
function dumpBuffer(records) {
  const lines = records.map(
    (r) => `{"id64":${r.id64Raw},"name":${JSON.stringify(r.name)}` +
      `${r.mainStar ? `,"mainStar":${JSON.stringify(r.mainStar)}` : ''}` +
      `,"coords":{"x":${r.coords.x},"y":${r.coords.y},"z":${r.coords.z}}` +
      `,"needsPermit":${r.needsPermit},"updateTime":${JSON.stringify(r.updateTime)}}`,
  );
  return Buffer.from(`[\n${lines.join('\n')}\n]\n`);
}

const gzDump = (records) => gzipSync(dumpBuffer(records));

function chunkedReadable(buffer, size) {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= buffer.length) {
        this.push(null);
        return;
      }
      this.push(buffer.subarray(offset, offset + size));
      offset += size;
    },
  });
}

/**
 * Response whose body is the whole buffer, or a truncated one: a dropped
 * connection shows up as a gzip stream that simply stops, which is exactly what
 * the importer has to survive.
 */
function dumpResponse(buffer, { truncateAt = null, chunkSize = 16 * 1024 } = {}) {
  const limit = truncateAt == null ? buffer.length : Math.min(truncateAt, buffer.length);
  const source = new Readable({ read() {} });
  for (let i = 0; i < limit; i += chunkSize) {
    source.push(buffer.subarray(i, Math.min(limit, i + chunkSize)));
  }
  source.push(null);
  return new Response(Readable.toWeb(source), { status: 200 });
}

const toArrayBuffer = (buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

/** In-memory stand-in for `galaxy_systems`: upsert by name_lc, ids in insert order. */
function fakeTable() {
  const rows = new Map();
  let nextId = 1;
  return {
    rows,
    upsert(batch) {
      for (const row of batch) {
        const existing = rows.get(row.name_lc);
        if (existing) Object.assign(existing, row);
        else rows.set(row.name_lc, { id: nextId++, ...row });
      }
    },
    count: () => rows.size,
    ordered: () => [...rows.values()].sort((a, b) => a.id - b.id),
  };
}

const rowsOf = (records) => records.map((record) => toGalaxySystemRow({ ...record, __id64Exact: record.id64Raw }));

function memoryWriter(table, batchSize = 100) {
  let batch = [];
  let written = 0;
  const flush = async () => {
    if (batch.length === 0) return 0;
    const rows = batch;
    batch = [];
    table.upsert(rows);
    written += rows.length;
    return rows.length;
  };
  return {
    backend: 'memory',
    get written() {
      return written;
    },
    async add(row) {
      batch.push(row);
      if (batch.length >= batchSize) await flush();
    },
    flush,
    async countRows() {
      await flush();
      return table.count();
    },
    async readPoints(onPoint) {
      let count = 0;
      for (const row of table.ordered()) {
        count++;
        onPoint({ x: row.x, y: row.y, z: row.z, id64: row.id64, starType: row.star_type });
      }
      return count;
    },
    async close() {
      batch = [];
    },
  };
}

/** Chainable PostgREST look-alike over the fake table, with an optional row cap. */
function fakeSupabase(table, { maxRows = null, failUpsert = null, countBias = 0, rejectDuplicateConflictKeys = false } = {}) {
  const calls = { upserts: [], pages: [], counts: 0 };

  const from = (name) => {
    assert.equal(name, 'galaxy_systems');
    const builder = {
      _gt: null,
      _limit: null,
      select(_columns, options) {
        if (options?.head) {
          calls.counts++;
          return Promise.resolve({ count: table.count() + countBias, error: null, data: null });
        }
        return builder;
      },
      gt(column, value) {
        builder._gt = { column, value };
        return builder;
      },
      order(_column, options) {
        builder._order = options;
        return builder;
      },
      limit(size) {
        builder._limit = size;
        return builder;
      },
      async upsert(rows, options) {
        calls.upserts.push({ size: rows.length, options, rows });
        if (failUpsert) return { error: { message: failUpsert }, data: null };
        assert.equal(options.onConflict, 'name_lc');
        if (rejectDuplicateConflictKeys) {
          const names = new Set();
          const ids = new Set();
          for (const row of rows) {
            if (names.has(row.name_lc) || ids.has(row.id64)) {
              return {
                error: {
                  code: '21000',
                  message: 'ON CONFLICT DO UPDATE command cannot affect row a second time',
                },
                data: null,
              };
            }
            names.add(row.name_lc);
            ids.add(row.id64);
          }
        }
        table.upsert(rows);
        return { error: null, data: null };
      },
      then(resolve, reject) {
        try {
          let rows = table.ordered();
          if (builder._gt) rows = rows.filter((row) => row[builder._gt.column] > builder._gt.value);
          calls.pages.push(builder._limit ?? rows.length);
          if (builder._limit != null) rows = rows.slice(0, builder._limit);
          if (maxRows != null) rows = rows.slice(0, maxRows);
          resolve({ data: rows, error: null, count: null });
        } catch (error) {
          reject(error);
        }
      },
    };
    return builder;
  };

  return { client: { from }, calls };
}

// ─────────────────────── parser: offsets and resume ───────────────────────

test('parser tags every record with a non-decreasing stream offset', async () => {
  const records = makeRecords(400);
  const offsets = [];
  const source = chunkedReadable(dumpBuffer(records), 37);
  for await (const object of source.pipe(new JsonArrayObjects())) {
    offsets.push(object.__streamOffset);
  }

  assert.equal(offsets.length, records.length);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i] >= offsets[i - 1], 'offsets must never go backwards');
  }
  assert.ok(offsets.at(-1) > offsets[0], 'the offset advances over the dump');
});

test('skipping records before a stored restart point loses nothing', async () => {
  // The runner stores the offset of the last FLUSHED record and, on restart,
  // skips everything strictly before it. Verify that rule for many cut points:
  // every skipped record must already be written, and every record after the
  // cut must be processed again.
  const records = makeRecords(2000);
  const parsed = [];
  for await (const object of streamObjects(Readable.from(gzDump(records)).pipe(createGunzip()))) {
    parsed.push({ row: toGalaxySystemRow(object), offset: object.__streamOffset });
  }
  assert.equal(parsed.length, records.length);
  assert.ok(parsed.every((entry) => entry.row), 'every synthetic record maps to a row');

  for (const cut of [1, 40, 777, 1200, parsed.length - 2]) {
    const restartAt = parsed[cut].offset;
    const written = new Set(parsed.slice(0, cut + 1).map((entry) => entry.row.name_lc));
    const skipped = parsed.filter((entry) => entry.offset < restartAt);
    const reprocessed = new Set(
      parsed.filter((entry) => entry.offset >= restartAt).map((entry) => entry.row.name_lc),
    );

    for (const entry of skipped) {
      assert.ok(written.has(entry.row.name_lc), `skipped ${entry.row.name} was never written`);
    }
    for (const entry of parsed.slice(cut + 1)) {
      assert.ok(reprocessed.has(entry.row.name_lc), `record after the cut was lost: ${entry.row.name}`);
    }
    // Records share the offset of the gunzip chunk they ended in (~16 KiB), so
    // only a cut beyond the first chunk can skip anything.
    if (cut >= 777) assert.ok(skipped.length > 0, `cut ${cut} must skip something`);
  }
});

// ─────────────────────── SQL helpers ───────────────────────

test('pgInsertSql escapes names and upserts on name_lc', () => {
  const row = toGalaxySystemRow({
    __id64Exact: '18446744073709551615',
    name: "O'Brien's Cluster 7",
    mainStar: 'Neutron Star',
    coords: { x: 1.5, y: -2.25, z: 0 },
    needsPermit: true,
    updateTime: '2026-09-20T00:00:00Z',
  });
  const sql = pgInsertSql([row]);
  assert.match(sql, /^INSERT INTO galaxy_systems \(id64,name,name_lc,/);
  assert.ok(sql.includes("'O''Brien''s Cluster 7'"), 'single quotes are doubled');
  assert.ok(sql.includes("'18446744073709551615'"), 'the u64 id stays exact text');
  assert.match(sql, /ON CONFLICT \(name_lc\) DO UPDATE SET/);
  assert.ok(!sql.includes('name_lc = EXCLUDED.name_lc'), 'the conflict key is not updated');
  assert.match(sql, /,true,/, 'boolean needs_permit');

  assert.equal(pgLiteral(null), 'NULL');
  assert.equal(pgLiteral(undefined), 'NULL');
  assert.equal(pgLiteral(Number.NaN), 'NULL');
  assert.equal(pgLiteral(12.5), '12.5');
});

test('collapseGalaxyBatch keeps one row per name_lc and per id64', () => {
  const [first, second, third] = rowsOf(makeRecords(3));
  const newerSameName = {
    ...first,
    id64: '9001',
    x: 42,
    updated_at: '2026-09-21T00:00:00Z',
    name: `  ${first.name.toUpperCase()}  `,
  };
  // Same physical system (id64) under a new name, older than `third`'s timestamp
  // so the fresher catalog row wins and the stale name is dropped.
  const renamedOlder = {
    ...second,
    name: 'Renamed Twin',
    name_lc: 'renamed twin',
    id64: third.id64,
    updated_at: '2020-01-01T00:00:00Z',
  };

  const collapsed = collapseGalaxyBatch([first, second, third, newerSameName, renamedOlder]);
  const names = collapsed.map((row) => row.name_lc);
  assert.equal(new Set(names).size, names.length, 'name_lc is unique in the batch');
  assert.equal(new Set(collapsed.map((row) => row.id64)).size, collapsed.length, 'id64 is unique in the batch');
  assert.deepEqual(names, [first.name_lc, second.name_lc, third.name_lc]);
  assert.equal(collapsed[0].x, 42, 'the newer snapshot of a repeated name wins');
  assert.equal(collapsed[0].id64, '9001');
  assert.equal(collapsed.find((row) => row.name_lc === 'renamed twin'), undefined, 'stale id64 twin is dropped');
  assert.equal(collapsed[2].id64, third.id64);

  const sql = pgInsertSql([first, newerSameName]);
  assert.equal(sql.split('),(').length, 1, 'duplicate name_lc is not emitted twice');
  assert.match(sql, /ON CONFLICT \(name_lc\) DO UPDATE SET/);
  assert.ok(sql.includes("'9001'"), 'the fresher id64 is the one written');
  const deleteSql = pgDeleteConflictsSql([collapsed[0], collapsed[2]]);
  assert.match(deleteSql, /^DELETE FROM galaxy_systems WHERE name_lc IN \(/);
  assert.match(deleteSql, / OR id64 IN \(/);
  assert.ok(deleteSql.includes("'9001'"));
});

test('writeGalaxyRowsPg retries a unique violation inside one transaction', async () => {
  const rows = rowsOf(makeRecords(2));
  const statements = [];
  let inserts = 0;
  const written = await writeGalaxyRowsPg(async (sql) => {
    statements.push(sql);
    if (sql.startsWith('INSERT') && inserts++ === 0) {
      const error = new Error('duplicate key value violates unique constraint "uq_galaxy_systems_id64"');
      error.code = '23505';
      throw error;
    }
  }, rows);
  assert.equal(written, 2);
  assert.equal(statements[0].startsWith('INSERT'), true);
  assert.equal(statements[1], 'BEGIN');
  assert.match(statements[2], /^DELETE FROM galaxy_systems/);
  assert.equal(statements[3].startsWith('INSERT'), true);
  assert.equal(statements[4], 'COMMIT');
});

test('writeGalaxyRowsPg splits a batch Postgres refuses to upsert twice', async () => {
  const statements = [];
  await writeGalaxyRowsPg(async (sql) => {
    statements.push(sql);
    if (sql.startsWith('INSERT') && sql.includes('),(')) {
      const error = new Error('ON CONFLICT DO UPDATE command cannot affect row a second time');
      error.code = '21000';
      throw error;
    }
  }, rowsOf(makeRecords(4)));
  const inserts = statements.filter((sql) => sql.startsWith('INSERT'));
  assert.ok(inserts.some((sql) => sql.includes('),(')), 'the full batch is attempted first');
  assert.ok(inserts.some((sql) => !sql.includes('),(')), 'a rejected batch is retried row by row');
  assert.equal(statements.includes('BEGIN'), false, 'cardinality is not "fixed" by deleting the batch');
});

// ─────────────────────── the pipeline ───────────────────────

test('runGalaxyImport writes every record and builds the point cloud', async () => {
  const records = makeRecords(2500);
  const buffer = gzDump(records);
  const table = fakeTable();
  const snapshots = [];
  let clock = Date.parse('2026-09-22T00:00:00Z');

  const result = await runGalaxyImport({
    writer: memoryWriter(table, 250),
    fetchImpl: async () => dumpResponse(buffer),
    now: () => (clock += 300),
    progressIntervalMs: 1000,
    onProgress: (snapshot) => snapshots.push(snapshot),
  });

  assert.equal(result.processed, records.length);
  assert.equal(result.invalid, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.written, records.length);
  assert.equal(result.systemsCount, records.length);
  assert.equal(table.count(), records.length);
  assert.equal(result.bytesDone, buffer.length);
  assert.equal(result.resumedFrom, 0);
  assert.equal(result.points.rebuiltFromTable, false, 'a full pass builds the cloud while streaming');

  // Exact u64 ids and star classes survive into the map cloud.
  const points = parsePointsFile(toArrayBuffer(result.points.buffer));
  assert.equal(points.count, records.length);
  assert.equal(id64FromParts(points.id64Hi[0], points.id64Lo[0]), records[0].id64Raw);
  assert.equal(id64FromParts(points.id64Hi[2], points.id64Lo[2]), records[2].id64Raw);
  assert.equal(points.starTypes[2], 8, 'the third record is a neutron star');
  assert.ok(Math.abs(points.positions[0] - records[0].coords.x) < 1e-3);

  assert.ok(snapshots.length > 1, 'progress is reported during the run');
  const last = snapshots.at(-1);
  assert.ok(last.resumeOffset > 0, 'a restart point is published while writing');
  assert.equal(last.bytesTotal, null, 'undici sets no Content-Length for a streamed body');

  const permitRow = table.rows.get('synthetic-system-5');
  assert.equal(permitRow.star_type, 'g');
  assert.equal(permitRow.star_giant_class, 'dwarf');
  assert.equal(permitRow.needs_permit, true);
  assert.equal(permitRow.id64, records[5].id64Raw);
});

test('a truncated download fails loudly, and the next pass resumes without losing rows', async () => {
  const records = makeRecords(4000);
  const buffer = gzDump(records);
  const table = fakeTable();
  const snapshots = [];
  let clock = Date.parse('2026-09-22T00:00:00Z');
  const shared = {
    now: () => (clock += 300),
    progressIntervalMs: 1000,
    onProgress: (snapshot) => snapshots.push(snapshot),
  };

  await assert.rejects(
    () =>
      runGalaxyImport({
        ...shared,
        writer: memoryWriter(table, 200),
        fetchImpl: async () => dumpResponse(buffer, { truncateAt: Math.floor(buffer.length * 0.4) }),
      }),
    /truncated|unexpected end|incorrect|Z_BUF|incomplete/i,
  );

  const writtenAfterFailure = table.count();
  assert.ok(writtenAfterFailure > 0, 'rows written before the drop are kept');
  assert.ok(writtenAfterFailure < records.length, 'the pass did not finish');
  const restartAt = snapshots.at(-1).resumeOffset;
  assert.ok(restartAt > 0, 'a restart point was published before the drop');

  // A restart means a fresh writer, as after a container redeploy.
  const resumed = await runGalaxyImport({
    ...shared,
    writer: memoryWriter(table, 200),
    resumeFrom: restartAt,
    fetchImpl: async () => dumpResponse(buffer),
  });

  assert.equal(table.count(), records.length, 'the catalog is complete after the resumed pass');
  assert.equal(resumed.systemsCount, records.length);
  assert.equal(resumed.processed + resumed.skipped, records.length);
  assert.ok(resumed.skipped > 0, 'already stored records are not written twice');
  assert.ok(resumed.processed < records.length, 'the resumed pass does not redo the whole dump');
  assert.equal(resumed.resumedFrom, restartAt);
  // The resumed pass only saw the tail of the dump, so the cloud comes from the
  // table and must still contain every system.
  assert.equal(resumed.points.rebuiltFromTable, true);
  assert.equal(resumed.points.count, records.length);
  for (const row of rowsOf(records)) {
    const stored = table.rows.get(row.name_lc);
    assert.ok(stored, `${row.name} is missing after resume`);
    assert.equal(stored.id64, row.id64);
    assert.equal(stored.star_type, row.star_type);
  }
});

test('an HTTP error is reported with its status', async () => {
  const table = fakeTable();
  await assert.rejects(
    () =>
      runGalaxyImport({
        writer: memoryWriter(table),
        fetchImpl: async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' }),
      }),
    /Download failed: HTTP 503/,
  );
  assert.equal(table.count(), 0);
});

test('invalid records are counted, not stored', async () => {
  const text = `[\n${[
    '{"id64":1,"name":"Good One","coords":{"x":1,"y":2,"z":3},"mainStar":"G (White-Yellow) Star"}',
    '{"id64":2,"name":"","coords":{"x":1,"y":2,"z":3}}',
    '{"id64":3,"name":"No Coords"}',
    '{"name":"No Id","coords":{"x":1,"y":2,"z":3}}',
    '{"id64":4,"name":"NaN Coord","coords":{"x":"1","y":2,"z":3}}',
  ].join('\n')}\n]\n`;
  const table = fakeTable();
  const result = await runGalaxyImport({
    writer: memoryWriter(table, 10),
    fetchImpl: async () => dumpResponse(gzipSync(Buffer.from(text))),
  });
  assert.equal(result.processed, 1);
  assert.equal(result.invalid, 4);
  assert.equal(table.count(), 1);
});

test('an abort signal stops the run', async () => {
  const controller = new AbortController();
  const table = fakeTable();
  const buffer = gzDump(makeRecords(50));
  // Half a gzip stream and then silence: only the abort can end this run.
  const source = new Readable({ read() {} });
  source.push(buffer.subarray(0, Math.floor(buffer.length / 2)));
  controller.signal.addEventListener('abort', () => source.destroy(new Error('aborted by operator')));

  const run = runGalaxyImport({
    writer: memoryWriter(table, 10),
    signal: controller.signal,
    fetchImpl: async () => new Response(Readable.toWeb(source), { status: 200 }),
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(() => run, /abort/i);
  assert.ok(controller.signal.aborted);
});

// ─────────────────────── PostgREST writer / point cloud ───────────────────────

test('supabase writer batches upserts and reports failures', async () => {
  const table = fakeTable();
  const { client, calls } = fakeSupabase(table);
  const writer = createSupabaseWriter(client, { batchSize: 3 });
  const rows = rowsOf(makeRecords(10));

  for (const row of rows) await writer.add(row);
  assert.deepEqual(calls.upserts.map((call) => call.size), [3, 3, 3], 'full batches go out immediately');
  assert.equal(writer.written, 9);
  assert.equal(await writer.flush(), 1, 'the tail is flushed on demand');
  assert.equal(writer.written, 10);
  assert.equal(await writer.countRows(), 10);
  assert.ok(calls.upserts.every((call) => call.options.onConflict === 'name_lc'));

  const failing = fakeSupabase(fakeTable(), { failUpsert: 'duplicate key value' });
  const badWriter = createSupabaseWriter(failing.client, { batchSize: 1 });
  await assert.rejects(() => badWriter.add(rows[0]), /supabase upsert failed: duplicate key value/);
});

test('supabase writer collapses duplicate names instead of failing the admin import', async () => {
  const records = makeRecords(5);
  records.push({
    ...records[0],
    id64Raw: records[0].id64Raw,
    name: `  ${records[0].name.toUpperCase()}  `,
    updateTime: '2026-09-21T00:00:00Z',
    coords: { ...records[0].coords, x: 1234 },
  });
  const table = fakeTable();
  const { client, calls } = fakeSupabase(table, { rejectDuplicateConflictKeys: true });
  const result = await runGalaxyImport({
    writer: createSupabaseWriter(client, { batchSize: 10 }),
    fetchImpl: async () => dumpResponse(gzDump(records)),
  });

  assert.equal(result.processed, records.length);
  assert.equal(result.systemsCount, 5, 'the repeated name is one row, not a failed upsert');
  assert.equal(result.written, 5);
  assert.equal(calls.upserts.length, 1, 'duplicates are collapsed before the request, not retried');
  assert.equal(calls.upserts[0].size, 5);
  assert.equal(table.rows.get('synthetic system 0').x, 1234, 'the newer dump snapshot wins');
  assert.equal(result.points.rebuiltFromTable, true, 'the streamed cloud counted the duplicate');
  assert.equal(result.points.count, 5);
});

test('supabase writer splits a batch that PostgREST still rejects as affecting a row twice', async () => {
  const table = fakeTable();
  let rejected = 0;
  const client = {
    from(name) {
      assert.equal(name, 'galaxy_systems');
      return {
        async upsert(rows, options) {
          assert.equal(options.onConflict, 'name_lc');
          if (rows.length > 1) {
            rejected += 1;
            return {
              error: {
                code: '21000',
                message: 'ON CONFLICT DO UPDATE command cannot affect row a second time',
              },
              data: null,
            };
          }
          table.upsert(rows);
          return { error: null, data: null };
        },
      };
    },
  };
  const writer = createSupabaseWriter(client, { batchSize: 4 });
  for (const row of rowsOf(makeRecords(4))) await writer.add(row);
  assert.equal(writer.written, 4);
  assert.equal(table.count(), 4);
  assert.ok(rejected > 0, 'the exact admin-panel error is retried, not fatal');
});

test('supabase writer updates a system whose id64 is already stored under another name', async () => {
  const stored = new Map();
  stored.set(1, {
    id: 1,
    id64: '1',
    name: 'Old Name',
    name_lc: 'old name',
    x: 0,
    y: 0,
    z: 0,
    main_star: null,
    star_type: 'g',
    star_giant_class: 'dwarf',
    needs_permit: null,
    distance_from_sols: 0,
    distance_from_sgra: 1,
    updated_at: '2020-01-01T00:00:00Z',
  });
  const client = {
    from() {
      return {
        async upsert(rows) {
          for (const row of rows) {
            for (const existing of stored.values()) {
              if (existing.id64 === row.id64 && existing.name_lc !== row.name_lc) {
                return {
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "uq_galaxy_systems_id64"',
                  },
                  data: null,
                };
              }
            }
          }
          for (const row of rows) stored.set(stored.size + 1, { id: stored.size + 1, ...row });
          return { error: null, data: null };
        },
        select() {
          return {
            eq(column, value) {
              return {
                async maybeSingle() {
                  const found = [...stored.values()].find((row) => row[column] === value) ?? null;
                  return { data: found, error: null };
                },
              };
            },
          };
        },
        update(patch) {
          return {
            async eq(column, value) {
              const found = [...stored.values()].find((row) => row[column] === value);
              if (!found) return { error: { message: 'missing row' }, data: null };
              Object.assign(found, patch);
              return { error: null, data: null };
            },
          };
        },
        delete() {
          return {
            async eq(column, value) {
              for (const [id, row] of stored) {
                if (row[column] === value) stored.delete(id);
              }
              return { error: null, data: null };
            },
          };
        },
      };
    },
  };

  const writer = createSupabaseWriter(client, { batchSize: 1 });
  const row = rowsOf(makeRecords(1))[0];
  row.id64 = '1';
  row.name = 'New Name';
  row.name_lc = 'new name';
  await writer.add(row);

  assert.equal(stored.size, 1);
  const kept = [...stored.values()][0];
  assert.equal(kept.name_lc, 'new name');
  assert.equal(kept.id64, '1');
  assert.equal(kept.name, 'New Name');
});

test('readPointsFromSupabase pages past a PostgREST row cap and rejects truncation', async () => {
  const records = makeRecords(120);
  const table = fakeTable();
  table.upsert(rowsOf(records));

  // A cap far below the requested page size: the reader must keep going.
  const capped = fakeSupabase(table, { maxRows: 7 });
  const cloud = await readPointsFromSupabase(capped.client);
  assert.equal(cloud.count, records.length);
  assert.ok(capped.calls.pages.length > 10, 'the table was read in many capped pages');
  const points = parsePointsFile(toArrayBuffer(cloud.buffer));
  assert.equal(points.count, records.length);
  const ids = new Set();
  for (let i = 0; i < points.count; i++) ids.add(id64FromParts(points.id64Hi[i], points.id64Lo[i]));
  assert.equal(ids.size, records.length, 'every id64 is present exactly once');

  // COUNT(*) above what the table can return must not produce a "complete" cloud.
  const lying = fakeSupabase(table, { countBias: 50 });
  await assert.rejects(() => readPointsFromSupabase(lying.client), /truncated/);

  const empty = fakeSupabase(fakeTable());
  await assert.rejects(() => readPointsFromSupabase(empty.client), /empty/);
});

test('the supabase writer reads the point cloud back with keyset paging', async () => {
  const table = fakeTable();
  table.upsert(rowsOf(makeRecords(50)));
  const { client, calls } = fakeSupabase(table);
  const writer = createSupabaseWriter(client);
  const seen = [];
  const count = await writer.readPoints((point) => seen.push(point));
  assert.equal(count, 50);
  assert.equal(seen.length, 50);
  assert.equal(seen[0].starType, 'g');
  assert.equal(seen[2].starType, 'neutron');
  assert.ok(calls.pages.every((size) => size > 0));
  await writer.close();
});

// ─────────────────────── state ───────────────────────

test('import state parsing tolerates junk and computes percent', () => {
  assert.deepEqual(parseImportState(null), EMPTY_IMPORT_STATE);
  assert.deepEqual(parseImportState(undefined), EMPTY_IMPORT_STATE);
  assert.equal(parseImportState({ phase: 'nonsense' }).phase, 'idle');
  assert.equal(parseImportState({ phase: 'running', attempts: '3' }).attempts, 3);
  assert.equal(parseImportState({ points_count: null }).points_count, null);
  assert.equal(parseImportState({ backend: 'oracle' }).backend, null);
  assert.equal(parseImportState({ points_uploaded: 'yes' }).points_uploaded, false);

  assert.equal(importPercent(parseImportState({ bytes_done: 50, bytes_total: 200 })), 25);
  assert.equal(importPercent(parseImportState({ bytes_done: 10, bytes_total: null })), null);
  assert.equal(importPercent(parseImportState({ bytes_done: 900, bytes_total: 100 })), 100);
});

test('formatBytes stays readable for the admin UI', () => {
  assert.equal(formatBytes(0), '0 Б');
  assert.equal(formatBytes(1024), '1.0 КБ');
  assert.equal(formatBytes(36 * 1024 * 1024), '36.0 МБ');
  assert.equal(formatBytes(6 * 1024 ** 3), '6.0 ГБ');
});

test('the map explains an empty catalog instead of throwing a 404', () => {
  const base = {
    ready: false,
    systems_count: 0,
    imported_at: null,
    source: null,
    points: { available: false, uploaded: false, count: null, bytes: null },
    import: { ...EMPTY_IMPORT_STATE },
  };

  const idle = catalogNote(base);
  assert.match(idle.error, /Каталог всех систем пуст/);
  assert.equal(idle.retry, false);

  const running = catalogNote({
    ...base,
    import: { ...EMPTY_IMPORT_STATE, phase: 'running', live: true, percent: 42, bytes_done: 1, bytes_total: 2, written: 10 },
  });
  assert.equal(running.error, '');
  assert.match(running.info, /Импорт каталога: 42/);
  assert.equal(running.retry, true);

  const interrupted = catalogNote({
    ...base,
    import: { ...EMPTY_IMPORT_STATE, phase: 'running', live: false, interrupted: true, written: 5000 },
  });
  assert.match(interrupted.info, /прерван/);
  assert.equal(interrupted.retry, true);

  const failed = catalogNote({
    ...base,
    import: { ...EMPTY_IMPORT_STATE, phase: 'failed', error: 'Download failed: HTTP 503' },
  });
  assert.match(failed.error, /HTTP 503/);
  assert.equal(failed.retry, false);

  const cancelled = catalogNote({
    ...base,
    import: { ...EMPTY_IMPORT_STATE, phase: 'cancelled', written: 700 },
  });
  assert.match(cancelled.info, /остановлен/);

  const ready = catalogNote({
    ...base,
    ready: true,
    systems_count: 1_300_000,
    points: { available: true, uploaded: true, count: 1_300_000, bytes: 36_000_000 },
    import: { ...EMPTY_IMPORT_STATE, phase: 'done' },
  });
  assert.deepEqual(ready, { error: '', info: '', retry: false });

  // Rows exist but the cloud could neither be built nor published.
  const stuck = catalogNote({
    ...base,
    systems_count: 1_300_000,
    import: { ...EMPTY_IMPORT_STATE, phase: 'done' },
  });
  assert.match(stuck.error, /облако точек недоступно/);
});

test('SUPABASE_BATCH_SIZE stays a sane PostgREST payload', () => {
  assert.ok(SUPABASE_BATCH_SIZE >= 100 && SUPABASE_BATCH_SIZE <= 5000);
});

// ─────────────────── scheduled-import decision ───────────────────
// Regression: a persisted `running` record outlives the process, so the naive
// "phase === running → already running" check blocked resume forever after a
// redeploy mid-import.

test('decideScheduledImport skips a live run and a fresh complete catalog', () => {
  const now = Date.parse('2026-09-22T03:00:00.000Z');

  const live = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'running',
    live: true,
    interrupted: false,
    updated_at: new Date(now - 5_000).toISOString(),
    now,
  });
  assert.deepEqual(live, { action: 'skip', reason: 'running' });

  const fresh = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'done',
    finished_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    catalog_complete: true,
    now,
  });
  assert.deepEqual(fresh, { action: 'skip', reason: 'fresh' });
});

test('decideScheduledImport resumes an interrupted run instead of skipping it', () => {
  const now = Date.parse('2026-09-22T03:00:00.000Z');

  // The container restarted 20 minutes ago: progress is stale, offset is known.
  const interrupted = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'running',
    live: false,
    interrupted: true,
    resume_offset: 2_424_832,
    written: 14_000,
    updated_at: new Date(now - 20 * 60 * 1000).toISOString(),
    now,
  });
  assert.deepEqual(interrupted, { action: 'start', reason: 'resume' });

  // Interrupted before anything was flushed: start over, but do not hang.
  const noOffset = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'running',
    live: false,
    interrupted: true,
    updated_at: new Date(now - 20 * 60 * 1000).toISOString(),
    now,
  });
  assert.deepEqual(noOffset, { action: 'start', reason: 'restart' });

  // Another replica is demonstrably still writing progress: leave it alone.
  const elsewhere = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'running',
    live: false,
    interrupted: true,
    resume_offset: 1_000,
    updated_at: new Date(now - 30_000).toISOString(),
    now,
  });
  assert.deepEqual(elsewhere, { action: 'skip', reason: 'running_elsewhere' });
});

test('decideScheduledImport retries failures up to MAX_ATTEMPTS, then reports loudly', () => {
  const now = Date.parse('2026-09-22T03:00:00.000Z');

  const retry = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'failed',
    attempts: MAX_ATTEMPTS - 1,
    error: 'fetch failed',
    resume_offset: 512,
    now,
  });
  assert.deepEqual(retry, { action: 'start', reason: 'resume' });

  const giveUp = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'failed',
    attempts: MAX_ATTEMPTS,
    error: 'fetch failed',
    now,
  });
  assert.equal(giveUp.action, 'fail');
  assert.match(giveUp.reason, /failed 3 times: fetch failed/);
});

test('decideScheduledImport re-imports a stale or incomplete catalog', () => {
  const now = Date.parse('2026-09-22T03:00:00.000Z');

  // Yesterday's dump is older than FRESH_MS.
  const stale = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'done',
    finished_at: new Date(now - FRESH_MS - 60_000).toISOString(),
    catalog_complete: true,
    now,
  });
  assert.deepEqual(stale, { action: 'start', reason: 'start' });

  // A `--limit` test run must not masquerade as a full catalog.
  const partial = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'done',
    finished_at: new Date(now - 60_000).toISOString(),
    catalog_complete: false,
    now,
  });
  assert.deepEqual(partial, { action: 'start', reason: 'start' });

  // Never imported at all.
  const never = decideScheduledImport({ ...EMPTY_IMPORT_STATE, phase: 'idle', now });
  assert.deepEqual(never, { action: 'start', reason: 'start' });

  // A cancelled run keeps its offset for the next attempt.
  const cancelled = decideScheduledImport({
    ...EMPTY_IMPORT_STATE,
    phase: 'cancelled',
    resume_offset: 999,
    now,
  });
  assert.deepEqual(cancelled, { action: 'start', reason: 'resume' });
});
