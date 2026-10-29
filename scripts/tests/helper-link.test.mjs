/**
 * Привязка лаунчера к учётной записи: код из профиля → токен устройства →
 * перенос раскладки оверлея.
 *
 * Проверки держат ровно то, за что отвечает сервер:
 *
 *  1. код привязки выдаётся только владельцу учётной записи, живёт десять
 *     минут и годится один раз — повторный ввод не создаёт второе устройство;
 *  2. в базе нет ни кода, ни токена в открытом виде: только sha256, поэтому
 *     утечка дампа не даёт войти в чужой аккаунт;
 *  3. отозванное устройство сразу получает 401, а настройки по нему больше не
 *     читаются и не пишутся;
 *  4. снимок настроек принимается только объектом и только разумного размера.
 *
 * Настоящие роуты собираются esbuild'ом, а Supabase заменён таблицами в
 * памяти: тест не ходит в сеть. Без esbuild тест честно пропускается.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем.
}
const maybe = esbuild ? test : test.skip;

const work = mkdtempSync(join(tmpdir(), 'edrc-helper-link-'));
test.after(() => rmSync(work, { recursive: true, force: true }));

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

let api = null;
let db = null;

if (esbuild) {
  const shim = join(work, 'next-server.mjs');
  writeFileSync(
    shim,
    `export class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
  static redirect(url, init = 307) {
    const status = typeof init === 'number' ? init : (init.status || 307);
    return new Response(null, { status, headers: { location: String(url) } });
  }
}
export class NextRequest extends Request {}
`,
  );

  // ── Замена Supabase: таблицы в памяти с тем же минимумом запросов, который
  //    используют обработчики (select/insert/update/upsert + eq/is).
  const dbShim = join(work, 'supabase.mjs');
  writeFileSync(
    dbShim,
    `import { randomUUID } from 'node:crypto';

// esbuild встраивает заглушку в бандл, поэтому у теста и у роутов оказались
// бы разные копии массивов. Держим состояние в globalThis — оно одно.
const state = (globalThis.__helperLinkDb ||= {
  helper_devices: [],
  helper_link_codes: [],
  helper_settings: [],
  profiles: [],
});
export const db = state;

function defaults(table, row) {
  const now = new Date().toISOString();
  if (table === 'helper_devices') {
    return { id: randomUUID(), name: '', created_at: now, last_seen_at: now, revoked_at: null, ...row };
  }
  if (table === 'helper_link_codes') {
    return { created_at: now, used_at: null, device_id: null, ...row };
  }
  if (table === 'helper_settings') {
    return { payload: {}, device_name: '', updated_at: now, ...row };
  }
  return { ...row };
}

function matches(row, filters) {
  return filters.every(([column, value, kind]) => (
    kind === 'is' ? (value === null ? row[column] == null : row[column] === value) : row[column] === value
  ));
}

function pick(row, columns) {
  if (!columns || columns === '*') return { ...row };
  const names = String(columns).split(',').map((name) => name.trim()).filter(Boolean);
  const out = {};
  for (const name of names) out[name] = row[name];
  return out;
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.action = 'select';
    this.payload = null;
    this.columns = '*';
  }

  select(columns = '*') {
    if (this.action === 'select') this.columns = columns;
    return this;
  }

  insert(row) { this.action = 'insert'; this.payload = row; return this; }
  upsert(row) { this.action = 'upsert'; this.payload = row; return this; }
  update(patch) { this.action = 'update'; this.payload = patch; return this; }
  eq(column, value) { this.filters.push([column, value, 'eq']); return this; }
  is(column, value) { this.filters.push([column, value, 'is']); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { return this.run(true); }

  then(resolve, reject) { return this.run(false).then(resolve, reject); }

  async run(single) {
    const rows = db[this.table];
    if (this.action === 'insert') {
      const created = defaults(this.table, this.payload);
      if (this.table === 'helper_devices'
        && rows.some((row) => row.token_hash === created.token_hash)) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      if (this.table === 'helper_link_codes' && rows.some((row) => row.code_hash === created.code_hash)) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      rows.push(created);
      return { data: single ? pick(created, this.columns) : [pick(created, this.columns)], error: null };
    }
    if (this.action === 'upsert') {
      const existing = rows.find((row) => row.user_id === this.payload.user_id);
      const merged = existing
        ? Object.assign(existing, this.payload)
        : (rows.push(defaults(this.table, this.payload)), rows[rows.length - 1]);
      return { data: [pick(merged, this.columns)], error: null };
    }
    const touched = rows.filter((row) => matches(row, this.filters));
    if (this.action === 'update') {
      for (const row of touched) Object.assign(row, this.payload);
      return {
        data: single ? (touched[0] ? pick(touched[0], this.columns) : null) : touched.map((row) => pick(row, this.columns)),
        error: null,
      };
    }
    return {
      data: single ? (touched[0] ? pick(touched[0], this.columns) : null) : touched.map((row) => pick(row, this.columns)),
      error: null,
    };
  }
}

export function createServiceClient() {
  return {
    from: (table) => new Query(table),
    auth: {
      admin: {
        getUserById: async (id) => {
          const user = db.profiles.find((row) => row.id === id);
          if (!user) return { data: { user: null }, error: { message: 'not found' } };
          return {
            data: {
              user: {
                id,
                email: user.email || 'pilot@example.org',
                user_metadata: { cmdr_name: user.cmdr_name || '' },
              },
            },
            error: null,
          };
        },
      },
    },
  };
}

export async function authFromRequest(request) {
  const id = request.headers.get('x-test-user');
  if (!id) return { user: null, supabase: createServiceClient() };
  return {
    user: { id, email: 'pilot@example.org', user_metadata: {} },
    supabase: createServiceClient(),
  };
}
`,
  );

  const entry = join(work, 'entry.ts');
  writeFileSync(
    entry,
    `export { POST as codePOST } from '@/app/api/uploader/link/code/route';
export { POST as claimPOST } from '@/app/api/uploader/link/claim/route';
export { GET as linkGET, DELETE as linkDELETE } from '@/app/api/uploader/link/route';
export { GET as meGET, DELETE as meDELETE } from '@/app/api/uploader/link/me/route';
export { GET as settingsGET, PUT as settingsPUT } from '@/app/api/uploader/settings/route';
export { LINK_CODE_TTL_SECONDS, MAX_SETTINGS_BYTES, normalizeLinkCode } from '@/lib/helperDevices';
`,
  );

  const outfile = join(work, 'routes.mjs');
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    alias: { 'next/server': shim, '@/lib/supabaseServer': dbShim },
    tsconfig: join(ROOT, 'tsconfig.json'),
  });
  api = await import(outfile);
  // Таблицы берём прямо из заглушки: пространство имён ES-модуля неизменяемо.
  db = (await import(dbShim)).db;
}

/**
 * Каждый тест работает со своим пилотом: у выдачи кода есть ограничение
 * частоты (шесть штук в минуту на учётную запись), и общий пользователь
 * упёрся бы в него на третьей проверке. Ограничение проверяется отдельно.
 */
