/**
 * Сквозные тесты двух жалоб на настоящих route handlers (esbuild + подмена
 * `next/server` и Supabase, как в capi-callback-route.test.mjs):
 *
 *   • «при смене аватарки ошибка 503» — загрузка идёт через сайт, и падение
 *     Supabase Storage больше не оставляет пилота без аватара: картинка
 *     сохраняется в базе и отдаётся `/api/avatars/<id>`;
 *   • «не создаются эскадрильи» — пустые строки формы, тег в скобках,
 *     отсутствующий профиль и колонка `tag NOT NULL` на старой базе больше
 *     не отменяют создание, а отказ базы объясняется словами.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем, а не падаем.
}
const maybe = esbuild ? test : test.skip;

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://supabase.colony.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-role-key';
process.env.NEXT_PUBLIC_SITE_URL ??= 'https://colony.test';

const NEXT_SERVER_STUB = `
// NextResponse — класс: маршрут отдачи картинки создаёт ответ через new.
export class NextResponse extends Response {
  static json(body, init) {
    return new Response(JSON.stringify(body), {
      status: (init && init.status) || 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}
export class NextRequest extends Request {}
`;

/**
 * Supabase в памяти: таблицы, Storage с управляемыми отказами и «старая
 * схема» (NOT NULL / отсутствующая колонка).
 */
const SUPABASE_STUB = `
const SUPABASE_URL = 'https://supabase.colony.test';

export const db = {
  user: { id: '11111111-2222-4333-8444-555555555555', email: 'cmdr@colony.test' },
  tables: {},
  missingColumns: new Set(),
  notNullColumns: new Set(),
  storage: { mode: 'ok', buckets: new Set(['avatars']), uploads: [], created: [] },
};

export function reset() {
  db.user = { id: '11111111-2222-4333-8444-555555555555', email: 'cmdr@colony.test' };
  db.tables = { profiles: [{ id: db.user.id, cmdr_name: 'Nova', avatar_url: null }] };
  db.missingColumns = new Set();
  db.notNullColumns = new Set();
  db.storage = { mode: 'ok', buckets: new Set(['avatars']), uploads: [], created: [] };
}
reset();

const rowsOf = (table) => (db.tables[table] ||= []);
const matches = (row, filters) => filters.every(([op, column, value]) =>
  op === 'eq' ? row[column] === value : op === 'neq' ? row[column] !== value : true);

function schemaError(table, values) {
  const missing = Object.keys(values).find((key) => db.missingColumns.has(key));
  if (missing) {
    return { code: 'PGRST204', message: "Could not find the '" + missing + "' column of '" + table + "' in the schema cache" };
  }
  const empty = [...db.notNullColumns].find((column) =>
    column in values && (values[column] === null || values[column] === undefined));
  if (empty) {
    return { code: '23502', message: 'null value in column "' + empty + '" of relation "' + table + '" violates not-null constraint' };
  }
  return null;
}

let nextId = 1;

function makeQuery(table) {
  const filters = [];
  const api = {
    select: () => api,
    eq: (column, value) => { filters.push(['eq', column, value]); return api; },
    neq: (column, value) => { filters.push(['neq', column, value]); return api; },
    order: () => api,
    limit: () => api,
    insert: (values) => {
      const error = schemaError(table, values);
      const row = error ? null : { id: nextId++, ...values };
      if (row) rowsOf(table).push(row);
      const result = { data: row, error };
      return {
        select: () => ({
          single: async () => result,
          maybeSingle: async () => result,
        }),
        then: (resolve, reject) => Promise.resolve({ error }).then(resolve, reject),
      };
    },
    upsert: (values) => {
      const error = schemaError(table, values);
      if (!error) {
        const rows = rowsOf(table);
        const index = rows.findIndex((row) => row.user_id === values.user_id);
        if (index >= 0) rows[index] = { ...rows[index], ...values };
        else rows.push({ ...values });
      }
      return Promise.resolve({ data: error ? null : values, error });
    },
    update: (values) => ({
      eq: (column, value) => {
        const error = schemaError(table, values);
        if (!error) {
          for (const row of rowsOf(table)) if (row[column] === value) Object.assign(row, values);
        }
        return Promise.resolve({ error });
      },
    }),
    delete: () => ({
      eq: (column, value) => {
        db.tables[table] = rowsOf(table).filter((row) => row[column] !== value);
        return Promise.resolve({ error: null });
      },
    }),
    maybeSingle: async () => ({ data: rowsOf(table).find((row) => matches(row, filters)) ?? null, error: null }),
    single: async () => {
      const found = rowsOf(table).find((row) => matches(row, filters));
      return { data: found ?? null, error: found ? null : { code: 'PGRST116', message: 'not found' } };
    },
    then: (resolve, reject) =>
      Promise.resolve({ data: rowsOf(table).filter((row) => matches(row, filters)), error: null }).then(resolve, reject),
  };
  return api;
}

function storageApi() {
  return {
    from: (bucket) => ({
      upload: async (path, body, options) => {
        if (db.storage.mode === 'throw') throw new TypeError('fetch failed');
        if (db.storage.mode === 'unavailable') {
          return { data: null, error: { message: 'Service Unavailable', statusCode: '503' } };
        }
        if (!db.storage.buckets.has(bucket)) {
          return { data: null, error: { message: 'Bucket not found', statusCode: '404' } };
        }
        db.storage.uploads.push({ bucket, path, size: body.length ?? body.byteLength, contentType: options?.contentType });
        return { data: { path }, error: null };
      },
      getPublicUrl: (path) => ({ data: { publicUrl: SUPABASE_URL + '/storage/v1/object/public/' + bucket + '/' + path } }),
      remove: async () => ({ error: null }),
    }),
    createBucket: async (name) => {
      if (db.storage.mode === 'unavailable') return { data: null, error: { message: 'Service Unavailable', statusCode: '503' } };
      db.storage.buckets.add(name);
      db.storage.created.push(name);
      return { data: { name }, error: null };
    },
  };
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
  from: (table) => makeQuery(table),
  storage: storageApi(),
});

export function createClient() { return client(); }
export function createServiceClient() { return client(); }
export function createRouteClient() { return client(); }
export async function authFromRequest() { return { user: db.user, supabase: client() }; }
`;

