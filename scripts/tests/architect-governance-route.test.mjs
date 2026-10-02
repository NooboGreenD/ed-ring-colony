/**
 * Тесты маршрута /api/architect/governance — администрирование архитектора
 * системы (кто назначен, назначение админом, отказ архитектора от системы).
 *
 * Как и в `architect-plans-route.test.mjs`, маршрут собирается esbuild'ом с
 * подменой `next/server` и `@/lib/supabaseServer`: проверяется настоящий код
 * ответа, а база — заглушка, которая запоминает, какие операции прошли.
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

// Заглушки ставим принудительно: `??=` оставил бы «настоящие» значения из
// build-args web-образа (ENV шага `npm test` в docker build) — тест не герметичен.
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

const SUPABASE_STUB = `
export const db = {
  user: { id: 'user-id' },
  // Профили: id → роль и позывной вызывающего.
  profiles: [],
  // system_architects: назначение системы (одно в тестах).
  assignment: null,
  queries: [],
  upserted: [],
  deleted: [],
  error: null,
};

export function reset(userId = 'user-id') {
  db.user = userId ? { id: userId } : null;
  db.profiles = [];
  db.assignment = null;
  db.queries.length = 0;
  db.upserted.length = 0;
  db.deleted.length = 0;
  db.error = null;
}

function matchesFilters(row, filters) {
  return filters.every(([op, column, value]) => {
    const cell = row?.[column];
    if (op === 'eq') return cell === value;
    if (op === 'ilike') {
      // Упрощённый LIKE: фрагменты между % должны встречаться по порядку.
      const parts = String(value).toLowerCase().split('%').filter(Boolean);
      const hay = String(cell ?? '').toLowerCase();
      let pos = 0;
      for (const part of parts) {
        const found = hay.indexOf(part, pos);
        if (found === -1) return false;
        pos = found + part.length;
      }
      return true;
    }
    return true;
  });
}

function makeQuery(table) {
  const record = { table, verb: null, filters: [], limitValue: null };
  db.queries.push(record);
  const tableRows = () => (table === 'profiles' ? db.profiles : db.assignment ? [db.assignment] : []);
  const respond = () => {
    const rows = tableRows().filter((row) => matchesFilters(row, record.filters));
    const limited = Number.isInteger(record.limitValue) ? rows.slice(0, record.limitValue) : rows;
    return { data: record.single ? limited[0] ?? null : limited, error: db.error };
  };
  const api = {
    select: () => { record.verb = record.verb || 'select'; return api; },
    insert: (row) => { record.verb = 'insert'; db.upserted.push(['insert', table, row]); return api; },
    upsert: (row, options) => { record.verb = 'upsert'; db.upserted.push(['upsert', table, row, options]); return api; },
    delete: () => { record.verb = 'delete'; db.deleted.push(record); return api; },
    eq: (column, value) => { record.filters.push(['eq', column, value]); return api; },
    ilike: (column, value) => { record.filters.push(['ilike', column, value]); return api; },
    order: () => api,
    limit: (value) => { record.limitValue = value; return api; },
    single: async () => { record.single = true; return respond(); },
    maybeSingle: async () => { record.single = true; return respond(); },
    then: (resolve, reject) => Promise.resolve(respond()).then(resolve, reject),
  };
  return api;
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
  from: (table) => makeQuery(table),
});

export function createClient() { return client(); }
export function createServiceClient() { return client(); }
`;

async function buildRoutes() {
  const dir = mkdtempSync(join(ROOT, '.tmp-governance-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as governance from '@/app/api/architect/governance/route';\n"
    + "export { db, reset } from './supabase.mjs';\n",
  );
  const bundle = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    external: [],
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

const request = (method, url, body) => new Request(url, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const json = async (response) => ({ status: response.status, body: await response.json() });

maybe('состояние системы: без системы 400, без назначения architect=null', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const bad = await json(await mod.governance.GET(request('GET', 'http://localhost/api/architect/governance')));
    assert.equal(bad.status, 400);

    const empty = await json(await mod.governance.GET(
      request('GET', 'http://localhost/api/architect/governance?system=HIP+90297'),
    ));
    assert.equal(empty.status, 200);
    assert.equal(empty.body.system, 'HIP 90297');
    assert.equal(empty.body.architect, null);
    assert.deepEqual(empty.body.viewer, { userId: 'user-id', isAdmin: false, isArchitect: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('состояние системы: смотрящему-архитектору возвращается его право', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.assignment = {
      id: 'assign-1',
      user_id: 'user-id',
      architect_name: 'CMDR Tester',
      system_name_lc: 'hip 90297',
      updated_at: '2026-09-28T10:00:00.000Z',
    };
    const response = await json(await mod.governance.GET(
      request('GET', 'http://localhost/api/architect/governance?system=hip 90297'),
    ));
    assert.equal(response.status, 200);
    assert.equal(response.body.architect.name, 'CMDR Tester');
    assert.equal(response.body.viewer.isArchitect, true);
    assert.equal(response.body.viewer.isAdmin, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('назначение: гость 401, не-админ 403', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.reset(null);
    const guest = await json(await mod.governance.PUT(request('PUT', 'http://localhost/api/architect/governance', {
      system: 'HIP 90297',
      architect: 'CMDR New',
    })));
    assert.equal(guest.status, 401);

    mod.reset('user-id');
    mod.db.profiles = [{ id: 'user-id', role: 'user', cmdr_name: 'CMDR Tester' }];
    const forbidden = await json(await mod.governance.PUT(request('PUT', 'http://localhost/api/architect/governance', {
      system: 'HIP 90297',
      architect: 'CMDR New',
    })));
    assert.equal(forbidden.status, 403);
    assert.equal(mod.db.upserted.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('назначение: админ ставит архитектора по позывному', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.reset('admin-id');
    mod.db.profiles = [
      { id: 'admin-id', role: 'admin', cmdr_name: 'Boss' },
      { id: 'pilot-1', role: 'user', cmdr_name: 'CMDR New' },
    ];
    const response = await json(await mod.governance.PUT(request('PUT', 'http://localhost/api/architect/governance', {
      system: 'HIP 90297',
      architect: 'cmdr new',
    })));
    assert.equal(response.status, 200);
    const [verb, table, row, options] = mod.db.upserted[0];
    assert.equal(verb, 'upsert');
    assert.equal(table, 'system_architects');
    assert.equal(row.system_name, 'HIP 90297');
    assert.equal(row.system_name_lc, 'hip 90297');
    assert.equal(row.user_id, 'pilot-1');
    assert.equal(row.architect_name, 'CMDR New');
    assert.equal(row.assigned_by, 'admin-id');
    assert.equal(row.assigned_by_name, 'Boss');
    assert.equal(options.onConflict, 'system_name_lc');

    // Неизвестный позывной честно отвечает 404, не создавая пустышку.
    const missing = await json(await mod.governance.PUT(request('PUT', 'http://localhost/api/architect/governance', {
      system: 'HIP 90297',
      architect: 'Ghost',
    })));
    assert.equal(missing.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('снятие: архитектор отказывается от системы сам, посторонний — 403', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    // Посторонний пользователь снять не может.
    mod.db.profiles = [{ id: 'user-id', role: 'user', cmdr_name: 'Outsider' }];
    mod.db.assignment = {
      id: 'assign-1',
      user_id: 'arch-id',
      architect_name: 'CMDR Arch',
      system_name_lc: 'hip 90297',
    };
    const forbidden = await json(await mod.governance.DELETE(request('DELETE', 'http://localhost/api/architect/governance', {
      system: 'HIP 90297',
    })));
    assert.equal(forbidden.status, 403);
    assert.equal(mod.db.deleted.length, 0);

    // Сам архитектор — может ( resignd=true ).
    mod.reset('arch-id');
    mod.db.profiles = [{ id: 'arch-id', role: 'user', cmdr_name: 'CMDR Arch' }];
    mod.db.assignment = {
      id: 'assign-1',
      user_id: 'arch-id',
      architect_name: 'CMDR Arch',
      system_name_lc: 'hip 90297',
    };
    const resigned = await json(await mod.governance.DELETE(request('DELETE', 'http://localhost/api/architect/governance', {
      system: 'hip 90297',
    })));
    assert.equal(resigned.status, 200);
    assert.equal(resigned.body.resigned, true);
    assert.equal(mod.db.deleted.length, 1);
    assert.deepEqual(mod.db.deleted[0].filters, [['eq', 'id', 'assign-1']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('снятие: без назначения 404, админ снимает чужого архитектора', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const missing = await json(await mod.governance.DELETE(request('DELETE', 'http://localhost/api/architect/governance', {
      system: 'HIP 90297',
    })));
    assert.equal(missing.status, 404);

    mod.reset('admin-id');
    mod.db.profiles = [{ id: 'admin-id', role: 'admin', cmdr_name: 'Boss' }];
    mod.db.assignment = {
      id: 'assign-1',
      user_id: 'arch-id',
      architect_name: 'CMDR Arch',
      system_name_lc: 'hip 90297',
    };
    const removed = await json(await mod.governance.DELETE(request('DELETE', 'http://localhost/api/architect/governance', {
      system: 'HIP 90297',
    })));
    assert.equal(removed.status, 200);
    assert.equal(removed.body.resigned, false, 'это снятие админом, а не отказ');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('подбор командиров для формы: только админ, спецсимволы вычищаются', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const forbidden = await json(await mod.governance.GET(
      request('GET', 'http://localhost/api/architect/governance?search=cmdr'),
    ));
    assert.equal(forbidden.status, 403);

    mod.reset('admin-id');
    mod.db.profiles = [
      { id: 'admin-id', role: 'admin', cmdr_name: 'Boss' },
      { id: 'pilot-1', role: 'user', cmdr_name: 'CMDR New' },
    ];
    const response = await json(await mod.governance.GET(
      request('GET', 'http://localhost/api/architect/governance?search=cmdr%20n%22e%25w'),
    ));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.candidates, [{ id: 'pilot-1', name: 'CMDR New' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
