/**
 * Живые данные EDDN (web 2.23.0): подписчик ZeroMQ без нативных модулей и
 * слушатель, который отдаёт прыжки пилотов слоям PowerPlay и фракций.
 *
 * Реле — подставной TCP-сервер, говорящий на ZMTP 3.0 как libzmq (EDCD/EDDN
 * src/eddn/Relay.py — обычный PUB): приветствие в два приёма, READY,
 * подписка «0x01», сжатые zlib сообщения, PING. Проверяется:
 *   * отбор: только FSDJump / Location / CarrierJump схемы journal/1 живой
 *     игры; Legacy, тестовые схемы, рынки и битые кадры — мимо, со счётчиками;
 *   * пачка: по последнему наблюдению на систему, длинные кадры (LONG), PONG;
 *   * сторож тишины: замолчавшее реле — новая сессия, в журнале — сколько
 *     данных пришло до замирания (почерк «заморозки» ТСПУ);
 *   * настоящая база: наблюдение EDDN называет владельца системы PowerPlay
 *     (источник eddn, основание journal) и обновляет фракции;
 *   * админка и задача `eddn-listener`: флаг в базе, запуск и остановка,
 *     `EDDN_LISTENER=off`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import { SYSTEM_DATA_MIGRATIONS, SYSTEM_DATA_STUBS, readMigration } from './helpers/systemDataSchema.mjs';

// Архив и куски PowerPlay (web 2.24.0) — во временном каталоге, а не в data/spansh репозитория.
const PP_ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'pp-eddn-archive-'));
process.env.POWERPLAY_ARCHIVE_DIR = PP_ARCHIVE_DIR;
test.after(() => rmSync(PP_ARCHIVE_DIR, { recursive: true, force: true }));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.CRON_SECRET = 'eddn-cron-secret';

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) => new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
  }),
};
`;
const HELPER = join(TEST_ROOT, 'scripts', 'tests', 'helpers', 'pgliteSupabase.mjs').replace(/\\/g, '/');
const SUPABASE_STUB = `
import { pgliteClient } from '${HELPER}';
export const state = { db: null, userId: null, log: [] };
export function createServiceClient() { return pgliteClient(state); }
export async function createClient() { return pgliteClient(state); }
`;
const AUTH_STUB = `
export const authState = { role: 'admin' };
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export async function requireAdmin() {
  if (!authState.role) return { response: json({ error: 'Требуется авторизация' }, 401) };
  if (authState.role !== 'admin') return { response: json({ error: 'Access denied: Administrator required' }, 403) };
  return { actor: { userId: 'admin-1', cmdrName: 'CMDR Admin', email: null, role: 'admin', isPreview: false } };
}
`;
const ENTRY = `
export * as adminRoute from '@/app/api/admin/powerplay/route';
export * as cronRoute from '@/app/api/cron/eddn-listener/route';
export { state, createServiceClient } from '@/lib/supabaseServer';
export { authState } from '@/lib/billing/auth';
export * as zmtp from '@/lib/eddn/zmtp';
export * as eddn from '@/lib/eddn/listener';
`;

const db = new PGlite();
await db.exec(SYSTEM_DATA_STUBS);
for (const file of SYSTEM_DATA_MIGRATIONS) await db.exec(readMigration(TEST_ROOT, file));
const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: { 'next/server': NEXT_SERVER_STUB, '@/lib/supabaseServer': SUPABASE_STUB, '@/lib/billing/auth': AUTH_STUB },
  platform: 'node',
});
const mod = await import(bundle);
mod.state.db = db;
const svc = mod.createServiceClient();
const { zmtpFrame, zmtpCommand, zmtpProperties, parseZmtpProperties } = mod.zmtp;

/* ── Подставное реле EDDN ──────────────────────────────────────────────── */

