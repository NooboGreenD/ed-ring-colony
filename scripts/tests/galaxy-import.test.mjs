import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';

import {
  JsonArrayObjects,
  streamObjects,
  toGalaxySystemRow,
} from '../../src/lib/galaxySpanshStream.ts';
import {
  GALAXY_MAX_CONSECUTIVE_DEFERRED,
  SUPABASE_BATCH_SIZE,
  collapseGalaxyBatch,
  createSupabaseWriter,
  downloadDumpFile,
  formatBytes,
  galaxyArchiveDir,
  galaxyArchivePath,
  galaxyImportFile,
  isGalaxyStatementTimeout,
  parseContentRangeTotal,
  pgDeleteConflictsSql,
  pgInsertSql,
  pgLiteral,
  readPointsFromSupabase,
  runGalaxyImport,
  verifyGzipFile,
  writeGalaxyRowsPg,
  writeGalaxyRowsSupabase,
} from '../../src/lib/galaxyImport.ts';
import {
  EMPTY_ARCHIVE_STATE,
  EMPTY_IMPORT_STATE,
  archiveIsFresh,
  archivePercent,
  importPercent,
  parseArchiveState,
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
    deferred: 0,
    async add(row) {
      batch.push(row);
      if (batch.length >= batchSize) await flush();
    },
    flush,
    async retryDeferred() {},
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

test('statement timeouts are detected by SQLSTATE and by message', () => {
  assert.equal(isGalaxyStatementTimeout({ code: '57014', message: 'canceling statement due to statement timeout' }), true);
  assert.equal(isGalaxyStatementTimeout({ message: 'canceling statement due to statement timeout' }), true);
  assert.equal(isGalaxyStatementTimeout({ message: 'statement timeout' }), true);
  assert.equal(isGalaxyStatementTimeout({ code: '23505', message: 'duplicate key value violates unique constraint \"x\"' }), false);
  assert.equal(isGalaxyStatementTimeout({ code: '21000', message: 'cannot affect row a second time' }), false);
  assert.equal(isGalaxyStatementTimeout(null), false);
  assert.equal(isGalaxyStatementTimeout(new Error('fetch failed')), false);
});

test('supabase writer halves a batch the database cancels on statement_timeout', async () => {
  const table = fakeTable();
  let timedOut = 0;
  const client = {
    from(name) {
      assert.equal(name, 'galaxy_systems');
      return {
        async upsert(rows, options) {
          assert.equal(options.onConflict, 'name_lc');
          if (rows.length > 1) {
            timedOut += 1;
            return {
              error: { code: '57014', message: 'canceling statement due to statement timeout' },
              data: null,
            };
          }
          table.upsert(rows);
          return { error: null, data: null };
        },
      };
    },
  };
  // A no-op sleep keeps the test fast; the multi-row path splits without backoff anyway.
  const writer = createSupabaseWriter(client, { batchSize: 4, sleep: async () => {} });
  for (const row of rowsOf(makeRecords(4))) await writer.add(row);
  assert.equal(writer.written, 4);
  assert.equal(table.count(), 4);
  assert.ok(timedOut > 0, 'timed-out batches are retried in halves, not fatal');
});

test('supabase writer retries a lone timed-out row with backoff, then fails loudly', async () => {
  const table = fakeTable();
  let attempts = 0;
  const sleeps = [];
  const flaky = {
    from() {
      return {
        async upsert(rows) {
          attempts += 1;
          if (attempts <= 2) {
            return { error: { code: '57014', message: 'canceling statement due to statement timeout' }, data: null };
          }
          table.upsert(rows);
          return { error: null, data: null };
        },
      };
    },
  };
  const written = await writeGalaxyRowsSupabase(flaky, rowsOf(makeRecords(1)), {
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(written, 1);
  assert.equal(table.count(), 1);
  assert.deepEqual(sleeps, [1000, 2000], 'backoff grows between retries');

  attempts = 0;
  const stubborn = {
    from() {
      return {
        async upsert() {
          attempts += 1;
          // No code: the PostgREST error shape only guarantees the message.
          return { error: { message: 'canceling statement due to statement timeout' }, data: null };
        },
      };
    },
  };
  await assert.rejects(
    () => writeGalaxyRowsSupabase(stubborn, rowsOf(makeRecords(1)), { timeoutRetries: 2, sleep: async () => {} }),
    /supabase upsert failed: canceling statement due to statement timeout/,
  );
  assert.equal(attempts, 3, 'one try plus the configured retries');
});

test('supabase writer defers a lone timed-out row instead of failing its neighbours', async () => {
  const table = fakeTable();
  const rows = rowsOf(makeRecords(4));
  const badName = rows[1].name_lc;
  let acceptBad = false;
  let attemptsOnBad = 0;
  const client = {
    from() {
      return {
        async upsert(batch) {
          if (!acceptBad && batch.some((row) => row.name_lc === badName)) {
            attemptsOnBad += 1;
            return { error: { code: '57014', message: 'canceling statement due to statement timeout' }, data: null };
          }
          table.upsert(batch);
          return { error: null, data: null };
        },
      };
    },
  };
  const writer = createSupabaseWriter(client, { batchSize: 1, sleep: async () => {} });
  for (const row of rows) await writer.add(row);
  assert.equal(writer.written, 3, 'the neighbours of a deferred row are written anyway');
  assert.equal(writer.deferred, 1);
  assert.equal(table.count(), 3);
  assert.equal(attemptsOnBad, 4, 'one try plus three backoff retries before the row is deferred');

  // The database recovers: the end-of-pass sweep writes the held row.
  acceptBad = true;
  await writer.retryDeferred();
  assert.equal(writer.written, 4);
  assert.equal(writer.deferred, 0);
  assert.equal(table.count(), 4);
});

test('retryDeferred fails loudly while a row remains unwritten', async () => {
  const table = fakeTable();
  const rows = rowsOf(makeRecords(2));
  const badName = rows[1].name_lc;
  const client = {
    from() {
      return {
        async upsert(batch) {
          if (batch.some((row) => row.name_lc === badName)) {
            return { error: { message: 'canceling statement due to statement timeout' }, data: null };
          }
          table.upsert(batch);
          return { error: null, data: null };
        },
      };
    },
  };
  const writer = createSupabaseWriter(client, { batchSize: 1, sleep: async () => {} });
  await writer.add(rows[0]);
  await writer.add(rows[1]);
  assert.equal(writer.written, 1);
  assert.equal(writer.deferred, 1);

  await assert.rejects(
    () => writer.retryDeferred(),
    (error) => {
      assert.match(error.message, /^supabase upsert failed: canceling statement due to statement timeout/);
      assert.ok(
        error.message.includes(`(${rows[1].name_lc} / ${rows[1].id64})`),
        `the failure names the stuck row: ${error.message}`,
      );
      return true;
    },
  );
  assert.equal(writer.deferred, 1, 'the stuck row stays deferred');
  assert.equal(writer.written, 1, 'the written neighbour is not lost');
});

/** In-memory `galaxy_systems` plus an id64-conflict upsert, like the reconcile fixture below. */
function reconcileClient(stored, state) {
  return {
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
              if (state.updateFailures > 0) {
                state.updateFailures -= 1;
                return { error: { code: '57014', message: 'canceling statement due to statement timeout' }, data: null };
              }
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
}

function reconcileFixture() {
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
  const row = rowsOf(makeRecords(1))[0];
  row.id64 = '1';
  row.name = 'New Name';
  row.name_lc = 'new name';
  return { stored, row };
}

test('conflict reconcile retries a statement timeout instead of failing the import', async () => {
  const { stored, row } = reconcileFixture();
  const state = { updateFailures: 1 };
  const sleeps = [];
  const writer = createSupabaseWriter(reconcileClient(stored, state), {
    batchSize: 1,
    sleep: async (ms) => sleeps.push(ms),
  });
  await writer.add(row);
  assert.equal(writer.deferred, 0, 'the retry lands and nothing is deferred');
  assert.deepEqual(sleeps, [1000], 'the whole reconcile is retried once with backoff');
  assert.equal(stored.size, 1);
  const kept = [...stored.values()][0];
  assert.equal(kept.name_lc, 'new name');
  assert.equal(kept.name, 'New Name');
});

test('a reconcile that keeps timing out is deferred like a lone timed-out row', async () => {
  const { stored, row } = reconcileFixture();
  const state = { updateFailures: Infinity };
  const sleeps = [];
  const writer = createSupabaseWriter(reconcileClient(stored, state), {
    batchSize: 1,
    timeoutRetries: 1,
    sleep: async (ms) => sleeps.push(ms),
  });
  await writer.add(row);
  assert.equal(writer.deferred, 1, 'the row is held aside, not fatal');
  assert.equal(writer.written, 0);
  assert.deepEqual(sleeps, [1000], 'one retry before deferring');

  state.updateFailures = 0;
  await writer.retryDeferred();
  assert.equal(writer.deferred, 0);
  assert.equal(writer.written, 1);
  assert.equal([...stored.values()][0].name_lc, 'new name');
});

test('writeGalaxyRowsPg defers a lone row the server keeps cancelling', async () => {
  const rows = rowsOf(makeRecords(2));
  const state = { deferred: [], consecutiveDeferrals: 0 };
  const written = await writeGalaxyRowsPg(
    async (sql) => {
      if (sql.startsWith('INSERT') && sql.includes(rows[1].id64)) {
        const error = new Error('canceling statement due to statement timeout');
        error.code = '57014';
        throw error;
      }
    },
    rows,
    { deferredState: state, sleep: async () => {} },
  );
  assert.equal(written, 1, 'the accepted neighbour is counted as written');
  assert.equal(state.deferred.length, 1);
  assert.equal(state.deferred[0].row.id64, rows[1].id64);
});

test('a database that accepts nothing fails fast instead of deferring the whole dump', async () => {
  const rows = rowsOf(makeRecords(40));
  const client = {
    from() {
      return {
        async upsert() {
          return { error: { code: '57014', message: 'canceling statement due to statement timeout' }, data: null };
        },
      };
    },
  };
  const writer = createSupabaseWriter(client, { batchSize: 1, timeoutRetries: 0, sleep: async () => {} });
  let failed = null;
  for (const row of rows) {
    try {
      await writer.add(row);
    } catch (error) {
      failed = error;
      break;
    }
  }
  assert.ok(failed, 'the run fails instead of crawling through the dump');
  assert.match(failed.message, /canceling statement due to statement timeout/);
  assert.equal(writer.deferred, GALAXY_MAX_CONSECUTIVE_DEFERRED, 'exactly the consecutive-deferral budget is kept');
});

test('runGalaxyImport holds the restart point before deferred rows and surfaces the timeout', async () => {
  const records = makeRecords(2500);
  const rows = rowsOf(records);
  const badName = rows[1249].name_lc;
  const table = fakeTable();
  let acceptBad = false;
  const client = {
    from() {
      return {
        async upsert(batch) {
          if (!acceptBad && batch.some((row) => row.name_lc === badName)) {
            return { error: { code: '57014', message: 'canceling statement due to statement timeout' }, data: null };
          }
          table.upsert(batch);
          return { error: null, data: null };
        },
      };
    },
  };
  const writer = createSupabaseWriter(client, { batchSize: 250, sleep: async () => {} });
  const snapshots = [];
  let clock = Date.parse('2026-09-22T00:00:00Z');
  const run = runGalaxyImport({
    writer,
    fetchImpl: async () => dumpResponse(gzDump(records)),
    now: () => (clock += 50),
    progressIntervalMs: 1,
    buildPoints: false,
    onProgress: (snapshot) => {
      snapshots.push(snapshot);
    },
  });

  await assert.rejects(
    () => run,
    (error) => {
      assert.match(error.message, /^supabase upsert failed: canceling statement due to statement timeout/);
      assert.ok(
        error.message.includes(`(${rows[1249].name_lc} / ${rows[1249].id64})`),
        `the failure names the stuck row: ${error.message}`,
      );
      return true;
    },
  );
  assert.equal(writer.written, 2499, 'every neighbour of the stuck row is written');
  assert.equal(writer.deferred, 1);

  const clean = Math.max(...snapshots.filter((s) => s.processed < 1250).map((s) => s.resumeOffset));
  const frozen = Math.max(...snapshots.filter((s) => s.processed >= 1250).map((s) => s.resumeOffset));
  assert.ok(clean > 0, 'the restart point actually advanced on clean flushes');
  assert.ok(frozen <= clean, 'the restart point never passes a deferred row');

  acceptBad = true;
  await writer.retryDeferred();
  assert.equal(writer.written, 2500);
  assert.equal(table.count(), 2500);
});

test('writeGalaxyRowsPg halves a batch cancelled by statement_timeout', async () => {
  const statements = [];
  await writeGalaxyRowsPg(async (sql) => {
    statements.push(sql);
    if (sql.startsWith('INSERT') && sql.includes('),(')) {
      const error = new Error('canceling statement due to statement timeout');
      error.code = '57014';
      throw error;
    }
  }, rowsOf(makeRecords(4)));
  const inserts = statements.filter((sql) => sql.startsWith('INSERT'));
  assert.ok(inserts.some((sql) => sql.includes('),(')), 'the full batch is attempted first');
  assert.ok(inserts.some((sql) => !sql.includes('),(')), 'a timed-out batch is retried row by row');
  assert.equal(statements.includes('BEGIN'), false, 'a timeout is not \"fixed\" by deleting the batch');
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

// ─────────────────── on-disk archive: download with resume ───────────────────
//
// Regression for the "terminated" import: a dropped connection used to kill
// the whole job and force a 6 GiB re-download. The download is now resumable
// (HTTP Range) and retries interrupted connections.

function tmpArchiveDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spansh-archive-'));
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/systems.json.gz` });
    });
  });
}

async function stopServer({ server }) {
  await new Promise((resolve) => server.close(resolve));
}

/**
 * A Range-aware dump server. `dropFirst` simulates middleboxes killing the
 * connection mid-body (undici reports those as `terminated`), `ignoreRange`
 * simulates a host that does not support partial responses.
 */
function dumpRangeHandler(buffer, { dropFirst = 0, ignoreRange = false } = {}) {
  let dropsLeft = dropFirst;
  const state = { requests: 0, ranges: [] };
  return {
    state,
    handler(req, res) {
      state.requests++;
      state.ranges.push(req.headers.range ?? null);
      if (dropsLeft > 0) {
        dropsLeft--;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length });
        res.write(buffer.subarray(0, Math.min(4096, buffer.length)));
        req.socket.destroy();
        return;
      }
      if (ignoreRange) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length });
        res.end(buffer);
        return;
      }
      const match = /bytes=(\d+)-?/.exec(req.headers.range ?? '');
      const start = match ? Number(match[1]) : 0;
      if (start >= buffer.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${buffer.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${buffer.length - 1}/${buffer.length}`,
        'Content-Length': buffer.length - start,
      });
      res.end(buffer.subarray(start));
    },
  };
}

test('parseContentRangeTotal reads the total from Content-Range', () => {
  assert.equal(parseContentRangeTotal('bytes 100-200/300'), 300);
  assert.equal(parseContentRangeTotal('bytes */6208543744'), 6208543744);
  assert.equal(parseContentRangeTotal('bytes 0-0/1'), 1);
  assert.equal(parseContentRangeTotal(null), null);
  assert.equal(parseContentRangeTotal('bytes 0-0'), null);
  assert.equal(parseContentRangeTotal('garbage'), null);
});

test('verifyGzipFile accepts a valid archive and rejects truncated ones', async () => {
  const dir = tmpArchiveDir();
  const good = path.join(dir, 'good.json.gz');
  const bad = path.join(dir, 'bad.json.gz');
  const complete = gzipSync(Buffer.from('payload payload payload'));
  fs.writeFileSync(good, complete);
  fs.writeFileSync(bad, complete.subarray(0, Math.floor(complete.length / 2)));
  fs.writeFileSync(path.join(dir, 'empty.json.gz'), Buffer.alloc(0));

  await verifyGzipFile(good);
  await assert.rejects(() => verifyGzipFile(bad), /unexpected end|incorrect|error/i);
  await assert.rejects(() => verifyGzipFile(path.join(dir, 'empty.json.gz')), /unexpected end/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloadDumpFile downloads a dump to disk', async () => {
  const dir = tmpArchiveDir();
  const buffer = gzDump(makeRecords(2000));
  const { state, handler } = dumpRangeHandler(buffer);
  const { server, url } = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  const progress = [];
  try {
    const result = await downloadDumpFile({
      url,
      dest,
      sleep: async () => {},
      onProgress: (info) => progress.push({ ...info }),
    });
    assert.equal(result.bytes, buffer.length);
    assert.equal(result.total, buffer.length);
    assert.deepEqual(fs.readFileSync(dest), buffer, 'file on disk is the dump');
    assert.equal(state.requests, 1);
    assert.equal(state.ranges[0], null, 'a fresh download sends no Range');
    assert.ok(progress.length >= 1, 'progress is reported');
    assert.equal(progress.at(-1).received, buffer.length);
  } finally {
    await stopServer({ server });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadDumpFile resumes an interrupted connection from the stored bytes', async () => {
  const dir = tmpArchiveDir();
  const buffer = gzDump(makeRecords(3000));
  assert.ok(buffer.length > 16384, 'the drop simulators need a multi-chunk body');
  const { state, handler } = dumpRangeHandler(buffer, { dropFirst: 2 });
  const { server, url } = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  // A partial file from an earlier pass: every attempt must continue it.
  fs.writeFileSync(dest, buffer.subarray(0, 8192));
  const logs = [];
  try {
    const result = await downloadDumpFile({
      url,
      dest,
      retries: 5,
      sleep: async () => {},
      log: (line) => logs.push(line),
    });
    assert.equal(result.bytes, buffer.length);
    assert.deepEqual(fs.readFileSync(dest), buffer, 'the reassembled file is complete');
    assert.ok(state.requests >= 3, `expected at least 3 attempts, got ${state.requests}`);
    assert.ok(state.ranges.every((range) => range !== null), 'every attempt continues with Range');
    assert.ok(logs.some((line) => /продолжаю/i.test(line)), 'the resume is logged');
  } finally {
    await stopServer({ server });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadDumpFile restarts when the server ignores Range', async () => {
  const dir = tmpArchiveDir();
  const buffer = gzDump(makeRecords(1500));
  const { state, handler } = dumpRangeHandler(buffer, { ignoreRange: true });
  const { server, url } = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(dest, buffer.subarray(0, 1234), { flag: 'w' });
  try {
    const result = await downloadDumpFile({ url, dest, sleep: async () => {} });
    assert.equal(result.bytes, buffer.length);
    assert.deepEqual(fs.readFileSync(dest), buffer, 'the stale partial was replaced');
    assert.equal(state.requests, 1);
  } finally {
    await stopServer({ server });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadDumpFile accepts a 416 as "already complete"', async () => {
  const dir = tmpArchiveDir();
  const buffer = gzDump(makeRecords(800));
  const { state, handler } = dumpRangeHandler(buffer);
  const { server, url } = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(dest, buffer);
  try {
    const result = await downloadDumpFile({ url, dest, sleep: async () => {} });
    assert.equal(result.bytes, buffer.length);
    assert.equal(result.total, buffer.length);
    assert.equal(state.requests, 1);
  } finally {
    await stopServer({ server });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadDumpFile deletes a corrupted partial and re-downloads', async () => {
  const dir = tmpArchiveDir();
  const buffer = gzDump(makeRecords(2500));
  const cut = Math.floor(buffer.length * 0.5);
  const partial = Buffer.from(buffer.subarray(0, cut));
  partial[Math.floor(cut / 2)] ^= 0xff; // corrupt the middle of the prefix
  const { state, handler } = dumpRangeHandler(buffer);
  const { server, url } = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(dest, partial);
  try {
    const result = await downloadDumpFile({ url, dest, sleep: async () => {} });
    assert.equal(result.bytes, buffer.length);
    assert.deepEqual(fs.readFileSync(dest), buffer, 'the intact dump is back on disk');
    assert.equal(state.requests, 2, 'attempt one appended, failed the check and was re-downloaded');
  } finally {
    await stopServer({ server });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadDumpFile keeps the partial and reports a dead network', async () => {
  const dir = tmpArchiveDir();
  const dest = path.join(dir, 'systems.json.gz');
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    const error = new TypeError('fetch failed');
    error.cause = new Error('terminated');
    throw error;
  };
  try {
    await assert.rejects(
      () =>
        downloadDumpFile({
          url: 'http://127.0.0.1:1/systems.json.gz',
          dest,
          fetchImpl,
          retries: Infinity,
          maxStagnantFailures: 3,
          sleep: async () => {},
        }),
      /оборв|не удалось/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fetches, 4, 'first try plus the stagnant budget');
});

test('downloadDumpFile does not retry a 404', async () => {
  const dir = tmpArchiveDir();
  const dest = path.join(dir, 'systems.json.gz');
  let fetches = 0;
  try {
    await assert.rejects(
      () =>
        downloadDumpFile({
          url: 'http://127.0.0.1:1/systems.json.gz',
          dest,
          fetchImpl: async () => {
            fetches++;
            return new Response('nope', { status: 404 });
          },
          sleep: async () => {},
        }),
      /HTTP 404/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fetches, 1);
});

test('downloadDumpFile stops on abort and keeps the partial file', async () => {
  const dir = tmpArchiveDir();
  const dest = path.join(dir, 'systems.json.gz');
  const controller = new AbortController();
  const chunk = new Uint8Array(1024).fill(7);
  const fetchImpl = async (_url, { signal }) => {
    const stream = new ReadableStream({
      start(streamController) {
        const timer = setInterval(() => streamController.enqueue(chunk), 5);
        signal.addEventListener(
          'abort',
          () => {
            clearInterval(timer);
            streamController.error(new Error('aborted'));
          },
          { once: true },
        );
      },
    });
    return new Response(stream, { status: 200 });
  };
  setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(
      () =>
        downloadDumpFile({
          url: 'http://unused/systems.json.gz',
          dest,
          fetchImpl,
          signal: controller.signal,
          sleep: async () => {},
        }),
      /aborted/i,
    );
    assert.ok(fs.existsSync(dest) && fs.statSync(dest).size > 0, 'the partial stays for a resume');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────── import from a local file ───────────────────

test('runGalaxyImport imports from a local file without touching the network', async () => {
  const records = makeRecords(900);
  const dir = tmpArchiveDir();
  const file = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(file, gzDump(records));
  const table = fakeTable();
  try {
    const result = await runGalaxyImport({
      writer: memoryWriter(table, 100),
      file,
      fetchImpl: async () => {
        throw new Error('the network must not be touched');
      },
    });
    assert.equal(result.processed, records.length);
    assert.equal(result.invalid, 0);
    assert.equal(result.systemsCount, records.length);
    assert.equal(table.count(), records.length);
    assert.equal(result.bytesDone, fs.statSync(file).size, 'bytes counted from the file');
    assert.equal(result.bytesTotal, fs.statSync(file).size, 'the file size is the total');
    assert.equal(result.points.count, records.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGalaxyImport fails clearly when the local file is missing or empty', async () => {
  const dir = tmpArchiveDir();
  const missing = path.join(dir, 'absent.json.gz');
  const empty = path.join(dir, 'empty.json.gz');
  fs.writeFileSync(empty, Buffer.alloc(0));
  const table = fakeTable();
  try {
    await assert.rejects(
      () => runGalaxyImport({ writer: memoryWriter(table), file: missing }),
      /not found/i,
    );
    await assert.rejects(
      () => runGalaxyImport({ writer: memoryWriter(table), file: empty }),
      /empty/i,
    );
    assert.equal(table.count(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a resumed pass from a local file skips the stored records', async () => {
  const records = makeRecords(1200);
  const dir = tmpArchiveDir();
  const file = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(file, gzDump(records));

  // The restart point is the offset a record completes at, as a run stores it.
  let cutOffset = 0;
  let count = 0;
  for await (const object of streamObjects(fs.createReadStream(file).pipe(createGunzip()))) {
    if (count === 600) cutOffset = object.__streamOffset;
    count++;
  }
  assert.ok(cutOffset > 0);

  const table = fakeTable();
  // Seed half of the catalog, as the first (aborted) pass would have.
  table.upsert(rowsOf(records.slice(0, 600)));

  try {
    const resumed = await runGalaxyImport({
      writer: memoryWriter(table, 100),
      file,
      resumeFrom: cutOffset,
    });
    assert.ok(resumed.skipped > 0, 'records before the restart point are skipped');
    assert.equal(table.count(), records.length, 'the catalog is complete');
    assert.equal(resumed.resumedFrom, cutOffset);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────── archive helpers and state ───────────────────

test('archive path helpers honour the env overrides', () => {
  assert.equal(galaxyArchiveDir({}), 'data/spansh');
  assert.equal(galaxyArchiveDir({ GALAXY_ARCHIVE_DIR: '  /custom/dir  ' }), '/custom/dir');
  assert.equal(galaxyArchivePath({}), 'data/spansh/systems.json.gz');
  assert.equal(galaxyArchivePath({ GALAXY_ARCHIVE_DIR: '/custom' }), path.join('/custom', 'systems.json.gz'));
  assert.equal(galaxyImportFile({}), null);
  assert.equal(galaxyImportFile({ GALAXY_IMPORT_FILE: '  ' }), null);
  assert.equal(galaxyImportFile({ GALAXY_IMPORT_FILE: '/srv/dump.json.gz' }), '/srv/dump.json.gz');
});

test('archiveIsFresh uses mtime and requires non-empty files', () => {
  const dir = tmpArchiveDir();
  const file = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(file, Buffer.from([1, 2, 3]));
  const now = Date.now();
  try {
    assert.equal(archiveIsFresh(file, now), true);
    const stale = new Date(now - 21 * 3600 * 1000);
    fs.utimesSync(file, stale, stale);
    assert.equal(archiveIsFresh(file, now), false, 'older than the 20 h window');
    assert.equal(archiveIsFresh(file, now, 48 * 3600 * 1000), true, 'a wider window is honoured');
    fs.rmSync(file);
    assert.equal(archiveIsFresh(file, now), false, 'missing file is not fresh');
    fs.writeFileSync(file, Buffer.alloc(0));
    assert.equal(archiveIsFresh(file, now), false, 'an empty file is not fresh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archive state parsing tolerates junk and computes percent', () => {
  assert.deepEqual(parseArchiveState(null), EMPTY_ARCHIVE_STATE);
  assert.deepEqual(parseArchiveState(undefined), EMPTY_ARCHIVE_STATE);
  assert.equal(parseArchiveState({ phase: 'nonsense' }).phase, 'idle');
  assert.equal(parseArchiveState({ phase: 'downloading', bytes_done: '100' }).bytes_done, 100);
  assert.equal(parseArchiveState({ phase: 'done', downloaded_at: 42 }).downloaded_at, null);

  assert.equal(archivePercent(parseArchiveState({ bytes_done: 50, bytes_total: 200 })), 25);
  assert.equal(archivePercent(parseArchiveState({ bytes_done: 10, bytes_total: null })), null);
  assert.equal(archivePercent(parseArchiveState({ bytes_done: 900, bytes_total: 100 })), 100);
});

// ─────────────────── end to end: download (with a drop) → import from disk ───────────────────

test('two-phase flow: a dropped download is resumed, then the import runs from disk', async () => {
  const records = makeRecords(2000);
  const buffer = gzDump(records);
  assert.ok(buffer.length > 16384);
  const dir = tmpArchiveDir();
  const dest = path.join(dir, 'systems.json.gz');
  const { state, handler } = dumpRangeHandler(buffer, { dropFirst: 1 });
  const { server, url } = await startServer(handler);
  const table = fakeTable();
  try {
    // Phase 1: the download survives one dropped connection.
    await downloadDumpFile({ url, dest, retries: 5, sleep: async () => {} });
    assert.equal(state.requests, 2, 'one drop, one successful retry');
    assert.deepEqual(fs.readFileSync(dest), buffer);

    // Phase 2: the import reads the file; the network is out of reach entirely.
    const offlineFetch = async () => {
      throw new Error('offline');
    };
    const result = await runGalaxyImport({
      writer: memoryWriter(table, 200),
      file: dest,
      fetchImpl: offlineFetch,
    });
    assert.equal(result.processed, records.length);
    assert.equal(result.systemsCount, records.length);
    assert.equal(table.count(), records.length);
    assert.equal(result.bytesTotal, buffer.length);
  } finally {
    await stopServer({ server });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
