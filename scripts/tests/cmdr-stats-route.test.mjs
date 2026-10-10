/**
 * Тесты роута `/api/cmdr/stats` — приём сводки пилота от программы
 * (Colonial Helper) и от сайта, и её выдача для досье.
 *
 * Роут импортируется настоящим: собирается esbuild'ом с подменой `next/server`,
 * `@/lib/supabaseAdmin` и `@/lib/supabaseServer` на заглушки (как в
 * capi-callback-route.test.mjs).
 *
 * Что закрепляется:
 *
 *  1. POST от программы (API-токен) НЕ перетирает строку `pilot_stats`,
 *     последним источником которой была загрузка журналов на сайте
 *     (`stats_source = 'web'`): ответ несёт `pilotStatsSkipped: 'web_source'`,
 *     обе таблицы (pilot_stats и capi_profiles) остаются без изменений.
 *  2. POST от программы при незащищённой строке пишет и помечает источник
 *     `helper`; POST от сайта (сессия) пишет и помечает `web`.
 *  3. GET отдаёт ранги и положение из `pilot_stats`, даже когда
 *     `capi_profiles` пуст — единое слияние с страницей досье.
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

/** In-memory Supabase: таблицы, select/eq/ilike/upsert/update/maybeSingle. */
const SUPABASE_STUB = `
export const db = {
  user: { id: 'user-1' },
  tables: {},
};

export function reset() {
  db.user = { id: 'user-1' };
  db.tables = {
    profiles: [{ id: 'user-1', cmdr_name: 'Nova', privacy_settings: null }],
  };
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
    upsert: (values) => {
      const rows = rowsOf(table);
      const index = rows.findIndex((row) => row.user_id === values.user_id);
      if (index >= 0) rows[index] = { ...rows[index], ...values };
      else rows.push({ ...values });
      return Promise.resolve({ error: null, data: values });
    },
    update: (values) => ({
      eq: (column, value) => {
        for (const row of rowsOf(table)) {
          if (row[column] === value || row.id === value) Object.assign(row, values);
        }
        return Promise.resolve({ error: null });
      },
    }),
    maybeSingle: async () => {
      const found = rowsOf(table).find((row) => matches(row, filters));
      return { data: found ?? null, error: null };
    },
    then: (resolve, reject) => {
      const found = rowsOf(table).filter((row) => matches(row, filters));
      return Promise.resolve({ data: found, error: null, count: found.length }).then(resolve, reject);
    },
  };
  return api;
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
  from: (table) => makeQuery(table),
});

export const supabaseAdmin = client();
export async function authFromRequest() { return { user: db.user, supabase: client() }; }
`;

