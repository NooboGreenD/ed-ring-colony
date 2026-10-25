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
  '20261030090000_community_goal_game_identity.sql',
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

test('admin can moderate the current journal queue in one guarded bulk database update', async () => {
  const svc = mod.createServiceClient();
  const rows = [
    { cg_id: 710001, title: 'Active journal goal', source: 'journal', moderation_status: 'pending', is_complete: false, expiry_date: '2030-01-01T00:00:00Z' },
    { cg_id: 710002, title: 'Expired journal goal', source: 'journal', moderation_status: 'pending', is_complete: false, expiry_date: '2020-01-01T00:00:00Z' },
    { cg_id: 710003, title: 'Completed journal goal', source: 'journal', moderation_status: 'pending', is_complete: true, expiry_date: '2030-01-01T00:00:00Z' },
    { cg_id: 710004, title: 'Active CAPI goal', source: 'capi', moderation_status: 'pending', is_complete: false, expiry_date: '2030-01-01T00:00:00Z' },
    { cg_id: 710005, title: 'Already rejected journal goal', source: 'journal', moderation_status: 'rejected', is_complete: false, expiry_date: '2030-01-01T00:00:00Z' },
    { cg_id: 710006, title: 'Journal goal without an expiry', source: 'journal', moderation_status: 'pending', is_complete: false, expiry_date: null },
  ];
  const { error: insertError } = await svc.from('community_goals').insert(rows);
  assert.equal(insertError, null);

  const response = await mod.adminRoute.POST(request('POST', { action: 'bulk-approve-current-journal' }));
  assert.equal(response.status, 200);
  assert.equal((await body(response)).updated, 1);
  const data = (await svc.from('community_goals').select('cg_id,moderation_status').in('cg_id', rows.map((row) => row.cg_id))).data;
  const status = Object.fromEntries(data.map((row) => [row.cg_id, row.moderation_status]));
  assert.equal(status[710001], 'approved');
  assert.equal(status[710002], 'pending', 'expired history remains out of the bulk approval');
  assert.equal(status[710003], 'pending', 'completed rows remain untouched');
  assert.equal(status[710004], 'pending', 'other sources remain untouched');
  assert.equal(status[710005], 'rejected', 'explicit moderator decisions remain untouched');

  const archivedResponse = await mod.adminRoute.POST(request('POST', { action: 'bulk-archive-stale-journal' }));
  assert.equal(archivedResponse.status, 200);
  assert.equal((await body(archivedResponse)).updated, 3);
  const afterArchive = (await svc.from('community_goals').select('cg_id,moderation_status').in('cg_id', rows.map((row) => row.cg_id))).data;
  const archivedStatus = Object.fromEntries(afterArchive.map((row) => [row.cg_id, row.moderation_status]));
  assert.equal(archivedStatus[710002], 'hidden');
  assert.equal(archivedStatus[710003], 'hidden');
  assert.equal(archivedStatus[710006], 'hidden');
  assert.equal(archivedStatus[710001], 'approved', 'active approved CG is not archived');
  assert.equal(archivedStatus[710004], 'pending', 'other sources are not archived');
  assert.equal(archivedStatus[710005], 'rejected', 'previous decisions are not overwritten');
});

test('Inara sync retains completed records and moderator edits; public API hides unapproved and internal fields', async () => {
  mod.inaraState.goals = [{
    communitygoalGameID: 9124,
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

  await mod.catalog.syncCommunityGoalsFromCapi(mod.createServiceClient(), { goals: [{
    cg_id: 9124,
    title: 'Inara CG original — CAPI wording',
    system_name: 'Colonia',
    station_name: 'Jaques Station',
    description: 'Objective details supplied by Frontier CAPI.',
    objective: 'Deliver supplies.',
  }] });
  const enriched = (await mod.createServiceClient().from('community_goals').select('*').eq('id', inaraGoal.id).single()).data;
  assert.equal(enriched.source, 'inara', 'lower-priority source cannot replace the canonical source');
  assert.equal(enriched.moderation_status, 'hidden', 'enrichment cannot undo moderation');
  assert.equal(enriched.description, 'Objective details supplied by Frontier CAPI.', 'independent source fills a missing description');
  assert.equal(enriched.game_cg_id, 9124, 'independent source supplies the reconciliation ID');

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
  assert.equal(adminState.sources.catalog.capi.records, 2, 'source metrics include CAPI rows already in the catalog');
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

  assert.equal(await mod.catalog.syncCommunityGoalsFromJournal(svc, [
    { ...report, game_cg_id: 429, title: 'Expired historical goal', expiry_date: '2026-10-24T00:00:00Z' },
    { ...report, game_cg_id: 430, title: 'Completed historical goal', is_complete: true },
  ], { now: new Date('2026-10-25T00:00:00Z') }), 0,
    'history-only and already completed CGs must not enter the moderation queue');
  assert.equal(await mod.catalog.syncCommunityGoalsFromJournal(svc, [report], {
    now: new Date('2026-10-25T00:00:00Z'),
  }), 1);
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
    // Same game CGID, but varied catalog text/location from the live source.
    title: `${report.title} — live listing`,
    system_name: report.system_name,
    station_name: 'Galileo Orbital',
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
  assert.equal(upgraded.game_cg_id, report.game_cg_id, 'the source CGID is stored separately from the catalogue ID');
  assert.equal(upgraded.title, `${report.title} — live listing`, 'the best source can refresh changed catalog text');

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
    // A sparse refresh must not erase descriptive text from the prior snapshot.
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
  assert.equal(hiddenAfterRefresh.data.description, 'A Frontier-issued community event.', 'sparse sync keeps the last useful description');
});
