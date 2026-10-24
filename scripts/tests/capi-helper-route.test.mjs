import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let esbuild = null;
try { esbuild = await import('esbuild'); } catch { /* optional dev dependency */ }
const maybe = esbuild ? test : test.skip;

const token = 'project-token-from-helper';
const tokenHash = createHash('sha256').update(token).digest('hex');

maybe('CAPI helper route requires website binding and never exposes Frontier tokens', async (t) => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  const dir = mkdtempSync(join(tmpdir(), 'capi-helper-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const source = `
    const db = (globalThis.__capiDb ||= { tables: {} });
    const rows = (table) => (db.tables[table] ||= []);
    function query(table) {
      const filters = [];
      const q = {
        select: () => q,
        eq: (column, value) => { filters.push([column, value]); return q; },
        maybeSingle: async () => ({ data: rows(table).find(row => filters.every(([k,v]) => row[k] === v)) || null, error: null }),
      };
      return q;
    }
    export function createClient() { return { from: query }; }
  `;
  const nextServer = `export const NextResponse = { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }) };`;
  const rateLimit = `export function checkRateLimit(key, max = 5) { const n = globalThis.__capiLimits.get(key) || 0; if (n >= max) return false; globalThis.__capiLimits.set(key, n + 1); return true; }`;
  const syncPilot = `
    export async function syncCapiPilot(_svc, _userId, _row, options) { globalThis.__capiSyncCalls++; globalThis.__capiSyncOptions = options; return globalThis.__capiSyncResult; }
    export async function markCapiTokenBroken() {}
  `;
  const tempEntry = join(dir, 'entry.ts');
  writeFileSync(tempEntry, `export * as helper from '${join(process.cwd(), 'src/app/api/capi/helper/route.ts')}';`);
  globalThis.__capiLimits = new Map();
  globalThis.__capiSyncCalls = 0;
  globalThis.__capiSyncResult = {
    ok: true, cmdrName: 'Hunter', profileSaved: true, journalStatus: 'empty',
    eventsImported: 0, eventsDuplicate: 0, eventsSkipped: 0, warnings: [],
    binding: { status: 'linked', displayName: 'Hunter', nameMismatch: false },
  };

  const result = await esbuild.build({
    entryPoints: [tempEntry], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{
      name: 'capi-test-stubs',
      setup(build) {
        build.onResolve({ filter: /^next\/server$/ }, () => ({ path: 'next-server', namespace: 'stub' }));
        build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'supabase', namespace: 'stub' }));
        build.onResolve({ filter: /^@\/lib\/supabaseServerUrl$/ }, () => ({ path: 'supabase-url', namespace: 'stub' }));
        build.onResolve({ filter: /^@\/lib\/rateLimit$/ }, () => ({ path: 'rate-limit', namespace: 'stub' }));
        build.onResolve({ filter: /^@\/lib\/capi\/syncPilot$/ }, () => ({ path: 'sync-pilot', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          if (args.path === 'next-server') return { contents: nextServer, loader: 'js' };
          if (args.path === 'supabase') return { contents: source, loader: 'js' };
          if (args.path === 'supabase-url') return { contents: `export function getServerSupabaseUrl(){ return 'https://example.supabase.co'; }`, loader: 'js' };
          if (args.path === 'rate-limit') return { contents: rateLimit, loader: 'js' };
          return { contents: syncPilot, loader: 'js' };
        });
      },
    }],
  });
  const output = join(dir, 'route.mjs');
  writeFileSync(output, result.outputFiles[0].text);
  // The bundled client captures this object when the route module loads.
  globalThis.__capiDb = { tables: {} };
  const module = await import(`${pathToFileURL(output).href}?t=${Date.now()}`);
  t.after(() => { delete globalThis.__capiDb; delete globalThis.__capiLimits; delete globalThis.__capiSyncCalls; delete globalThis.__capiSyncResult; });

  // The bundled Supabase test client reads this global table map.
  const setTables = (tables) => { globalThis.__capiDb.tables = tables; };
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const unlinkedTables = {
    api_tokens: [{ token_hash: tokenHash, user_id: 'user-1', is_revoked: false }],
    capi_tokens: [], capi_profiles: [],
  };
  setTables(unlinkedTables);
  let response = await module.helper.GET(new Request('https://colony.test/api/capi/helper', auth));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).linked, false);

  response = await module.helper.POST(new Request('https://colony.test/api/capi/helper', { ...auth, method: 'POST' }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).needsSiteLink, true);
  assert.equal(globalThis.__capiSyncCalls, 0);

  const linkedTables = {
    api_tokens: unlinkedTables.api_tokens,
    capi_tokens: [{ user_id: 'user-1', access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', is_active: true, platform: 'steam', cmdr_name: 'Hunter' }],
    capi_profiles: [{ user_id: 'user-1', cmdr_name: 'Hunter', credits: 42, current_system: 'Sol', last_updated: '2026-10-24T12:00:00Z' }],
  };
  setTables(linkedTables);
  response = await module.helper.GET(new Request('https://colony.test/api/capi/helper', auth));
  const status = await response.json();
  assert.equal(status.linked, true);
  assert.equal(status.profile.credits, 42);
  assert.equal(JSON.stringify(status).includes('SECRET_ACCESS'), false);
  assert.equal(JSON.stringify(status).includes('SECRET_REFRESH'), false);

  response = await module.helper.POST(new Request('https://colony.test/api/capi/helper', { ...auth, method: 'POST' }));
  assert.equal(response.status, 200);
  const synced = await response.json();
  assert.equal(synced.ok, true);
  assert.equal(synced.cmdrName, 'Hunter');
  assert.equal(JSON.stringify(synced).includes('SECRET_ACCESS'), false);
  assert.equal(JSON.stringify(synced).includes('SECRET_REFRESH'), false);
  assert.equal(globalThis.__capiSyncCalls, 1);
  assert.deepEqual(globalThis.__capiSyncOptions, { skipJournal: true, skipCommunityGoals: true });

  response = await module.helper.GET(new Request('https://colony.test/api/capi/helper'));
  assert.equal(response.status, 401);
});
