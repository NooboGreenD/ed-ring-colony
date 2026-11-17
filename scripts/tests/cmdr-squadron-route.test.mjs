/**
 * Тесты роута `/api/cmdr/squadron` — приём эскадрильи пилота из журнала игры
 * от Colonial Helper'а и отдачу сохранённого состояния профилю.
 *
 * Роут импортируется настоящим: esbuild собирает его с подменой `next/server`,
 * `@/lib/supabaseServer`, `@/lib/i18n/apiT` на заглушки (как в
 * cmdr-stats-route.test.mjs). Сама раскладка в БД проверяется настоящим
 * PostgreSQL в squadron-journal-db.test.mjs; здесь — контракт запроса.
 *
 * Что закрепляется:
 *
 *  1. Токен Helper'а определяет пилота, `source = 'helper'`, автовступление
 *     включено по умолчанию.
 *  2. `join: false` доезжает до RPC (сведения обновляются, состав — нет).
 *  3. Пилот без эскадрильи (`SquadronID` нет) — успех без записи; сохранённые
 *     сведения не трогаются.
 *  4. Отставшая база (функции нет) — 503 + `schemaOutdated`, это же объясняет
 *     Helper'у, что повторять после обновления проекта.
 *  5. GET на отставшей базе отвечает `squadron: null, schemaOutdated: true`,
 *     а не 500.
 *  6. GET подставляет имя эскадрильи сайта по связи из миграции.
 *  7. Эскадрильи, которой на сайте нет, создаётся по журналу: тег из журнала
 *     доезжает до RPC (по нему сайт не заводит дубль), а признак «создана»
 *     возвращается клиенту.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем, а не падаем.
}
const maybe = esbuild ? test : test.skip;

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) =>
    new Response(JSON.stringify(body), {
      status: (init && init.status) || 200,
      headers: { 'content-type': 'application/json' },
    }),
};
`;

const I18N_STUB = `
export async function apiTranslate() {
  return (key) => {
    const dict = {
      'sqg.invalidJson': 'Тело запроса должно быть JSON-объектом',
      'sqg.unauthorized': 'Нужен вход или API-токен',
      'sqg.schemaOutdated': 'База не обновлена: примените миграцию 20261117090000',
    };
    return dict[key] ?? key;
  };
}
`;

/**
 * In-memory Supabase: профиль, токены, эскадрильи и RPC `apply_pilot_squadron`.
 * RPC записывает аргументы в `db.rpcCalls` и отвечает тем, что положили в
 * `db.rpcResult` (или ошибкой из `db.rpcError`).
 */
const SUPABASE_STUB = `
export const db = {
  user: { id: 'user-1' },
  tables: {},
  rpcCalls: [],
  rpcResult: { ok: true },
  rpcError: null,
  // Ошибка выдачи строк: так выглядит запрос к базе без нужной колонки.
  selectError: null,
};

export function reset() {
  db.user = { id: 'user-1' };
  db.tables = {
    profiles: [{
      id: 'user-1',
      game_squadron_id: 75645,
      game_squadron_name: 'ENDURANCE EXPLORATION',
      game_squadron_rank: 4,
      game_squadron_rank_name: null,
      game_squadron_at: '2026-11-10T18:00:00Z',
      game_squadron_site_id: 12,
      game_squadron_source: 'helper',
    }],
    api_tokens: [],
    squadrons: [{ id: 12, name: 'ENDURANCE EXPLORATION', tag: 'ENEX' }],
  };
  db.rpcCalls = [];
  db.rpcResult = { ok: true };
  db.rpcError = null;
  db.selectError = null;
}
reset();

const rowsOf = (table) => (db.tables[table] ||= []);

function matches(row, filters) {
  return filters.every(([op, column, value]) => {
    if (op === 'eq') return row[column] === value;
    if (op === 'ilike') return String(row[column] ?? '').toLowerCase() === String(value).toLowerCase();
    return true;
  });
}

function makeQuery(table) {
  const filters = [];
  const api = {
    select: () => api,
    eq: (column, value) => { filters.push(['eq', column, value]); return api; },
    ilike: (column, value) => { filters.push(['ilike', column, value]); return api; },
    order: () => api,
    limit: () => api,
    update: (values) => ({
      eq: (column, value) => {
        for (const row of rowsOf(table)) if (row[column] === value) Object.assign(row, values);
        return Promise.resolve({ error: null });
      },
    }),
    maybeSingle: async () => {
      if (db.selectError) return { data: null, error: db.selectError };
      return { data: rowsOf(table).find((row) => matches(row, filters)) ?? null, error: null };
    },
    then: (resolve, reject) => {
      const found = rowsOf(table).filter((row) => matches(row, filters));
      return Promise.resolve({ data: found, error: null }).then(resolve, reject);
    },
  };
  return api;
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
  from: (table) => makeQuery(table),
  rpc: async (name, args) => {
    db.rpcCalls.push({ name, args });
    if (db.rpcError) return { data: null, error: db.rpcError };
    return { data: db.rpcResult, error: null };
  },
});

export const supabaseAdmin = client();
export const supabase = client();
export async function authFromRequest() { return { user: db.user, supabase: client() }; }
export function createServiceClient() { return client(); }
export async function createClient() { return client(); }
`;

