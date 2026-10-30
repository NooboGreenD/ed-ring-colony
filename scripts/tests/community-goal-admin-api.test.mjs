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
  '20261031090000_community_goal_progress_freshness.sql',
  '20261101090000_community_goal_progress_history.sql',
  '20261102090000_frontier_public_community_goals.sql',
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
globalThis.fetch = async () => new Response(JSON.stringify({ activeInitiatives: [] }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

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
    tier_current: 4,
    tier_max: 5,
    contributors: 43,
    contributions_total: 5500,
  }] });
  const enriched = (await mod.createServiceClient().from('community_goals').select('*').eq('id', inaraGoal.id).single()).data;
  assert.equal(enriched.source, 'inara', 'lower-priority source cannot replace the canonical source');
  assert.equal(enriched.moderation_status, 'hidden', 'enrichment cannot undo moderation');
  assert.equal(enriched.description, 'Objective details supplied by Frontier CAPI.', 'independent source fills a missing description');
  assert.equal(enriched.game_cg_id, 9124, 'independent source supplies the reconciliation ID');
  assert.equal(enriched.tier_current, 4, 'newer CAPI snapshot refreshes progress despite Inara text priority');
  assert.equal(enriched.contributors, 43);
  assert.equal(enriched.contributions_total, 5500);
  assert.equal(enriched.progress_source, 'capi');
  assert.ok(enriched.progress_updated_at);
  const progressHistory = await mod.createServiceClient().from('community_goal_progress_history').select('*').eq('cg_id', inaraGoal.cg_id);
  assert.equal(progressHistory.error, null);
  assert.equal(progressHistory.data.length, 1, 'multiple sources in one hour share one chart bucket');
  assert.equal(progressHistory.data[0].source, 'capi');
  assert.equal(progressHistory.data[0].contributions_total, 5500);

  mod.inaraState.goals = [{ ...mod.inaraState.goals[0], contributionsTotal: 6000 }];
  await mod.adminRoute.POST(request('POST', { action: 'sync' }));
  const afterSync = await body(await mod.adminRoute.GET(request('GET')));
  const refreshed = afterSync.goals.find((goal) => goal.id === inaraGoal.id);
  assert.equal(refreshed.title, 'Moderator title', 'moderator override survives upstream sync');
  assert.equal(refreshed.contributions_total, 5500, 'older Inara progress does not overwrite the newer CAPI snapshot');
  assert.equal(refreshed.progress_source, 'capi');

  const hiddenResponse = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=completed')));
  assert.equal(hiddenResponse.goals.length, 0, 'hidden records are not public');
  await mod.adminRoute.PATCH(request('PATCH', { id: inaraGoal.id, moderation_status: 'approved' }));
  const publicResponse = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=completed')));
  assert.equal(publicResponse.goals.length, 1);
  assert.equal(publicResponse.goals[0].title, 'Moderator title');
  assert.equal(publicResponse.goals[0].progress_source, 'capi');
  assert.ok(publicResponse.goals[0].progress_updated_at);
  assert.equal(publicResponse.goals[0].contribution_history.length, 1);
  assert.equal(publicResponse.goals[0].contribution_history[0].contributions_total, 5500);
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