async function buildRoute() {
  const dir = mkdtempSync(join(ROOT, '.tmp-cmdr-stats-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, "export * as stats from '@/app/api/cmdr/stats/route';\n"
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
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const mod = await import(bundle);
  mod.reset();
  return { mod, dir };
}

const HELPER_TOKEN = 'rc_helper-token-0123456789abcdef';
const HELPER_TOKEN_HASH = createHash('sha256').update(HELPER_TOKEN).digest('hex');

function seedApiToken(mod) {
  mod.db.tables.api_tokens = [{ user_id: 'user-1', is_revoked: false, token_hash: HELPER_TOKEN_HASH }];
}

function postStats(mod, body) {
  return mod.stats.POST(new Request('https://colony.test/api/cmdr/stats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/* ── тесты ─────────────────────────────────────────────────────────── */

maybe('POST от программы не перетирает сводку, загруженную через сайт', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    mod.db.tables.pilot_stats = [{
      user_id: 'user-1', cmdr_name: 'Nova', credits: 555, combat_rank: 3, stats_source: 'web',
    }];
    mod.db.tables.capi_profiles = [{
      user_id: 'user-1', cmdr_name: 'Nova', credits: 111, combat_rank: 2,
    }];

    const res = await postStats(mod, {
      token: HELPER_TOKEN,
      cmdr: 'Nova',
      credits: 999999,
      combat_rank: 8,
      current_system: 'Other System',
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.pilotStatsSkipped, 'web_source');
    assert.match(json.warning ?? '', /приоритет у данных, загруженных через сайт/);

    // Данные сайта не тронуты ни в одной таблице.
    assert.equal(mod.db.tables.pilot_stats[0].credits, 555);
    assert.equal(mod.db.tables.pilot_stats[0].combat_rank, 3);
    assert.equal(mod.db.tables.capi_profiles[0].credits, 111);
    assert.equal(mod.db.tables.capi_profiles[0].combat_rank, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST от программы пишет сводку, если строка не защищена, и помечает источник', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    mod.db.tables.pilot_stats = [{
      user_id: 'user-1', cmdr_name: 'Nova', credits: 555, combat_rank: 3, stats_source: 'helper',
    }];
    mod.db.tables.capi_profiles = [{ user_id: 'user-1', cmdr_name: 'Nova', credits: 111 }];

    const res = await postStats(mod, {
      token: HELPER_TOKEN,
      cmdr: 'Nova',
      credits: 777,
      combat_rank: 8,
      current_system: 'Colonia',
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.pilotStatsSkipped, null);

    const row = mod.db.tables.pilot_stats[0];
    assert.equal(row.credits, 777);
    assert.equal(row.combat_rank, 8);
    assert.equal(row.current_system, 'Colonia');
    assert.equal(row.stats_source, 'helper');
    assert.ok(row.stats_source_at, 'метка времени источника записана');
    // Зеркало в capi_profiles обновлено, поля источника — нет.
    assert.equal(mod.db.tables.capi_profiles[0].credits, 777);
    assert.equal(mod.db.tables.capi_profiles[0].stats_source, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST от программы пишет сводку, если строки ещё нет (новый пилот)', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);

    const res = await postStats(mod, {
      token: HELPER_TOKEN,
      cmdr: 'Nova',
      credits: 42,
      mercenary_coins: 9999,
    });
    const json = await res.json();

    assert.equal(json.ok, true);
    assert.equal(json.pilotStatsSkipped, null);
    const row = mod.db.tables.pilot_stats[0];
    assert.equal(row.credits, 42);
    assert.equal(row.mercenary_coins, 9999);
    assert.equal(row.stats_source, 'helper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST от сайта (сессия) пишет и помечает источник web', async () => {
  const { mod, dir } = await buildRoute();
  try {
    // Сессия: authFromRequest возвращает пользователя, body.token нет.
    const res = await postStats(mod, { cmdr: 'Nova', credits: 31337, explore_rank: 6 });
    const json = await res.json();

    assert.equal(json.ok, true);
    assert.equal(json.pilotStatsSkipped, null);
    const row = mod.db.tables.pilot_stats[0];
    assert.equal(row.credits, 31337);
    assert.equal(row.stats_source, 'web');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: мусорные «монеты наёмников» от старого Helper не пишутся', async () => {
  const { mod, dir } = await buildRoute();
  try {
    seedApiToken(mod);
    const res = await postStats(mod, {
      token: HELPER_TOKEN,
      cmdr: 'Nova',
      credits: 10,
      mercenary_coins: 943153188,
    });
    const json = await res.json();

    assert.equal(json.ok, true);
    assert.equal(mod.db.tables.pilot_stats[0].mercenary_coins, undefined);
    assert.equal(mod.db.tables.pilot_stats[0].credits, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: без авторизации — 401', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.db.user = null;
    const res = await postStats(mod, { cmdr: 'Nova', credits: 1 });
    assert.equal(res.status, 401);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('GET: ранги и положение из pilot_stats показываются без capi_profiles', async () => {
  const { mod, dir } = await buildRoute();
  try {
    // Только программа принесла данные: capi_profiles ещё нет.
    mod.db.tables.pilot_stats = [{
      user_id: 'user-1',
      cmdr_name: 'Nova',
      credits: 1000,
      combat_rank: 8,
      trade_rank: 3,
      explore_rank: 5,
      empire_rank: 2,
      federation_rank: 1,
      current_ship: 'Python (Mule)',
      current_system: 'Colonia',
      current_station: 'Jaques Station',
      first_discoveries_count: 40,
      bio_value_cr: 500,
      last_updated: '2026-10-09T10:00:00Z',
    }];

    const res = await mod.stats.GET(new Request('https://colony.test/api/cmdr/stats?cmdr=Nova'));
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.stats.combat_rank, 8);
    assert.equal(json.stats.trade_rank, 3);
    assert.equal(json.stats.explore_rank, 5);
    assert.equal(json.stats.empire_rank, 2);
    assert.equal(json.stats.federation_rank, 1);
    assert.equal(json.stats.current_ship, 'Python (Mule)');
    assert.equal(json.stats.current_system, 'Colonia');
    assert.equal(json.stats.current_station, 'Jaques Station');
    assert.equal(json.stats.credits, 1000);
    assert.equal(json.stats.first_discoveries_count, 40);
    assert.equal(json.stats.bio_value_cr, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('GET: кредиты берутся из pilot_stats, если там есть значение', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.db.tables.pilot_stats = [{ user_id: 'user-1', cmdr_name: 'Nova', credits: 1000 }];
    mod.db.tables.capi_profiles = [{ user_id: 'user-1', cmdr_name: 'Nova', credits: 4200000, combat_rank: 5 }];

    const res = await mod.stats.GET(new Request('https://colony.test/api/cmdr/stats?cmdr=Nova'));
    const json = await res.json();

    assert.equal(json.stats.credits, 1000);
    // А ранги, которых нет в pilot_stats, — из capi_profiles.
    assert.equal(json.stats.combat_rank, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