async function buildRoute() {
  const dir = mkdtempSync(join(ROOT, '.tmp-cmdr-squadron-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  writeFileSync(join(dir, 'i18n.mjs'), I18N_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, "export * as squadron from '@/app/api/cmdr/squadron/route';\n"
    + "export { db, reset } from './supabase.mjs';\n");

  const bundle = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: {
      'next/server': join(dir, 'next-server.mjs'),
      '@/lib/supabaseAdmin': join(dir, 'supabase.mjs'),
      '@/lib/supabaseServer': join(dir, 'supabase.mjs'),
      '@/lib/i18n/apiT': join(dir, 'i18n.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const mod = await import(`${bundle}?v=${Math.random()}`);
  mod.reset();
  return { mod, dir };
}

const HELPER_TOKEN = 'rc_helper-token-0123456789abcdef';
const HELPER_TOKEN_HASH = createHash('sha256').update(HELPER_TOKEN).digest('hex');

function seedApiToken(mod) {
  mod.db.tables.api_tokens = [{ user_id: 'user-1', is_revoked: false, token_hash: HELPER_TOKEN_HASH }];
}

function post(mod, body) {
  return mod.squadron.POST(new Request('https://colony.test/api/cmdr/squadron', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/* ── тесты ─────────────────────────────────────────────────────────── */

maybe('POST от Helper: пилот из токена, источник helper, автовступление включено', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    mod.db.rpcResult = { ok: true, squadronId: 12, joined: true, rankId: 3 };
    // У Helper'а нет сессии сайта: только токен `rc_…`, как в жизни.
    mod.db.user = null;

    const res = await post(mod, {
      token: HELPER_TOKEN,
      game_squadron_id: 75645,
      game_squadron_name: 'ENDURANCE EXPLORATION',
      game_squadron_rank: 4,
      event_at: '2026-11-10T18:00:00Z',
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.stored, true);
    assert.equal(json.joined, true);
    assert.equal(json.squadronId, 12);

    assert.equal(mod.db.rpcCalls.length, 1);
    const call = mod.db.rpcCalls[0];
    assert.equal(call.name, 'apply_pilot_squadron');
    assert.equal(call.args.p_user, 'user-1', 'пилот берётся из токена, а не из тела');
    assert.equal(call.args.p_game_id, 75645);
    assert.equal(call.args.p_name, 'ENDURANCE EXPLORATION');
    assert.equal(call.args.p_rank, 4);
    assert.equal(call.args.p_source, 'helper');
    assert.equal(call.args.p_join, true);
    assert.equal(new Date(call.args.p_at).toISOString(), '2026-11-10T18:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: тег из журнала доезжает до раскладки, признак создания возвращается', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    mod.db.user = null;
    mod.db.rpcResult = { ok: true, created: true, squadronId: 33, joined: true, foundBy: 'created' };

    const res = await post(mod, {
      token: HELPER_TOKEN,
      game_squadron_id: 424242,
      game_squadron_name: 'UNKNOWN WING',
      game_squadron_tag: 'unkw',
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.created, true, 'сайт завёл эскадрилью по журналу');
    assert.equal(json.foundBy, 'created');
    assert.equal(mod.db.rpcCalls[0].args.p_tag, 'unkw', 'тег нужен, чтобы не создать дубль');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST без тега передаёт null, а не пустую строку', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    mod.db.user = null;
    await post(mod, { token: HELPER_TOKEN, game_squadron_id: 1, game_squadron_name: 'X' });
    assert.equal(mod.db.rpcCalls[0].args.p_tag, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: join=false доезжает до раскладки (сведения без вступления)', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    const res = await post(mod, { token: HELPER_TOKEN, game_squadron_id: 5, game_squadron_name: 'X', join: false });
    assert.equal(res.status, 200);
    assert.equal(mod.db.rpcCalls[0].args.p_join, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST от сессии сайта помечает источник web', async () => {
  const { mod, dir } = await buildRoute();
  try {
    const res = await post(mod, { game_squadron_id: 75645, game_squadron_name: 'ENDURANCE EXPLORATION' });
    assert.equal(res.status, 200);
    assert.equal(mod.db.rpcCalls[0].args.p_source, 'web');
    assert.equal(mod.db.rpcCalls[0].args.p_user, 'user-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST без SquadronID: не ошибка и не запись, сохранённое не трогается', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    const res = await post(mod, { token: HELPER_TOKEN, game_squadron_name: 'Без ID' });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.stored, false);
    assert.equal(json.reason, 'no_squadron');
    assert.equal(mod.db.rpcCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: отставшая база — 503 с schemaOutdated', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    mod.db.rpcError = {
      code: 'PGRST202',
      message: 'Could not find the function public.apply_pilot_squadron(p_user, p_game_id) in the schema cache',
    };
    const res = await post(mod, { token: HELPER_TOKEN, game_squadron_id: 75645, game_squadron_name: 'X' });
    const json = await res.json();
    assert.equal(res.status, 503);
    assert.equal(json.ok, false);
    assert.equal(json.schemaOutdated, true);
    assert.match(json.error, /миграц/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: без авторизации — 401 и никаких вызовов БД', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.db.user = null;
    const res = await post(mod, { game_squadron_id: 75645, game_squadron_name: 'X' });
    assert.equal(res.status, 401);
    assert.equal(mod.db.rpcCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: битый JSON — 400, а не 500', async () => {
  const { mod, dir } = await buildRoute();
  try {
    const res = await mod.squadron.POST(new Request('https://colony.test/api/cmdr/squadron', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{не json',
    }));
    assert.equal(res.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('GET отдаёт эскадрилью пилота и имя эскадрильи сайта', async () => {
  const { mod, dir } = await buildRoute();
  try {
    const res = await mod.squadron.GET(new Request('https://colony.test/api/cmdr/squadron'));
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.squadron.gameSquadronId, 75645);
    assert.equal(json.squadron.gameSquadronName, 'ENDURANCE EXPLORATION');
    assert.equal(json.squadron.gameRank, 4);
    assert.equal(json.squadron.siteSquadronId, 12);
    assert.equal(json.squadron.siteSquadronName, 'ENDURANCE EXPLORATION');
    assert.equal(json.squadron.source, 'helper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('GET на базе без миграции: squadron null + schemaOutdated, не 500', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.db.selectError = {
      code: '42703',
      message: 'column profiles.game_squadron_id does not exist',
    };
    const res = await mod.squadron.GET(new Request('https://colony.test/api/cmdr/squadron'));
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.squadron, null);
    assert.equal(json.schemaOutdated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('GET: прочие ошибки базы — 500, а не молчаливое «неизвестно»', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.db.selectError = { code: '57014', message: 'canceling statement due to statement timeout' };
    const res = await mod.squadron.GET(new Request('https://colony.test/api/cmdr/squadron'));
    assert.equal(res.status, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
