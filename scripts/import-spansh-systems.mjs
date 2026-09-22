#!/usr/bin/env node
/**
 * Spansh galaxy dump → PostgreSQL (project Supabase) → points file for the
 * experimental "all systems" galaxy-map layer.
 *
 * Source: https://spansh.co.uk/dumps → systems.json.gz
 * ("Just system details (no bodies or stations)", ~6 GiB, one BriefDumpSystem
 * object per line: { id64, name, mainStar, coords{x,y,z}, needsPermit,
 * updateTime } — see spansh/elite_dangerous_schemas, systems.schema.json).
 *
 * Usage (on a machine with internet access to downloads.spansh.co.uk):
 *   npm run spansh:import                        # full import
 *   npm run spansh:import -- --dry-run           # parse only, no DB
 *   node scripts/import-spansh-systems.mjs --selftest          # offline sanity check
 *   node scripts/import-spansh-systems.mjs --file local.json.gz --limit 100000
 *
 * Requires Node >= 22.18 (type stripping for the shared TS module).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createRequire } from 'node:module';
import os from 'node:os';

import {
  PointsBuilder,
  parsePointsFile,
  id64FromParts,
  POINTS_STORAGE_BUCKET,
  POINTS_STORAGE_OBJECT,
} from '../src/lib/galaxySystems.ts';
// Parser, row mapping and the upsert SQL live in src/lib so the in-app import
// (/api/cron/galaxy-import — the production image has no scripts/) and this CLI
// cannot drift apart. Re-exported below for scripts/tests/spansh-systems.test.mjs.
import {
  JsonArrayObjects,
  streamObjects,
  toGalaxySystemRow,
} from '../src/lib/galaxySpanshStream.ts';
import { PG_BATCH_SIZE, SUPABASE_BATCH_SIZE, pgLiteral, writeGalaxyRowsPg, writeGalaxyRowsSupabase } from '../src/lib/galaxyImport.ts';

export { streamObjects, toGalaxySystemRow, JsonArrayObjects };

const requireNode = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const DEFAULT_URL = 'https://downloads.spansh.co.uk/systems.json.gz';
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'data', 'spansh');
const DEFAULT_POINTS_FILE = path.join(REPO_ROOT, 'public', 'data', 'galaxy-systems-points.bin');

const USAGE = `Usage: node scripts/import-spansh-systems.mjs [options]

  --url <url>            Download source (default ${DEFAULT_URL})
  --file <path>          Use a local .gz/.json dump instead of downloading
  --out <dir>            Download directory (default data/spansh)
  --points-file <path>   Points file for the map layer (default public/data/galaxy-systems-points.bin)
  --limit <n>            Process at most n systems (testing)
  --batch <n>            DB batch size (default: 2000 pg / 1000 supabase)
  --truncate             Clear galaxy_systems before import (pg mode only)
  --no-points            Skip generating the points file
  --dry-run              Parse only; do not write to the database
  --selftest             Generate a synthetic dump and verify the pipeline (no DB)
  --skip-download        Reuse the previously downloaded file
  --database-url <url>   Postgres connection string (else DATABASE_URL, else Supabase env)
  -v, --verbose          Also print per-10s progress lines`;

// ────────────────────────── CLI ──────────────────────────

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    file: null,
    outDir: DEFAULT_OUT_DIR,
    pointsFile: DEFAULT_POINTS_FILE,
    limit: 0,
    batch: 0,
    truncate: false,
    noPoints: false,
    dryRun: false,
    selftest: false,
    skipDownload: false,
    databaseUrl: null,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--url': args.url = argv[++i]; break;
      case '--file': args.file = argv[++i]; break;
      case '--out': args.outDir = argv[++i]; break;
      case '--points-file': args.pointsFile = argv[++i]; break;
      case '--limit': args.limit = Number(argv[++i]); break;
      case '--batch': args.batch = Number(argv[++i]); break;
      case '--truncate': args.truncate = true; break;
      case '--no-points': args.noPoints = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--selftest': args.selftest = true; break;
      case '--skip-download': args.skipDownload = true; break;
      case '--database-url': args.databaseUrl = argv[++i]; break;
      case '-v': case '--verbose': args.verbose = true; break;
      case '-h': case '--help': console.log(USAGE); process.exit(0); break;
      default:
        console.error(`Unknown option: ${a}\n`);
        console.error(USAGE);
        process.exit(2);
    }
  }
  return args;
}

// ────────────────────── download (resumable) ──────────────────────

async function download(url, dest, log) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let offset = 0;
  if (fs.existsSync(dest)) {
    offset = fs.statSync(dest).size;
    log(`Resuming ${dest} from byte ${offset}`);
  }
  const res = await fetch(url, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} (${url})`);
  }
  if (offset > 0 && res.status === 200) offset = 0; // server ignored Range
  let received = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk, _enc, done) {
      received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 5000) {
        lastReport = now;
        log(`  downloaded ${Math.round(received / 1024 / 1024)} MB…`);
      }
      done(null, chunk);
    },
  });
  const writeStream = fs.createWriteStream(dest, { flags: offset > 0 ? 'a' : 'w' });
  await pipeline(res.body, counter, writeStream);
  log(`Download complete: ${fs.statSync(dest).size.toLocaleString()} bytes`);
}

// ─────────────────────── DB writers ───────────────────────

function loadPg() {
  return requireNode('pg');
}

class PgWriter {
  constructor(pool, batchSize, truncate, log) {
    this.pool = pool;
    this.batchSize = batchSize;
    this.log = log;
    this.rows = [];
    this.written = 0;
    this.truncate = truncate;
  }

  async begin() {
    if (this.truncate) {
      await this.pool.query('TRUNCATE galaxy_systems RESTART IDENTITY');
      this.log('Truncated galaxy_systems');
    }
  }

  async add(row) {
    this.rows.push(row);
    if (this.rows.length >= this.batchSize) await this.flush();
  }

  async flush() {
    if (this.rows.length === 0) return 0;
    const batch = this.rows;
    this.rows = [];
    // One connection for the whole batch: a conflict retry runs BEGIN/DELETE/INSERT/COMMIT.
    const client = await this.pool.connect();
    try {
      const n = await writeGalaxyRowsPg((sql) => client.query(sql), batch);
      this.written += n;
      return n;
    } finally {
      client.release();
    }
  }

  async query(sql) {
    const client = await this.pool.connect();
    try {
      const res = await client.query(sql);
      return { error: null, res };
    } catch (error) {
      return { error, res: null };
    } finally {
      client.release();
    }
  }

  async countRows() {
    const { error, res } = await this.query('SELECT COUNT(*)::bigint AS n FROM galaxy_systems');
    if (error) throw error;
    return Number(res.rows[0].n);
  }

  async writeMeta(value) {
    const json = JSON.stringify(value);
    // Merge so a partial import does not wipe points_uploaded from a full run.
    const sql =
      `INSERT INTO galaxy_systems_meta (key, value, updated_at) VALUES ('stats', ` +
      pgLiteral(json) + `::jsonb, NOW()) ` +
      `ON CONFLICT (key) DO UPDATE SET value = galaxy_systems_meta.value || EXCLUDED.value, updated_at = NOW()`;
    const { error } = await this.query(sql);
    if (error) this.log(`WARNING: could not write galaxy_systems_meta: ${error.message}`);
  }

  async close() {
    await this.pool.end();
  }
}

class SupabaseWriter {
  constructor(supabase, batchSize, log) {
    this.supabase = supabase;
    this.batchSize = batchSize;
    this.log = log;
    this.rows = [];
    this.written = 0;
  }

  async begin() {
    this.log('Note: --truncate is not supported in supabase-js mode (run it via a direct DB session)');
  }

  async add(row) {
    this.rows.push(row);
    if (this.rows.length >= this.batchSize) await this.flush();
  }

  async flush() {
    if (this.rows.length === 0) return 0;
    const batch = this.rows;
    this.rows = [];
    const n = await writeGalaxyRowsSupabase(this.supabase, batch);
    this.written += n;
    return n;
  }

  async countRows() {
    const { count, error } = await this.supabase
      .from('galaxy_systems')
      .select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return count ?? this.written;
  }

  async writeMeta(value) {
    const existing = await this.supabase
      .from('galaxy_systems_meta')
      .select('value')
      .eq('key', 'stats')
      .maybeSingle();
    const merged = { ...(existing.data?.value || {}), ...value };
    const { error } = await this.supabase
      .from('galaxy_systems_meta')
      .upsert({ key: 'stats', value: merged }, { onConflict: 'key' });
    if (error) this.log(`WARNING: could not write galaxy_systems_meta: ${error.message}`);
  }

  async close() {}
}

// ─────────────────────── main import ───────────────────────

function openDumpStream(file) {
  const raw = fs.createReadStream(file);
  if (file.toLowerCase().endsWith('.gz')) return raw.pipe(zlib.createGunzip());
  return raw;
}

async function runImport(args, db, log) {
  const startedAt = Date.now();
  const source = args.file
    ? path.resolve(args.file)
    : path.join(args.outDir, path.basename(new URL(args.url).pathname) || 'systems.json.gz');

  if (!args.file && !args.skipDownload && !fs.existsSync(source)) {
    log(`Downloading ${args.url} → ${source}`);
    await download(args.url, source, log);
  }
  if (!fs.existsSync(source)) throw new Error(`Dump file not found: ${source}`);

  const pointsBuilder = args.noPoints ? null : new PointsBuilder(1_000_000);
  let processed = 0;
  let invalid = 0;
  let lastLog = 0;

  log(`Parsing ${source}`);
  for await (const obj of streamObjects(openDumpStream(source))) {
    if (args.limit > 0 && processed >= args.limit) break;
    const row = toGalaxySystemRow(obj);
    if (!row) { invalid++; continue; }
    processed++;
    if (db) await db.add(row);
    if (pointsBuilder) pointsBuilder.add(row);
    const now = Date.now();
    if (now - lastLog > 10_000) {
      lastLog = now;
      const rate = processed / Math.max(1, (now - startedAt) / 1000);
      log(`  ${processed.toLocaleString()} systems (${rate.toFixed(0)}/s), invalid ${invalid}`);
    }
  }

  if (db) await db.flush();

  let pointsInfo = null;
  let pointsUploaded = false;
  if (pointsBuilder) {
    const buffer = pointsBuilder.build();
    const bytes = Buffer.from(buffer);
    fs.mkdirSync(path.dirname(args.pointsFile), { recursive: true });
    fs.writeFileSync(args.pointsFile, bytes);
    const meta = {
      format: 'edgs-v1',
      count: pointsBuilder.size,
      imported_at: new Date().toISOString(),
      source: args.file ? path.basename(args.file) : args.url,
      bytes: bytes.length,
    };
    fs.writeFileSync(args.pointsFile + '.meta.json', JSON.stringify(meta, null, 2));
    pointsInfo = meta;
    log(`Points file: ${args.pointsFile} (${meta.count.toLocaleString()} systems, ${(meta.bytes / 1024 / 1024).toFixed(1)} MB)`);
    if (args.limit > 0) {
      log('Partial import: not uploading the points file (it would replace the full cloud)');
    } else if (!args.dryRun) {
      pointsUploaded = await uploadPoints(args.pointsFile, log);
    }
  }

  if (db) {
    log(`Inserted/updated ${db.written.toLocaleString()} rows`);
    if (!args.dryRun) {
      let systemsCount = db.written;
      try {
        systemsCount = await db.countRows();
      } catch (error) {
        log(`WARNING: COUNT(*) failed, meta will use the batch counter: ${error.message}`);
      }
      const meta = {
        systems_count: systemsCount,
        invalid_records: invalid,
        partial: args.limit > 0,
        source: args.file ? path.basename(args.file) : args.url,
        imported_at: new Date().toISOString(),
        note: 'Full Spansh systems dump (nightly at https://spansh.co.uk/dumps). Re-run the import to refresh.',
      };
      if (pointsUploaded && pointsInfo) {
        meta.points_uploaded = true;
        meta.points_bytes = pointsInfo.bytes;
        meta.points_count = pointsInfo.count;
      }
      await db.writeMeta(meta);
    }
    await db.close();
  }

  log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)} s: ${processed.toLocaleString()} systems processed, ${invalid} invalid, ${db ? db.written.toLocaleString() : 0} rows written`);
  return { processed, invalid, points: pointsInfo };
}

async function uploadPoints(filePath, log) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    log('Points file kept locally (no Supabase credentials for storage upload)');
    return false;
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.length > 50 * 1024 * 1024) {
    log(`WARNING: points file is ${bytes.length} bytes, over the 50 MB bucket limit — not uploaded`);
    return false;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.storage.from(POINTS_STORAGE_BUCKET).upload(POINTS_STORAGE_OBJECT, bytes, {
    contentType: 'application/octet-stream',
    upsert: true,
  });
  if (error) {
    log(`WARNING: points upload failed: ${error.message}`);
    return false;
  }
  log(`Points file uploaded to storage ${POINTS_STORAGE_BUCKET}/${POINTS_STORAGE_OBJECT}`);
  return true;
}

async function resolveDb(args, log) {
  if (args.dryRun) { log('Dry run: skipping database'); return null; }
  const mask = (url) => url.replace(/:([^:@/]+)@/, ':***@');
  const databaseUrl = args.databaseUrl || process.env.DATABASE_URL;
  if (databaseUrl) {
    const pg = loadPg();
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      await pool.end();
      throw new Error(`Cannot connect to Postgres (${mask(databaseUrl)}): ${error.message}`);
    }
    client.release();
    log(`DB mode: pg (${mask(databaseUrl)})`);
    const writer = new PgWriter(pool, args.batch || PG_BATCH_SIZE, args.truncate, log);
    await writer.begin();
    return writer;
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && serviceKey) {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    log(`DB mode: supabase (${supabaseUrl})`);
    const writer = new SupabaseWriter(client, args.batch || SUPABASE_BATCH_SIZE, log);
    await writer.begin();
    return writer;
  }
  throw new Error(
    'No database configured. Set DATABASE_URL (preferred, fast direct inserts) ' +
    'or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or use --dry-run.'
  );
}

// ─────────────────────── selftest ───────────────────────

// Cycle covers every BriefDumpSystem mainStar class (incl. planet-ish values
// and null) plus super-giants/giants, so classification gets full coverage.
const SELFTEST_STARS = [
  'O (Blue-White) Star', 'B (Blue-White) Star', 'A (Blue-White) Star',
  'F (White) Star', 'G (White-Yellow) Star', 'K (Yellow-Orange) Star',
  'M (Red dwarf) Star', 'L (Brown dwarf) Star', 'T (Brown dwarf) Star',
  'Neutron Star', 'Black Hole', 'Supermassive Black Hole',
  'White Dwarf (DA) Star', 'White Dwarf (DQ) Star',
  'Wolf-Rayet C Star', 'Wolf-Rayet N Star', 'Wolf-Rayet NC Star', 'Wolf-Rayet O Star', 'Wolf-Rayet Star',
  'Herbig Ae/Be Star', 'T Tauri Star', 'C Star', 'CJ Star', 'CN Star',
  'A (Blue-White super giant) Star', 'M (Red super giant) Star', 'M (Red giant) Star', 'K (Yellow-Orange giant) Star',
  'Ammonia world', 'Earth-like world', null,
  // Appended after index 30 so the count assertions above stay valid.
  'S-type Star', 'MS-type Star',
];

function countMod(n, mod, target) {
  if (n <= target) return 0;
  return Math.floor((n - 1 - target) / mod) + 1;
}

async function selftest(args, log) {
  const n = args.limit > 0 ? args.limit : 5000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spansh-selftest-'));
  const gzFile = path.join(dir, 'systems.json.gz');

  const lines = ['['];
  const id64For = (i) => (i === 0 ? 18446744073709551615n : BigInt(10477373803) + BigInt(i) * 7919n);
  for (let i = 0; i < n; i++) {
    const mainStar = SELFTEST_STARS[i % SELFTEST_STARS.length];
    const angle = (i * 2.399963229728653) % (Math.PI * 2); // golden angle
    const radius = 4000 + ((i * 7919) % 46000);
    const rec = {
      name: i % 3 === 0 ? `Synthetic System ${i} ` : `Synthetic-System-${i}`,
      ...(mainStar ? { mainStar } : {}),
      coords: {
        x: Math.cos(angle) * radius,
        y: ((i % 97) - 48) * 47.25,
        z: Math.sin(angle) * radius,
      },
      needsPermit: i % 5 === 0,
      updateTime: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    };
    // Emit id64 as a raw (possibly >2^53) JSON number, like the real dump.
    lines.push(`{"id64":${id64For(i)},${JSON.stringify(rec)
      .replace(/^\{/, '')}`);
  }
  // Real Sol record.
  lines.push('{"id64":10477373803,"name":"Sol","mainStar":"G (White-Yellow) Star","coords":{"x":0,"y":0,"z":0},"needsPermit":false,"updateTime":"2026-09-20T00:00:00Z"}');
  lines.push(']');
  const json = lines.join('\n');
  fs.writeFileSync(gzFile, zlib.gzipSync(Buffer.from(json)));

  // Minified single-line variant → proves the parser's fallback path.
  const minifiedFile = path.join(dir, 'systems-minified.json');
  fs.writeFileSync(minifiedFile, '[' + lines.slice(1, -1).join(',') + ']');

  let total = 0;
  let solRow = null;
  const counts = {};
  const id64Set = new Set();
  for await (const obj of streamObjects(openDumpStream(gzFile))) {
    total++;
    const row = toGalaxySystemRow(obj);
    if (!row) throw new Error(`Selftest: row ${total} invalid`);
    counts[row.star_type] = (counts[row.star_type] || 0) + 1;
    id64Set.add(row.id64);
    if (row.name === 'Sol') solRow = row;
  }

  let minTotal = 0;
  for await (const _obj of streamObjects(fs.createReadStream(minifiedFile))) minTotal++;

  const builder = new PointsBuilder(1024); // small start → exercises grow()
  for await (const obj of streamObjects(openDumpStream(gzFile))) {
    builder.add(toGalaxySystemRow(obj));
  }
  const parsed = parsePointsFile(builder.build());

  // ── assertions ──
  const mod = SELFTEST_STARS.length;
  const expectCount = (targetIdx) => countMod(n, mod, targetIdx);
  assert.equal(total, n + 1, `parsed total ${total} != ${n + 1}`);
  assert.equal(minTotal, total, `minified parse ${minTotal} != ${total}`);
  assert.ok(solRow, 'Sol row missing');
  assert.equal(solRow.star_type, 'g', 'Sol star class');
  assert.equal(solRow.star_giant_class, 'dwarf', 'Sol giant class');
  assert.equal(solRow.distance_from_sols, 0, 'Sol distance from Sols');
  assert.equal(counts.neutron, expectCount(9), 'neutron count');
  assert.equal(counts.black_hole, expectCount(10) + expectCount(11), 'black hole count');
  assert.equal(counts.white_dwarf, expectCount(12) + expectCount(13), 'white dwarf count');
  assert.equal(counts.wolf_rayet, expectCount(14) + expectCount(15) + expectCount(16) + expectCount(17) + expectCount(18), 'wolf-rayet count');
  assert.equal(counts.carbon, expectCount(21) + expectCount(22) + expectCount(23), 'carbon count');
  assert.equal(counts.unknown, expectCount(28) + expectCount(29) + expectCount(30), 'unknown count (planet-ish/null)');
  assert.equal(counts.s_type, expectCount(31), 's-type count');
  assert.equal(counts.ms_type, expectCount(32), 'ms-type count');
  assert.equal(id64Set.size, n + 1, 'id64 uniqueness');
  // Exact u64 digits survive the pipeline (row 0 has the max uint64 value).
  assert.equal(id64FromParts(parsed.id64Hi[0], parsed.id64Lo[0]), '18446744073709551615', 'id64 hi/lo round-trip (max u64)');
  assert.equal(parsed.count, total, 'points count');
  // Last dump row is Sol → last point must be (0,0,0).
  const solIdx = (total - 1) * 3;
  assert.ok(
    Math.abs(parsed.positions[solIdx]) < 1e-3 &&
    Math.abs(parsed.positions[solIdx + 1]) < 1e-3 &&
    Math.abs(parsed.positions[solIdx + 2]) < 1e-3,
    'Sol position round-trip (last point)'
  );
  // First synthetic point: angle=0, radius=4000 → x≈4000, z≈0.
  assert.ok(Math.abs(parsed.positions[0] - 4000) < 1e-2, 'first point x ≈ 4000');

  log(`Selftest PASS: ${total} systems; star types: ${JSON.stringify(counts)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

function assert(cond, message) {
  if (!cond) throw new Error(`Selftest FAILED: ${message}`);
}
assert.ok = (cond, message) => assert(!!cond, message);
assert.equal = (a, b, message) => assert(a === b, `${message} (${a} !== ${b})`);

// ─────────────────────── entrypoint ───────────────────────

export function runMain(argv) {
  const args = parseArgs(argv);
  const log = (msg) => { if (args.verbose || !msg.startsWith('  ')) console.error(`[spansh-import] ${msg}`); };
  return (async () => {
    if (args.selftest) {
      await selftest(args, log);
      return;
    }
    const db = await resolveDb(args, log);
    await runImport(args, db, log);
  })();
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href;
  } catch {
    return false;
  }
})();

if (isMain) {
  runMain(process.argv).catch((err) => {
    console.error(`[spansh-import] ERROR: ${err.message}`);
    process.exit(1);
  });
}