test('public Frontier initiatives populate the shared catalogue and source global progress history', async () => {
  const svc = mod.createServiceClient();
  const payload = { activeInitiatives: [{
    id: 99124,
    title: 'Frontier public description test',
    bulletin: 'Public bulletin text from the Frontier website.',
    objective: 'Deliver certified materials.',
    qty: 120000,
    target_qty: 250000,
    expiry: '2030-06-01 12:00:00',
    starsystem_name: 'Test System',
    market_name: 'Test Port',
  }] };

  assert.equal(await mod.catalog.syncCommunityGoalsFromFrontier(svc, payload), 1);
  const stored = (await svc.from('community_goals').select('*').eq('game_cg_id', 99124).single()).data;
  assert.equal(stored.source, 'frontier');
  assert.equal(stored.description, 'Public bulletin text from the Frontier website.');
  assert.equal(stored.objective, 'Deliver certified materials.');
  assert.equal(stored.contributions_total, 120000);
  assert.equal(stored.contributions_target, 250000);
  assert.equal(stored.target_source, 'frontier');
  assert.equal(stored.progress_source, 'frontier');

  const history = await svc.from('community_goal_progress_history').select('*').eq('cg_id', stored.cg_id);
  assert.equal(history.error, null);
  assert.equal(history.data.length, 1);
  assert.equal(history.data[0].source, 'frontier');
  assert.equal(history.data[0].contributions_total, 120000);

  const publicResult = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=active')));
  const visible = publicResult.goals.find((goal) => goal.cg_id === stored.cg_id);
  assert.equal(visible.description, 'Public bulletin text from the Frontier website.');
  assert.equal(visible.contributions_target, 250000);
  assert.equal('raw_data' in visible, false);

  await svc.from('community_goals').update({
    source: 'inara',
    description: 'Existing Inara description remains canonical.',
    objective: 'Existing Inara objective.',
  }).eq('cg_id', stored.cg_id);
  await mod.catalog.syncCommunityGoalsFromFrontier(svc, { activeInitiatives: [{
    ...payload.activeInitiatives[0],
    bulletin: 'A later public bulletin should not overwrite the richer Inara text.',
    objective: 'A later public objective.',
    qty: 130000,
  }] });
  const preserved = (await svc.from('community_goals').select('*').eq('cg_id', stored.cg_id).single()).data;
  assert.equal(preserved.source, 'inara', 'public Frontier source does not downgrade Inara as the canonical text source');
  assert.equal(preserved.description, 'Existing Inara description remains canonical.');
  assert.equal(preserved.objective, 'Existing Inara objective.');
  assert.equal(preserved.contributions_total, 130000, 'Frontier public snapshots can still refresh global progress');
});

test('admin source sync uses public Frontier initiatives without an Inara key', async () => {
  const previousFetch = globalThis.fetch;
  const previousInaraKey = process.env.INARA_API_KEY;
  process.env.INARA_API_KEY = '';
  globalThis.fetch = async () => new Response(JSON.stringify({ activeInitiatives: [{
    id: 99125,
    title: 'Admin public Frontier sync test',
    bulletin: 'Description available without pilot binding.',
    objective: 'Deliver scientific equipment.',
    qty: 42,
    target_qty: 100,
    expiry: '2030-07-01T12:00:00Z',
    starsystem_name: 'Independent System',
    market_name: 'Independent Port',
  }] }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const response = await mod.adminRoute.POST(request('POST', { action: 'sync' }));
    const result = await body(response);
    assert.equal(response.status, 200);
    assert.equal(result.sources.frontier.received, 1);
    assert.equal(result.sources.frontier.synced, 1);
    assert.equal(result.sources.inara.skipped, true);
    const stored = (await mod.createServiceClient().from('community_goals')
      .select('*').eq('game_cg_id', 99125).single()).data;
    assert.equal(stored.description, 'Description available without pilot binding.');
    assert.equal(stored.source, 'frontier');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousInaraKey === undefined) delete process.env.INARA_API_KEY;
    else process.env.INARA_API_KEY = previousInaraKey;
  }
});