async function buildRoutes() {
  const dir = mkdtempSync(join(ROOT, '.tmp-avatar-squadron-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as avatar from '@/app/api/account/avatar/route';\n"
    + "export * as avatarFile from '@/app/api/avatars/[id]/route';\n"
    + "export * as squadrons from '@/app/api/squadrons/route';\n"
    + "export { db, reset } from './supabase.mjs';\n",
  );

  const bundle = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: {
      'next/server': join(dir, 'next-server.mjs'),
      '@/lib/supabaseServer': join(dir, 'supabase.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const mod = await import(bundle);
  mod.reset();
  return { mod, dir };
}

/** Однопиксельный PNG — настоящее содержимое, а не случайные байты. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function avatarRequest(bytes = PNG, type = 'image/png', name = 'ava.png') {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return new Request('https://colony.test/api/account/avatar', { method: 'POST', body: form });
}

const squadronRequest = (body) =>
  new Request('https://colony.test/api/squadrons', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/* ── Аватары ────────────────────────────────────────────────────────── */

maybe('аватар уходит в Storage и попадает в профиль', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const res = await mod.avatar.POST(avatarRequest());
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.storage, 'storage');
    assert.match(body.avatarUrl, /^https:\/\/supabase\.colony\.test\/storage\/v1\/object\/public\/avatars\//);
    assert.equal(mod.db.storage.uploads.length, 1);
    assert.equal(mod.db.storage.uploads[0].contentType, 'image/png');
    // Профиль указывает на новую картинку.
    assert.equal(mod.db.tables.profiles[0].avatar_url, body.avatarUrl);
    // Запасная копия не создаётся, пока Storage жив.
    assert.equal((mod.db.tables.profile_avatars ?? []).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('Storage отвечает 503 — аватар всё равно меняется, картинка живёт в базе', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.storage.mode = 'unavailable';

    const res = await mod.avatar.POST(avatarRequest());
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.storage, 'database');
    assert.match(body.avatarUrl, /^\/api\/avatars\/11111111-2222-4333-8444-555555555555\?v=[0-9a-f]{12}$/);
    assert.match(body.warning, /Storage сейчас недоступен/);
    assert.equal(mod.db.tables.profiles[0].avatar_url, body.avatarUrl);

    const saved = mod.db.tables.profile_avatars[0];
    assert.equal(saved.mime, 'image/png');
    assert.equal(saved.byte_size, PNG.byteLength);
    assert.match(saved.bytes, /^\\x[0-9a-f]+$/);

    // И эта картинка действительно отдаётся маршрутом /api/avatars/<id>.
    const fileRes = await mod.avatarFile.GET(
      new Request('https://colony.test' + body.avatarUrl),
      { params: Promise.resolve({ id: mod.db.user.id }) },
    );
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get('content-type'), 'image/png');
    const served = Buffer.from(await fileRes.arrayBuffer());
    assert.deepEqual(served, PNG, 'отдаются те же байты, что загрузили');

    // Повторный запрос с ETag — 304, картинка не гоняется зря.
    const etag = fileRes.headers.get('etag');
    const cached = await mod.avatarFile.GET(
      new Request('https://colony.test' + body.avatarUrl, { headers: { 'if-none-match': etag } }),
      { params: Promise.resolve({ id: mod.db.user.id }) },
    );
    assert.equal(cached.status, 304);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('отсутствующий бакет создаётся, а не ломает загрузку', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.storage.buckets.delete('avatars');

    const res = await mod.avatar.POST(avatarRequest());
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.storage, 'storage');
    assert.deepEqual(mod.db.storage.created, ['avatars']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('неподходящий файл отклоняется понятным текстом, профиль не меняется', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const tooBig = await mod.avatar.POST(avatarRequest(Buffer.alloc(1024 * 1024 + 10, 1)));
    assert.equal(tooBig.status, 413);
    assert.match((await tooBig.json()).error, /больше 1024 КБ/);

    const wrongType = await mod.avatar.POST(avatarRequest(PNG, 'application/pdf', 'doc.pdf'));
    assert.equal(wrongType.status, 415);
    assert.match((await wrongType.json()).error, /JPG, PNG, WebP и GIF/);

    const noFile = await mod.avatar.POST(
      new Request('https://colony.test/api/account/avatar', { method: 'POST', body: new FormData() }),
    );
    assert.equal(noFile.status, 400);

    assert.equal(mod.db.tables.profiles[0].avatar_url, null, 'профиль не трогаем при отказе');
    assert.equal(mod.db.storage.uploads.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('удаление аватара чистит и профиль, и запасную копию', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.storage.mode = 'unavailable';
    await mod.avatar.POST(avatarRequest());
    assert.equal(mod.db.tables.profile_avatars.length, 1);

    const res = await mod.avatar.DELETE(new Request('https://colony.test/api/account/avatar', { method: 'DELETE' }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).avatarUrl, null);
    assert.equal(mod.db.tables.profiles[0].avatar_url, null);
    assert.equal(mod.db.tables.profile_avatars.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Эскадрильи ─────────────────────────────────────────────────────── */

maybe('форма с пустыми полями создаёт эскадрилью и командира', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    // Ровно то, что слала страница /squadrons: пустые строки вместо пропусков.
    const res = await mod.squadrons.POST(squadronRequest({
      name: 'Ring Colony Vanguard',
      tag: '',
      description: '',
      color: '#e67e22',
      allegiance: 'Independent',
      power: '',
      language: 'Russian',
      timezone: 'UTC+03:00',
      discord_url: '',
      website_url: '',
      home_system: '',
      activity_type: 'Mixed',
    }));
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.squadron.name, 'Ring Colony Vanguard');
    assert.equal(body.squadron.tag, 'RCV', 'тег собран из названия');
    assert.equal(body.squadron.power, null, 'пустая строка стала NULL');
    assert.equal(body.squadron.created_by, mod.db.user.id);
    assert.equal(body.squadron.member_limit, 600);

    // Создатель записан в состав, даже если триггера в базе нет.
    const members = mod.db.tables.squadron_members ?? [];
    assert.equal(members.length, 1);
    assert.equal(members[0].user_id, mod.db.user.id);
    assert.equal(members[0].squadron_id, body.squadron.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('тег в скобках принимается, а неверные данные объясняются по полям', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const ok = await mod.squadrons.POST(squadronRequest({ name: 'Colonia Rangers', tag: '[cr7]' }));
    assert.equal((await ok.json()).squadron.tag, 'CR7');

    mod.reset();
    const bad = await mod.squadrons.POST(squadronRequest({ name: 'ab', color: 'красный' }));
    const body = await bad.json();
    assert.equal(bad.status, 400);
    assert.deepEqual(body.errors, ['Название короче 3 символов', 'Цвет: ожидается #RRGGBB']);
    assert.equal(body.error, 'Название короче 3 символов. Цвет: ожидается #RRGGBB');
    assert.equal((mod.db.tables.squadrons ?? []).length, 0);

    const broken = await mod.squadrons.POST(
      new Request('https://colony.test/api/squadrons', { method: 'POST', body: 'не json' }),
    );
    assert.equal(broken.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('старая база с tag NOT NULL: эскадрилья всё равно создаётся', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    // Колонка home_system появилась позже — имитируем отставшую схему,
    // а tag объявлен NOT NULL, как в 000_base_schema.sql.
    mod.db.notNullColumns.add('tag');
    mod.db.missingColumns.add('home_system');

    const res = await mod.squadrons.POST(squadronRequest({
      name: 'Заря Колонии',
      home_system: 'Colonia',
    }));
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.squadron.name, 'Заря Колонии');
    assert.equal(body.squadron.tag, 'ZK', 'тег транслитерирован из названия');
    assert.ok(!('home_system' in body.squadron), 'колонка, которой нет в базе, не мешает созданию');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('вторая эскадрилья не создаётся, профиль создаётся при необходимости', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    // Профиля нет — раньше insert падал внешним ключом.
    mod.db.tables.profiles = [];
    const first = await mod.squadrons.POST(squadronRequest({ name: 'Colonia Rangers' }));
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    assert.equal(mod.db.tables.profiles.length, 1, 'профиль создан молча');

    const second = await mod.squadrons.POST(squadronRequest({ name: 'Second Squadron' }));
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /уже состоите в эскадрилье/);
    assert.equal(mod.db.tables.squadrons.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