function sessionHeaders(userId) {
  return { 'x-test-user': userId };
}

async function issueCode(userId) {
  const response = await api.codePOST(new Request('https://edringcolony.ru/api/uploader/link/code', {
    method: 'POST',
    headers: sessionHeaders(userId),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.ok, true);
  return payload;
}

async function claim(code, device = 'PC-JAMESON', ip = '') {
  const response = await api.claimPOST(new Request('https://edringcolony.ru/api/uploader/link/claim', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip || `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ code, device }),
  }));
  return { response, payload: await response.json() };
}

maybe('код привязки выдаётся только владельцу учётной записи', async () => {
  const anonymous = await api.codePOST(new Request('https://edringcolony.ru/api/uploader/link/code', {
    method: 'POST',
  }));
  assert.equal(anonymous.status, 401);

  const payload = await issueCode(randomUUID());
  assert.match(payload.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(payload.ttlSeconds, api.LINK_CODE_TTL_SECONDS);
  assert.equal(api.LINK_CODE_TTL_SECONDS, 600);
});

maybe('частые запросы кода упираются в ограничение, а не в бесконечную выдачу', async () => {
  const user = randomUUID();
  const statuses = [];
  for (let index = 0; index < 7; index += 1) {
    const response = await api.codePOST(new Request('https://edringcolony.ru/api/uploader/link/code', {
      method: 'POST', headers: sessionHeaders(user),
    }));
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.equal(statuses[6], 429);
});

maybe('в базе лежит хеш кода, а не сам код', async () => {
  const { code } = await issueCode(randomUUID());
  const stored = db.helper_link_codes.map((row) => row.code_hash);
  assert.ok(stored.includes(sha256(code)));
  assert.equal(stored.includes(code), false);
});

maybe('код меняется на токен устройства и работает только один раз', async () => {
  const user = randomUUID();
  db.profiles.push({ id: user, cmdr_name: 'JAMESON', avatar_url: null, role: 'user' });
  const { code } = await issueCode(user);
  const first = await claim(code, 'PC-JAMESON');
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.ok, true);
  assert.match(first.payload.token, /^[0-9a-f]{64}$/);
  assert.equal(first.payload.profile.nick, 'JAMESON');

  const again = await claim(code, 'PC-DUPLICATE');
  assert.equal(again.response.status, 400);
  assert.match(again.payload.error, /уже использован/);
  assert.equal(db.helper_devices.filter((row) => row.user_id === user).length, 1);

  // Токен тоже хранится хешем.
  assert.ok(db.helper_devices.some((row) => row.token_hash === sha256(first.payload.token)));
});

maybe('код без дефиса и в нижнем регистре принимается', async () => {
  const { code } = await issueCode(randomUUID());
  const reply = await claim(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase());
  assert.equal(reply.response.status, 200, JSON.stringify(reply.payload));
});

maybe('неверный и просроченный код отклоняются с понятным текстом', async () => {
  const wrong = await claim('ZZZZ9999');
  assert.equal(wrong.response.status, 400);
  assert.match(wrong.payload.error, /не найден/);

  const short = await claim('ABC');
  assert.equal(short.response.status, 400);
  assert.match(short.payload.error, /8 символов/);

  const { code } = await issueCode(randomUUID());
  const record = db.helper_link_codes.find((row) => row.code_hash === sha256(code));
  record.expires_at = new Date(Date.now() - 1000).toISOString();
  const expired = await claim(code);
  assert.equal(expired.response.status, 400);
  assert.match(expired.payload.error, /истёк/);
});

maybe('новый код гасит прежний неиспользованный', async () => {
  const user = randomUUID();
  const first = await issueCode(user);
  const second = await issueCode(user);
  const old = await claim(first.code);
  assert.equal(old.response.status, 400);
  const fresh = await claim(second.code);
  assert.equal(fresh.response.status, 200, JSON.stringify(fresh.payload));
});

maybe('профиль по токену устройства — то же имя, что на сайте', async () => {
  const user = randomUUID();
  db.profiles.push({ id: user, cmdr_name: 'JAMESON', avatar_url: null, role: 'user' });
  const { code } = await issueCode(user);
  const { payload } = await claim(code);
  const response = await api.meGET(new Request('https://edringcolony.ru/api/uploader/link/me', {
    headers: { authorization: `Bearer ${payload.token}` },
  }));
  const me = await response.json();
  assert.equal(response.status, 200);
  assert.equal(me.profile.nick, 'JAMESON');
  assert.equal(me.device.id, payload.deviceId);

  const garbage = await api.meGET(new Request('https://edringcolony.ru/api/uploader/link/me', {
    headers: { authorization: 'Bearer not-a-real-token' },
  }));
  assert.equal(garbage.status, 401);
});

maybe('настройки сохраняются и читаются по токену устройства', async () => {
  const { code } = await issueCode(randomUUID());
  const { payload } = await claim(code, 'PC-LAYOUT');
  const token = payload.token;
  const layout = { version: 1, profiles: { Бой: { ship: { x: 1, y: 2 } } }, active_profile: 'Бой' };

  const saved = await api.settingsPUT(new Request('https://edringcolony.ru/api/uploader/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: layout }),
  }));
  assert.equal(saved.status, 200, await saved.clone().text());

  const read = await api.settingsGET(new Request('https://edringcolony.ru/api/uploader/settings', {
    headers: { authorization: `Bearer ${token}` },
  }));
  const payloadRead = await read.json();
  assert.equal(read.status, 200);
  assert.deepEqual(payloadRead.settings, layout);
  assert.match(payloadRead.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payloadRead.deviceName, 'PC-LAYOUT');
});

maybe('запись настроек требует привязки, а не просто входа на сайте', async () => {
  const response = await api.settingsPUT(new Request('https://edringcolony.ru/api/uploader/settings', {
    method: 'PUT',
    headers: { ...sessionHeaders(randomUUID()), 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { version: 1 } }),
  }));
  assert.equal(response.status, 401);
});

maybe('снимок принимается только объектом разумного размера', async () => {
  const { code } = await issueCode(randomUUID());
  const { payload } = await claim(code, 'PC-LIMITS');
  const token = payload.token;

  const asArray = await api.settingsPUT(new Request('https://edringcolony.ru/api/uploader/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: [1, 2, 3] }),
  }));
  assert.equal(asArray.status, 400);

  const huge = { version: 1, profiles: { big: 'x'.repeat(api.MAX_SETTINGS_BYTES) } };
  const tooBig = await api.settingsPUT(new Request('https://edringcolony.ru/api/uploader/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: huge }),
  }));
  assert.equal(tooBig.status, 400);
  const payloadTooBig = await tooBig.json();
  assert.match(payloadTooBig.error, /КБ/);
});

maybe('в профиле видно привязанные устройства, отзыв закрывает токен сразу', async () => {
  const user = randomUUID();
  const { code } = await issueCode(user);
  const { payload } = await claim(code, 'PC-REVOKE');
  const token = payload.token;

  const list = await api.linkGET(new Request('https://edringcolony.ru/api/uploader/link', {
    headers: sessionHeaders(user),
  }));
  const payloadList = await list.json();
  assert.equal(list.status, 200);
  assert.equal(payloadList.devices.length, 1);
  assert.equal(payloadList.devices[0].name, 'PC-REVOKE');

  const revoked = await api.linkDELETE(new Request(
    `https://edringcolony.ru/api/uploader/link?device=${payload.deviceId}`,
    { method: 'DELETE', headers: sessionHeaders(user) },
  ));
  assert.equal(revoked.status, 200);

  const after = await api.meGET(new Request('https://edringcolony.ru/api/uploader/link/me', {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(after.status, 401);

  const empty = await api.linkGET(new Request('https://edringcolony.ru/api/uploader/link', {
    headers: sessionHeaders(user),
  }));
  assert.deepEqual((await empty.json()).devices, []);
});

maybe('отвязать чужое устройство нельзя', async () => {
  const owner = randomUUID();
  const stranger = randomUUID();
  const { code } = await issueCode(owner);
  const { payload } = await claim(code, 'PC-OWNER');
  const response = await api.linkDELETE(new Request(
    `https://edringcolony.ru/api/uploader/link?device=${payload.deviceId}`,
    { method: 'DELETE', headers: sessionHeaders(stranger) },
  ));
  assert.equal(response.status, 404);
});

maybe('список устройств и настройки требуют входа', async () => {
  const list = await api.linkGET(new Request('https://edringcolony.ru/api/uploader/link'));
  assert.equal(list.status, 401);
  const settings = await api.settingsGET(new Request('https://edringcolony.ru/api/uploader/settings'));
  assert.equal(settings.status, 401);
  const remove = await api.linkDELETE(new Request(
    'https://edringcolony.ru/api/uploader/link?device=x', { method: 'DELETE' },
  ));
  assert.equal(remove.status, 401);
});

maybe('отвязка из лаунчера отвечает успехом даже для уже отозванного токена', async () => {
  const { code } = await issueCode(randomUUID());
  const { payload } = await claim(code, 'PC-FORGET');
  const first = await api.meDELETE(new Request('https://edringcolony.ru/api/uploader/link/me', {
    method: 'DELETE', headers: { authorization: `Bearer ${payload.token}` },
  }));
  assert.equal(first.status, 200);
  const second = await api.meDELETE(new Request('https://edringcolony.ru/api/uploader/link/me', {
    method: 'DELETE', headers: { authorization: `Bearer ${payload.token}` },
  }));
  assert.equal(second.status, 200);
});

maybe('код нормализуется: дефисы, пробелы и регистр не мешают', async () => {
  assert.equal(api.normalizeLinkCode(' abcd-2345 '), 'ABCD2345');
  assert.equal(api.normalizeLinkCode('абвгд'), '');
});