test('expired goals are completed without a source flag and leave the active filter', async () => {
  const svc = mod.createServiceClient();
  const now = Date.now();
  const past = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const { error } = await svc.from('community_goals').insert([
    { cg_id: 880001, title: 'Expired CG without a flag', source: 'manual', moderation_status: 'approved', is_complete: false, expiry_date: past },
    { cg_id: 880002, title: 'Still running CG', source: 'manual', moderation_status: 'approved', is_complete: false, expiry_date: future },
    { cg_id: 880003, title: 'CG without an expiry', source: 'manual', moderation_status: 'approved', is_complete: false, expiry_date: null },
  ]);
  assert.equal(error, null);

  const active = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=active')));
  const activeTitles = active.goals.map((goal) => goal.title);
  assert.equal(activeTitles.includes('Expired CG without a flag'), false, 'expired goal is not active');
  assert.equal(activeTitles.includes('Still running CG'), true);
  assert.equal(activeTitles.includes('CG without an expiry'), true, 'a goal without a deadline stays active');

  const completed = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=completed')));
  const completedGoal = completed.goals.find((goal) => goal.title === 'Expired CG without a flag');
  assert.ok(completedGoal, 'expired goal appears in the completed filter');
  assert.equal(completedGoal.is_complete, true, 'the public payload reports the derived state');
  assert.equal(completed.goals.some((goal) => goal.title === 'Still running CG'), false);

  const all = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=all')));
  assert.ok(all.goals.length >= active.goals.length + completed.goals.length - 1, 'filter=all returns both lists');

  // The admin sync closes expired rows in the database instead of waiting for
  // an upstream `is_complete` that Frontier never sends for dropped goals.
  const syncResponse = await mod.adminRoute.POST(request('POST', { action: 'sync' }));
  const syncResult = await body(syncResponse);
  assert.equal(syncResponse.status, 200);
  assert.ok(syncResult.expired >= 1, `expiry sweep reports the closed rows: ${JSON.stringify(syncResult)}`);
  const stored = (await svc.from('community_goals').select('*').eq('cg_id', 880001).single()).data;
  assert.equal(stored.is_complete, true);
  const live = (await svc.from('community_goals').select('*').eq('cg_id', 880002).single()).data;
  assert.equal(live.is_complete, false, 'running goals stay active');

  const admin = await body(await mod.adminRoute.GET(request('GET')));
  const expectedCompleted = admin.goals.filter((goal) => goal.is_complete === true
    || (typeof goal.expiry_date === 'string' && Date.parse(goal.expiry_date) <= Date.now())).length;
  assert.equal(admin.counts.completed, expectedCompleted, 'admin counters use the same completion rule as the public page');
});

test('tier-only progress updates are written to the contribution history', async () => {
  const svc = mod.createServiceClient();
  const base = {
    cg_id: 882001,
    title: 'Tier history CG',
    system_name: 'Test System',
    station_name: 'Test Port',
    expiry_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  await mod.catalog.syncCommunityGoalsFromCapi(svc, { goals: [{
    ...base,
    contributions_total: 1000,
    contributors: 10,
  }] });

  const stored = (await svc.from('community_goals').select('*').eq('game_cg_id', 882001).single()).data;
  let history = (await svc.from('community_goal_progress_history').select('*').eq('cg_id', stored.cg_id)).data;
  assert.equal(history.length, 1);
  assert.equal(history[0].tier_current, null);

  // Same hour, same total: only the tier/participants moved. This is exactly
  // the update that used to leave the chart flat.
  await mod.catalog.syncCommunityGoalsFromCapi(svc, { goals: [{
    ...base,
    contributions_total: 1000,
    contributors: 12,
    tier_current: 3,
    tier_max: 5,
  }] });

  history = (await svc.from('community_goal_progress_history').select('*').eq('cg_id', stored.cg_id)).data;
  assert.equal(history.length, 1, 'snapshots inside one hour share a bucket');
  assert.equal(history[0].tier_current, 3, 'the tier change is recorded without a new total');
  assert.equal(history[0].tier_max, 5);
  assert.equal(history[0].contributors, 12);
  assert.equal(history[0].contributions_total, 1000, 'the existing total is carried into the snapshot');

  const publicResult = await body(await mod.publicRoute.GET(new Request('https://example.test/api/cg?filter=active')));
  const publicGoal = publicResult.goals.find((goal) => goal.cg_id === stored.cg_id);
  assert.ok(publicGoal);
  assert.equal(publicGoal.contribution_history.length, 1);
  assert.equal(publicGoal.contribution_history[0].tier_current, 3, 'the public API exposes tiers for the chart');
  assert.equal(publicGoal.contribution_history[0].contributions_total, 1000);
});
