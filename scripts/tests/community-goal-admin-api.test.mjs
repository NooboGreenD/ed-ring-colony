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
const CAPI_SESSION_STUB = `
export const capiState = { goals: [], calls: 0 };
export async function capiSession() {
  return {
    async run(callback) {
      capiState.calls += 1;
      return callback({ getCommunityGoals: async () => ({ goals: capiState.goals }) });
    },
  };
}
`;
const ENTRY = `
export * as adminRoute from '@/app/api/admin/community-goals/route';
export * as publicRoute from '@/app/api/cg/route';
export { state, createServiceClient } from '@/lib/supabaseServer';
export { authState } from '@/lib/billing/auth';
export { inaraState } from '@/lib/inara/client';
export { capiState } from '@/lib/capi/session';
export * as catalog from '@/lib/communityGoalCatalog';
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
  '20261028090000_community_goal_fallback_sources.sql',
]) await db.exec(readFileSync(`${TEST_ROOT}/supabase/migrations/${filename}`, 'utf8'));
await db.exec(`
  CREATE TABLE public.capi_tokens(
    user_id uuid PRIMARY KEY REFERENCES auth.users(id),
    is_active boolean NOT NULL DEFAULT true,
    access_token text NOT NULL,
    refresh_token text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  GRANT ALL ON public.capi_tokens TO service_role;
`);
await db.exec('SET ROLE service_role');

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
    '@/lib/billing/auth': AUTH_STUB,
    '@/lib/inara/client': INARA_STUB,
    '@/lib/capi/session': CAPI_SESSION_STUB,
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

test('admin syncs Frontier CAPI independently through the site-owned active binding and reports source freshness', async () => {
  const unavailable = await mod.adminRoute.POST(request('POST', { action: 'sync-capi' }));
  const unavailableBody = await body(unavailable);
  assert.equal(unavailable.status, 409, JSON.stringify(unavailableBody));
  assert.match(unavailableBody.error, /Нет активной Frontier OAuth-привязки сайта/);

  const svc = mod.createServiceClient();
  await svc.from('capi_tokens').insert({
    user_id: '11111111-1111-4111-8111-111111111111',
    is_active: true,
    access_token: 'server-only-access-token',
    refresh_token: 'server-only-refresh-token',
  });
  mod.capiState.goals = [{
    cg_id: 9123,
    title: 'CAPI independent-source goal',
    system_name: 'Colonia',
    station_name: 'Jaques Station',
    expiry_date: '2026-12-01T12:00:00Z',
    objective: 'Deliver supplies.',
    contributions_total: 12345,
  }];

  const response = await mod.adminRoute.POST(request('POST', { action: 'sync-capi' }));
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.source, 'capi');
  assert.equal(result.received, 1);
  assert.equal(result.synced, 1);
  assert.equal(mod.capiState.calls, 1);
  const row = (await svc.from('community_goals').select('*').eq('title', 'CAPI independent-source goal').single()).data;
  assert.equal(row.source, 'capi');
  assert.equal(row.moderation_status, 'approved');

  const adminState = await body(await mod.adminRoute.GET(request('GET')));
  assert.equal(adminState.sources.catalog.capi.records, 1);
  assert.ok(adminState.sources.catalog.capi.latestAt);
  assert.equal(adminState.sources.helperReports.latestAt, null);
});

test('Frontier CAPI fills the catalogue without Inara and promotes matching journal discoveries safely', async () => {
  const svc = mod.createServiceClient();
  const report = {
    game_cg_id: 428,
    title: 'Frontier Colony Supply Initiative',
    system_name: 'Sol',
    station_name: 'Galileo',
    expiry_date: '2026-11-09T16:00:00Z',
    current_total: 1_234_567,
    player_contribution: 12_345,
    tier_reached: 3,
    tier_max: 5,
    contributors_num: 240,
    is_complete: false,
    observed_at: '2026-10-24T12:00:00Z',
  };

  assert.equal(await mod.catalog.syncCommunityGoalsFromJournal(svc, [report]), 1);
  const journalRowResult = await svc.from('community_goals').select('*').eq('title', report.title).single();
  assert.equal(journalRowResult.error, null);
  const journalRow = journalRowResult.data;
  assert.equal(journalRow.source, 'journal');
  assert.equal(journalRow.moderation_status, 'pending');
  assert.equal(JSON.stringify(journalRow.raw_data).includes('player_contribution'), false, 'private contribution data is not copied to the public catalogue');

  const beforeCapi = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=active')));
  assert.equal(beforeCapi.goals.some((goal) => goal.title === report.title), false, 'journal-only discoveries are not public before review');

  await svc.from('community_goals').update({ manual_overrides: { title: 'Moderator-approved title' } }).eq('id', journalRow.id);
  assert.equal(await mod.catalog.syncCommunityGoalsFromCapi(svc, { goals: [{
    cg_id: 428,
    title: report.title,
    system_name: report.system_name,
    station_name: report.station_name,
    expiry_date: report.expiry_date,
    description: 'A Frontier-issued community event.',
    objective: 'Deliver supplies.',
    reward: 'Credits and recognition.',
    tier_current: 3,
    tier_max: 5,
    contributors: 240,
    contributions_total: 1_234_567,
    is_complete: false,
  }] }), 1);

  const upgradedResult = await svc.from('community_goals').select('*').eq('id', journalRow.id).single();
  const upgraded = upgradedResult.data;
  assert.equal(upgraded.source, 'capi');
  assert.equal(upgraded.moderation_status, 'approved', 'authenticated CAPI data clears journal-only pending status');
  assert.deepEqual(upgraded.manual_overrides, { title: 'Moderator-approved title' });
  assert.equal(upgraded.cg_id, journalRow.cg_id, 'cross-source identity keeps one catalogue row');

  const afterCapi = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=active')));
  const publicGoal = afterCapi.goals.find((goal) => goal.cg_id === journalRow.cg_id);
  assert.ok(publicGoal);
  assert.equal(publicGoal.title, 'Moderator-approved title');
  assert.equal(publicGoal.description, 'A Frontier-issued community event.');

  await svc.from('community_goals').update({ moderation_status: 'hidden' }).eq('id', journalRow.id);
  await mod.catalog.syncCommunityGoalsFromCapi(svc, { goals: [{
    cg_id: 428,
    title: report.title,
    system_name: report.system_name,
    station_name: report.station_name,
    expiry_date: report.expiry_date,
    description: 'A refreshed description.',
    objective: 'Deliver supplies.',
    reward: 'Credits and recognition.',
    tier_current: 4,
    tier_max: 5,
    contributors: 260,
    contributions_total: 1_500_000,
    is_complete: false,
  }] });
  const hiddenAfterRefresh = await svc.from('community_goals').select('*').eq('id', journalRow.id).single();
  assert.equal(hiddenAfterRefresh.data.moderation_status, 'hidden', 'automatic refresh never overrides a moderator decision');
});
