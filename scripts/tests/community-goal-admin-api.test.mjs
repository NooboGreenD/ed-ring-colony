import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.INARA_API_KEY = 'test-inara-key';

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init = {}) => new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  }),
};
`;
const HELPER = `${TEST_ROOT}/scripts/tests/helpers/pgliteSupabase.mjs`;
const SUPABASE_STUB = `
import { pgliteClient } from '${HELPER}';
export const state = { db: null, userId: null, log: [] };
export function createServiceClient() { return pgliteClient(state); }
`;
const AUTH_STUB = `
export const authState = { role: 'admin' };
const response = (status) => ({ response: new Response(JSON.stringify({ error: 'Access denied' }), { status }) });
export async function requireAdmin() {
  return authState.role === 'admin'
    ? { actor: { userId: '11111111-1111-4111-8111-111111111111', role: 'admin' } }
    : response(authState.role ? 403 : 401);
}
`;
const INARA_STUB = `
export const inaraState = { goals: [] };
export class InaraClient {
  constructor() {}
  async getCommunityGoals() { return inaraState.goals; }
}
`;
const ENTRY = `
export * as adminRoute from '@/app/api/admin/community-goals/route';
export * as publicRoute from '@/app/api/cg/route';
export { state } from '@/lib/supabaseServer';
export { authState } from '@/lib/billing/auth';
export { inaraState } from '@/lib/inara/client';
`;

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  INSERT INTO auth.users(id) VALUES ('11111111-1111-4111-8111-111111111111');
`);
for (const filename of [
  '20260904040000_cg_inara_integration.sql',
  '20261025090000_cg_inara_details.sql',
  '20261026080000_cg_identity_key.sql',
  '20261026090000_community_goal_commander_reports.sql',
  '20261027090000_community_goal_admin.sql',
]) await db.exec(readFileSync(`${TEST_ROOT}/supabase/migrations/${filename}`, 'utf8'));
await db.exec('SET ROLE service_role');

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
    '@/lib/billing/auth': AUTH_STUB,
    '@/lib/inara/client': INARA_STUB,
  },
  platform: 'node',
});
const mod = await import(bundle);
mod.state.db = db;

test.after(async () => db.close());

function request(method, body) {
  return new Request('https://example.test/api/admin/community-goals', {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function body(response) { return response.json(); }

test('admin API requires the admin role and can create, edit, moderate, and delete local CGs', async () => {
  mod.authState.role = 'moderator';
  assert.equal((await mod.adminRoute.GET(request('GET'))).status, 403);
  mod.authState.role = 'admin';

  const createdResponse = await mod.adminRoute.POST(request('POST', {
    action: 'create', title: 'Colony supply drive', system_name: 'Test System', station_name: 'Port One',
    is_complete: false, is_colonisation_related: true, expiry_date: '2026-12-01T12:00:00Z',
  }));
  assert.equal(createdResponse.status, 201);
  const created = (await body(createdResponse)).goal;
  assert.equal(created.source, 'manual');
  assert.equal(created.is_colonisation_related, true);
  assert.equal(created.moderation_status, 'approved');

  const editedResponse = await mod.adminRoute.PATCH(request('PATCH', {
    id: created.id, title: 'Colony supplies — corrected', moderation_status: 'hidden', admin_note: 'Check text',
  }));
  assert.equal(editedResponse.status, 200);
  const edited = (await body(editedResponse)).goal;
  assert.equal(edited.title, 'Colony supplies — corrected');
  assert.equal(edited.moderation_status, 'hidden');
  assert.equal(edited.admin_note, 'Check text');

  assert.equal((await mod.adminRoute.DELETE(request('DELETE', { id: created.id }))).status, 200);
  const list = await body(await mod.adminRoute.GET(request('GET')));
  assert.equal(list.goals.length, 0);
});

test('Inara sync retains completed records and moderator edits; public API hides unapproved and internal fields', async () => {
  mod.inaraState.goals = [{
    communitygoalName: 'Inara CG original',
    starsystemName: 'Colonia',
    stationName: 'Jaques Station',
    goalExpiry: '2026-10-20T12:00:00Z',
    isCompleted: true,
    tierReached: 'Tier 3',
    tierMax: 'Tier 5',
    contributorsNum: 42,
    contributionsTotal: 5000,
    lastUpdate: '2026-10-21T10:00:00Z',
  }];
  const sync = await body(await mod.adminRoute.POST(request('POST', { action: 'sync' })));
  assert.equal(sync.synced, 1);
  assert.equal(sync.completed, 1);

  const list = await body(await mod.adminRoute.GET(request('GET')));
  const inaraGoal = list.goals.find((goal) => goal.source === 'inara');
  assert.ok(inaraGoal);
  const changed = await body(await mod.adminRoute.PATCH(request('PATCH', {
    id: inaraGoal.id, title: 'Moderator title', moderation_status: 'hidden',
  })));
  assert.equal(changed.goal.title, 'Moderator title');

  mod.inaraState.goals = [{ ...mod.inaraState.goals[0], contributionsTotal: 6000 }];
  await mod.adminRoute.POST(request('POST', { action: 'sync' }));
  const afterSync = await body(await mod.adminRoute.GET(request('GET')));
  const refreshed = afterSync.goals.find((goal) => goal.id === inaraGoal.id);
  assert.equal(refreshed.title, 'Moderator title', 'moderator override survives upstream sync');
  assert.equal(refreshed.contributions_total, 6000, 'unmodified fields continue following Inara');

  const hiddenResponse = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=completed')));
  assert.equal(hiddenResponse.goals.length, 0, 'hidden records are not public');
  await mod.adminRoute.PATCH(request('PATCH', { id: inaraGoal.id, moderation_status: 'approved' }));
  const publicResponse = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=completed')));
  assert.equal(publicResponse.goals.length, 1);
  assert.equal(publicResponse.goals[0].title, 'Moderator title');
  assert.equal('manual_overrides' in publicResponse.goals[0], false);
  assert.equal('moderation_status' in publicResponse.goals[0], false);
});