function readFrames(state) {
  const frames = [];
  for (;;) {
    if (state.buf.length < 2) break;
    const flags = state.buf[0];
    const long = (flags & 0x02) !== 0;
    const head = long ? 9 : 2;
    if (state.buf.length < head) break;
    const size = long ? Number(state.buf.readBigUInt64BE(1)) : state.buf[1];
    if (state.buf.length < head + size) break;
    frames.push({ command: (flags & 0x04) !== 0, more: (flags & 0x01) !== 0, body: state.buf.subarray(head, head + size) });
    state.buf = state.buf.subarray(head + size);
  }
  return frames;
}

/** Реле: как libzmq PUB. `connections` — по сессии; `send(i, buffer)` — сообщение подписчику. */
async function fakeRelay() {
  const connections = [];
  const waiters = [];
  const server = net.createServer((sock) => {
    const conn = { sock, stage: 'greeting', buf: Buffer.alloc(0), socketType: null, subscription: null, pongs: [] };
    connections.push(conn);
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      if (conn.stage === 'greeting') {
        if (conn.buf.length < 64) return;
        const greeting = conn.buf.subarray(0, 64);
        conn.buf = conn.buf.subarray(64);
        assert.equal(greeting[0], 0xff);
        assert.equal(greeting[9], 0x7f);
        assert.equal(greeting[10], 3, 'клиент говорит ZMTP 3');
        assert.equal(greeting.subarray(12, 16).toString('ascii'), 'NULL');
        // libzmq шлёт приветствие в два приёма: сигнатура с версией, затем остальное.
        const own = Buffer.alloc(64, 0);
        own[0] = 0xff; own[9] = 0x7f; own[10] = 3; own[11] = 1; own.write('NULL', 12, 'ascii');
        sock.write(own.subarray(0, 11));
        setTimeout(() => sock.write(own.subarray(11)), 5);
        conn.stage = 'ready';
      }
      for (const frame of readFrames(conn)) {
        if (conn.stage === 'ready') {
          assert.ok(frame.command, 'сначала команда READY');
          const name = frame.body.subarray(1, 1 + frame.body[0]).toString('ascii');
          assert.equal(name, 'READY');
          conn.socketType = parseZmtpProperties(frame.body.subarray(1 + frame.body[0]))['socket-type'];
          sock.write(zmtpCommand('READY', zmtpProperties({ 'Socket-Type': 'PUB' })));
          conn.stage = 'subscribe';
        } else if (conn.stage === 'subscribe') {
          assert.equal(frame.command, false);
          conn.subscription = Buffer.from(frame.body);
          conn.stage = 'traffic';
          while (waiters.length) waiters.shift()();
        } else if (frame.command) {
          conn.pongs.push(frame.body.subarray(1, 1 + frame.body[0]).toString('ascii') + ':' + frame.body.subarray(1 + frame.body[0]).toString('ascii'));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    relay: `tcp://127.0.0.1:${port}`,
    connections,
    /** Дождаться подписки сессии номер `index` (с нуля). */
    async subscribed(index) {
      for (let i = 0; i < 400; i++) {
        if (connections[index]?.stage === 'traffic') return connections[index];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`сессия ${index} не подписалась`);
    },
    send(index, payload) {
      connections[index].sock.write(zmtpFrame(payload));
    },
    async close() {
      for (const conn of connections) conn.sock.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const NOW = Date.now();
const DAY = 24 * 3600_000;
const iso = (offset) => new Date(NOW + offset).toISOString();

function envelope(event, header = {}) {
  return {
    $schemaRef: 'https://eddn.edcd.io/schemas/journal/1',
    header: { uploaderID: 'scrambled', softwareName: 'E:D Market Connector', softwareVersion: '5.12.1', gameversion: '4.1.2.100', gamebuild: 'r310000/r0 ', ...header },
    message: event,
  };
}
const pack = (value) => deflateSync(Buffer.from(JSON.stringify(value), 'utf8'));

function fsdJump(name, address, extra = {}) {
  return {
    timestamp: iso(-60_000),
    event: 'FSDJump',
    StarSystem: name,
    SystemAddress: address,
    StarPos: [60, -40, 12],
    SystemAllegiance: 'Empire',
    SystemGovernment: '$government_Patronage;',
    Population: 50000,
    SystemFaction: { Name: 'Owners' },
    Factions: [{ Name: 'Owners', FactionState: 'None', Government: 'Patronage', Influence: 1, Allegiance: 'Empire' }],
    ControllingPower: 'Aisling Duval',
    Powers: ['Aisling Duval', 'Nakato Kaine'],
    PowerplayState: 'Exploited',
    ...extra,
  };
}

async function until(check, message, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/* ── Чистые функции ────────────────────────────────────────────────────── */

test('отбор сообщений EDDN: только прыжки живой игры; адрес реле и запрет из окружения', () => {
  const ok = mod.eddn.eddnObservation(envelope(fsdJump('A', 1)));
  assert.equal(ok.event.StarSystem, 'A');
  assert.ok('event' in mod.eddn.eddnObservation(envelope({ ...fsdJump('B', 2), event: 'Location' })));
  assert.ok('event' in mod.eddn.eddnObservation(envelope({ ...fsdJump('C', 3), event: 'CarrierJump' }, { gameversion: 'CAPI-Live-journal' })));
  // Legacy (3.8) пишет PowerPlay 1.0 теми же полями — мимо; без версии — тоже.
  assert.deepEqual(mod.eddn.eddnObservation(envelope(fsdJump('D', 4), { gameversion: '3.8.0.407' })), { skip: 'legacy' });
  assert.deepEqual(mod.eddn.eddnObservation(envelope(fsdJump('D', 4), { gameversion: 'CAPI-Legacy-journal' })), { skip: 'legacy' });
  assert.deepEqual(mod.eddn.eddnObservation(envelope(fsdJump('D', 4), { gameversion: undefined })), { skip: 'legacy' });
  assert.deepEqual(mod.eddn.eddnObservation({ ...envelope(fsdJump('E', 5)), $schemaRef: 'https://eddn.edcd.io/schemas/journal/1/test' }), { skip: 'test' });
  assert.deepEqual(mod.eddn.eddnObservation({ ...envelope({}), $schemaRef: 'https://eddn.edcd.io/schemas/commodity/3' }), { skip: 'other' });
  assert.deepEqual(mod.eddn.eddnObservation(envelope({ ...fsdJump('F', 6), event: 'Docked' })), { skip: 'other' });
  assert.deepEqual(mod.eddn.eddnObservation(null), { skip: 'broken' });
  assert.deepEqual(mod.eddn.eddnObservation({ ...envelope(null) }), { skip: 'broken' });

  assert.equal(mod.eddn.decodeEddnFrame(Buffer.from('not zlib')), null);
  assert.equal(mod.eddn.decodeEddnFrame(pack({ a: 1 })).a, 1);
  assert.deepEqual(mod.eddn.parseRelay('tcp://relay.example:9500'), { host: 'relay.example', port: 9500, url: 'tcp://relay.example:9500' });
  assert.equal(mod.eddn.parseRelay('http://x').url, mod.eddn.EDDN_DEFAULT_RELAY, 'неверный адрес — реле EDDN');
  assert.equal(mod.eddn.parseRelay('tcp://x:70000').url, mod.eddn.EDDN_DEFAULT_RELAY);
  assert.equal(mod.eddn.eddnListenerForbidden({ EDDN_LISTENER: 'off' }), true);
  assert.equal(mod.eddn.eddnListenerForbidden({ EDDN_LISTENER: '0' }), true);
  assert.equal(mod.eddn.eddnListenerForbidden({}), false);
});

/* ── ZMTP и слушатель ──────────────────────────────────────────────────── */

test('подписка ZMTP: рукопожатие, отбор, пачка по последнему наблюдению, длинный кадр и PONG', async () => {
  const relay = await fakeRelay();
  const batches = [];
  try {
    mod.eddn.startEddnListener(svc, {
      relay: relay.relay,
      flushMs: 60_000,
      stallMs: 10_000,
      persist: false,
      apply: async (_svc, events) => {
        batches.push(events);
        return {
          received: events.length,
          factions: { received: events.length, applied: events.length, stale: 0, created: 0, systems: [], accepted: events.length, invalid: 0, rejected: {} },
          powerplay: { received: events.length, applied: events.length, stale: 0, created: 1, vacated: 0, resolved: 1, systems: [], accepted: events.length, rejected: {}, error: null },
        };
      },
    });
    const conn = await relay.subscribed(0);
    assert.equal(conn.socketType, 'SUB');
    assert.deepEqual([...conn.subscription], [0x01], 'подписка на всё: «0x01» без префикса');

    relay.send(0, pack(envelope(fsdJump('Border One', 3107442165442))));
    // Та же система позже — в пачку уйдёт только последнее наблюдение.
    relay.send(0, pack(envelope({ ...fsdJump('Border One', 3107442165442), event: 'Location', timestamp: iso(-30_000), PowerplayState: 'Fortified' })));
    relay.send(0, pack(envelope(fsdJump('Legacy Rock', 99), { gameversion: '3.8.0.407' })));
    relay.send(0, pack({ ...envelope(fsdJump('Test', 98)), $schemaRef: 'https://eddn.edcd.io/schemas/journal/1/test' }));
    relay.send(0, pack({ $schemaRef: 'https://eddn.edcd.io/schemas/commodity/3', header: {}, message: { commodities: [] } }));
    relay.send(0, Buffer.from('garbage frame'));
    // Длинный кадр (> 255 байт после сжатия) — флаг LONG и 8-байтовая длина.
    const big = pack(envelope(fsdJump('Big Payload', 3107442165499, { Noise: randomBytes(1500).toString('hex') })));
    assert.ok(big.length > 255);
    relay.send(0, big);
    // PING (ZMTP 3.1): слушатель отвечает PONG с тем же контекстом.
    conn.sock.write(zmtpCommand('PING', Buffer.concat([Buffer.from([0, 10]), Buffer.from('ctx-1')])));

    await until(() => mod.eddn.getEddnListener().stats.messages === 7, 'сообщения не дошли');
    await until(() => conn.pongs.length === 1, 'нет PONG');
    assert.deepEqual(conn.pongs, ['PONG:ctx-1']);
    const live = mod.eddn.getEddnListener();
    assert.equal(live.status, 'connected');
    assert.equal(live.stats.sessions, 1);
    assert.equal(live.stats.journal, 3);
    assert.deepEqual(live.stats.skipped, { legacy: 1, test: 1, broken: 1, other: 1, overflow: 0 });
    assert.equal(live.pending, 2, 'две системы ждут записи');

    const stopped = await mod.eddn.stopEddnListener('остановлен тестом');
    assert.equal(stopped.running, false);
    assert.equal(batches.length, 1, 'остановка дописывает накопленное');
    const byName = Object.fromEntries(batches[0].map((event) => [event.StarSystem, event]));
    assert.deepEqual(Object.keys(byName).sort(), ['Big Payload', 'Border One']);
    assert.equal(byName['Border One'].event, 'Location', 'последнее наблюдение системы');
    assert.equal(byName['Border One'].PowerplayState, 'Fortified');
    assert.equal(stopped.stats.observations, 2);
    assert.equal(stopped.stats.powerplay.resolved, 1);
    assert.match(stopped.log.map((line) => line.text).join('\n'), /Подписка на tcp:\/\/127\.0\.0\.1:\d+ оформлена/);
  } finally {
    await mod.eddn.stopEddnListener();
    mod.eddn.resetEddnListenerRuntime();
    await relay.close();
  }
});

test('сторож тишины: замолчавшее реле — новая сессия; в журнале — сколько пришло до «заморозки»', async () => {
  const relay = await fakeRelay();
  try {
    mod.eddn.startEddnListener(svc, {
      relay: relay.relay,
      stallMs: 300,
      reconnectMs: 50,
      flushMs: 60_000,
      persist: false,
      apply: async () => ({ received: 0, factions: { received: 0, applied: 0, stale: 0, created: 0, systems: [], accepted: 0, invalid: 0, rejected: {} }, powerplay: { received: 0, applied: 0, stale: 0, created: 0, vacated: 0, resolved: 0, systems: [], accepted: 0, rejected: {}, error: null } }),
    });
    await relay.subscribed(0);
    relay.send(0, pack(envelope(fsdJump('Before Freeze', 1))));
    // Реле замолчало: соединение живо, но байтов нет — как при «заморозке» ТСПУ.
    await relay.subscribed(1);
    const snapshot = mod.eddn.getEddnListener();
    assert.ok(snapshot.stats.stalls >= 1);
    assert.ok(snapshot.stats.attempts >= 2);
    assert.ok(snapshot.stats.lastSessionBytes > 0 && snapshot.stats.lastSessionBytes < 64 * 1024);
    const text = snapshot.log.map((line) => line.text).join('\n');
    assert.match(text, /Реле замолчало: .* и 1 сообщ\. за \d+ с, затем тишина 0 с — так выглядит «заморозка» соединения провайдером \(ТСПУ\)/);
  } finally {
    await mod.eddn.stopEddnListener();
    mod.eddn.resetEddnListenerRuntime();
    await relay.close();
  }
});

test('нет связи с реле: пауза растёт, ошибка — в состоянии', async () => {
  // Порт, где никто не слушает.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  try {
    mod.eddn.startEddnListener(svc, { relay: `tcp://127.0.0.1:${port}`, persist: false });
    await until(() => mod.eddn.getEddnListener().status === 'waiting', 'нет ожидания');
    const snapshot = mod.eddn.getEddnListener();
    assert.match(snapshot.error, /Нет связи с реле tcp:\/\/127\.0\.0\.1:\d+/);
    assert.ok(Date.parse(snapshot.nextAttemptAt) - Date.now() > 3_000, 'первая пауза — около 5 с');
  } finally {
    await mod.eddn.stopEddnListener();
    mod.eddn.resetEddnListenerRuntime();
  }
});

/* ── Настоящая база ────────────────────────────────────────────────────── */

test('наблюдение EDDN называет владельца системы PowerPlay и обновляет фракции (источник eddn)', async () => {
  const relay = await fakeRelay();
  try {
    // Спорная по дампу система: EDSM перечислил две державы, владелец не определён.
    await db.query('SELECT public.powerplay_apply_batch($1, $2::jsonb)', ['33333333-3333-3333-3333-333333333333', JSON.stringify([
      { id64: '3107442165442', name: 'Border One', x: 60, y: -40, z: 12, power: '', powers: ['Aisling Duval', 'Nakato Kaine'], power_state: 'Exploited', observed_at: iso(-DAY) },
    ])]);
    assert.equal((await db.query("SELECT power_basis FROM powerplay_systems WHERE id64 = 3107442165442")).rows[0].power_basis, 'unknown');

    mod.eddn.startEddnListener(svc, { relay: relay.relay, flushMs: 60_000, stallMs: 10_000 });
    await relay.subscribed(0);
    relay.send(0, pack(envelope(fsdJump('Border One', 3107442165442))));
    await until(() => mod.eddn.getEddnListener().stats.journal === 1, 'наблюдение не дошло');
    const stopped = await mod.eddn.stopEddnListener('остановлен тестом');
    assert.equal(stopped.stats.powerplay.applied, 1);

    const row = (await db.query('SELECT power, power_basis, source FROM powerplay_systems WHERE id64 = 3107442165442')).rows[0];
    assert.deepEqual(row, { power: 'Aisling Duval', power_basis: 'journal', source: 'eddn' });
    const faction = (await db.query("SELECT source FROM bgs_systems WHERE id64 = 3107442165442")).rows[0];
    assert.equal(faction?.source, 'eddn', 'то же наблюдение — в слой фракций');
    const state = (await db.query('SELECT status, stats, log FROM eddn_listener_state WHERE id = 1')).rows[0];
    assert.equal(state.status, 'off');
    assert.equal(state.stats.powerplay.applied, 1, 'счётчики сохранены для админки');
    assert.ok(state.log.some((line) => /Слушатель EDDN остановлен тестом/.test(line.text)));
  } finally {
    await mod.eddn.stopEddnListener();
    mod.eddn.resetEddnListenerRuntime();
    await relay.close();
  }
});

/* ── Админка и задача планировщика ─────────────────────────────────────── */

function adminRequest(method = 'GET', body) {
  return new Request('https://edringcolony.ru/api/admin/powerplay', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const cronRequest = (secret = 'eddn-cron-secret') => new Request('https://edringcolony.ru/api/cron/eddn-listener', { headers: { authorization: `Bearer ${secret}` } });

test('админка и задача eddn-listener: флаг в базе, запуск, остановка и запрет из окружения', async () => {
  const relay = await fakeRelay();
  const previous = process.env.EDDN_RELAY;
  process.env.EDDN_RELAY = relay.relay;
  try {
    let body = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.deepEqual([body.eddn.enabled, body.eddn.running, body.eddn.supported, body.eddn.status], [false, false, true, 'off']);
    assert.equal((await mod.cronRoute.GET(cronRequest('wrong'))).status, 401);
    let cron = await (await mod.cronRoute.GET(cronRequest())).json();
    assert.deepEqual([cron.ok, cron.enabled, cron.running], [true, false, false], 'выключено — задача ничего не запускает');

    const started = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'eddn-start' }))).json();
    assert.equal(started.success, true);
    assert.equal(started.eddn.running, true);
    const flag = (await db.query('SELECT enabled, enabled_by FROM eddn_listener_state WHERE id = 1')).rows[0];
    assert.deepEqual(flag, { enabled: true, enabled_by: null }, 'автор — только настоящий UUID пользователя');
    await relay.subscribed(0);
    body = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.deepEqual([body.eddn.enabled, body.eddn.running, body.eddn.status, body.eddn.relay], [true, true, 'connected', relay.relay]);

    // Перезапуск сайта: в процессе слушателя нет, флаг в базе есть — задача поднимает его.
    await mod.eddn.stopEddnListener('перезапуск');
    mod.eddn.resetEddnListenerRuntime();
    cron = await (await mod.cronRoute.GET(cronRequest())).json();
    assert.deepEqual([cron.enabled, cron.running], [true, true]);
    await relay.subscribed(1);

    const stopped = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'eddn-stop' }))).json();
    assert.equal(stopped.success, true);
    assert.equal(stopped.eddn.running, false);
    assert.equal((await db.query('SELECT enabled FROM eddn_listener_state WHERE id = 1')).rows[0].enabled, false);
    cron = await (await mod.cronRoute.GET(cronRequest())).json();
    assert.deepEqual([cron.enabled, cron.running], [false, false]);

    process.env.EDDN_LISTENER = 'off';
    const refused = await mod.adminRoute.POST(adminRequest('POST', { action: 'eddn-start' }));
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /EDDN_LISTENER=off/);
    mod.authState.role = 'moderator';
    assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'eddn-start' }))).status, 403);
  } finally {
    mod.authState.role = 'admin';
    delete process.env.EDDN_LISTENER;
    if (previous === undefined) delete process.env.EDDN_RELAY;
    else process.env.EDDN_RELAY = previous;
    await mod.eddn.stopEddnListener();
    mod.eddn.resetEddnListenerRuntime();
    await relay.close();
  }
});
