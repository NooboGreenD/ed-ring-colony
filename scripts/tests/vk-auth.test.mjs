import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { createVkFlow, readVkFlow, vkAuthorizeUrl, pkceChallenge, exchangeVkCode, fetchVkUserInfo,
  vkPlaceholderEmail, isVkPlaceholderEmail, canUnlinkVk, vkConfig, VK_FLOW_COOKIE } from '../../src/lib/vkId.ts';
import { resolveVkLogin, linkVkIdentity } from '../../src/lib/vkAccount.ts';

const key = 'test-service-key-not-a-production-secret';
const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'edrc-vk-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'next.mjs'), `
export class NextResponse extends Response {
  constructor(body, init) {
    super(body, init);
    const values = new Map();
    this.cookies = {
      set(name, value, options) { values.set(name, { name, value, ...options }); },
      delete(name) { values.set(name, { name, value: '', maxAge: 0 }); },
      get(name) { return values.get(name); },
    };
  }
  static redirect(url, status = 302) { return new NextResponse(null, { status, headers: { Location: String(url) } }); }
  static json(body, init) { return new NextResponse(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } }); }
}`);
writeFileSync(join(dir, 'ssr.mjs'), `export function createServerClient(url, key, options) {
  globalThis.__vkTest.cookieOptions = options.cookies; return globalThis.__vkTest.client; }`);
writeFileSync(join(dir, 'admin.mjs'), `export function createAdminClient() { return globalThis.__vkTest.admin; }`);
// Admin-panel settings: the test decides whether VK is switched on.
writeFileSync(join(dir, 'settings.mjs'), `export async function resolveVkSettings() {
  const id = (process.env.VK_ID_CLIENT_ID || '').trim();
  const on = globalThis.__vkTest.adminEnabled !== false;
  return { enabled: on && /^\\d+$/.test(id), clientId: id, clientSecret: process.env.VK_ID_CLIENT_SECRET || '', adminEnabled: on };
}
export async function visibleGotrueProviders(list) { return list; }`);

async function bundle(entry, name) {
  const outfile = join(dir, `${name}.mjs`);
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    alias: { 'next/server': join(dir, 'next.mjs'), '@supabase/ssr': join(dir, 'ssr.mjs'),
      '@/lib/supabaseAdmin': join(dir, 'admin.mjs'), '@/lib/authProviders/settings': join(dir, 'settings.mjs'), '@': join(root, 'src') } });
  return import(outfile);
}
const callback = await bundle('src/app/api/auth/vk/callback/route.ts', 'vk-callback');

const info = { user_id: '4242', first_name: 'Иван', last_name: 'Пилот', avatar: 'https://sun.vk.com/a.jpg', email: 'ivan@example.com' };

function fakeFetch({ tokenError, userInfo = info } = {}) {
  const calls = [];
  return Object.assign(async (url, init) => {
    calls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init.body)) });
    if (String(url).endsWith('/oauth2/auth')) {
      return new Response(JSON.stringify(tokenError ? { error: tokenError, error_description: 'secret-detail' } :
        { access_token: 'vk-access', user_id: 4242, state: calls[0].body.state }), { status: tokenError ? 400 : 200 });
    }
    return new Response(JSON.stringify({ user: userInfo }), { status: 200 });
  }, { calls });
}

/** Minimal service-role stub: vk_identities table + admin auth. */
function fakeAdmin({ identities = [], users = [] } = {}) {
  const state = { identities, users, created: [], deleted: [], links: [] };
  const table = () => {
    const filters = {};
    const q = {
      select() { return q; }, eq(col, value) { filters[col] = value; return q; },
      async maybeSingle() { return { data: state.identities.find(row => Object.entries(filters).every(([k, v]) => row[k] === v)) ?? null, error: null }; },
      update(payload) { Object.assign(q, { _payload: payload }); return { eq: async (col, value) => { const row = state.identities.find(r => r[col] === value); if (row) Object.assign(row, payload); return { error: null }; } }; },
      async insert(row) { if (state.identities.some(r => r.vk_user_id === row.vk_user_id)) return { error: { code: '23505' } }; state.identities.push(row); return { error: null }; },
      async upsert(row) { const existing = state.identities.find(r => r.user_id === row.user_id); if (existing) Object.assign(existing, row); else state.identities.push(row); return { error: null }; },
      delete() { return { eq: async (col, value) => { state.identities = state.identities.filter(r => r[col] !== value); return { error: null }; } }; },
    };
    return q;
  };
  state.admin = {
    from: () => table(),
    auth: { admin: {
      listUsers: async () => ({ data: { users: state.users }, error: null }),
      getUserById: async id => ({ data: { user: state.users.find(u => u.id === id) ?? null }, error: null }),
      createUser: async input => { const user = { id: `user-${state.users.length + 1}`, email: input.email, user_metadata: input.user_metadata }; state.users.push(user); state.created.push(input); return { data: { user }, error: null }; },
      deleteUser: async id => { state.deleted.push(id); return { error: null }; },
      generateLink: async ({ email }) => ({ data: { properties: { hashed_token: `hash-${email}` } }, error: null }),
    } },
  };
  return state;
}

function reset({ before = null, admin = fakeAdmin(), fetchImpl = fakeFetch() } = {}) {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://edringcolony.ru';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.edringcolony.ru';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  process.env.AUTH_OAUTH_PROVIDERS = 'discord';
  process.env.VK_ID_CLIENT_ID = '51234567';
  process.env.VK_ID_CLIENT_SECRET = '';
  globalThis.fetch = fetchImpl;
  let session = null;
  const state = { admin, inserts: [], fetchImpl,
    client: {
      auth: {
        getUser: async () => ({ data: { user: session ?? before }, error: null }),
        verifyOtp: async ({ token_hash }) => {
          const email = token_hash.replace(/^hash-/, '');
          const user = admin.users.find(u => u.email === email);
          session = user;
          state.cookieOptions.setAll([{ name: 'sb-test-auth-token', value: 'vk-session', options: { path: '/' } }]);
          return { data: { session: user ? { user } : null }, error: user ? null : { message: 'otp' } };
        },
      },
      from: () => ({ insert: async data => { state.inserts.push(data); return { error: null }; } }),
    } };
  globalThis.__vkTest = { ...state, admin: admin.admin };
  Object.defineProperty(state, 'cookieOptions', { get: () => globalThis.__vkTest.cookieOptions });
  return state;
}
function request({ mode = 'login', userId = null, query, cookie } = {}) {
  const { flow, cookie: value } = createVkFlow(mode, userId, Date.now(), key);
  const req = new Request(`http://web:3000/api/auth/vk/callback?${query ?? `code=c1&device_id=d1&state=${flow.state}`}`,
    { headers: { Host: 'evil.test' } });
  const jar = [{ name: VK_FLOW_COOKIE, value: cookie ?? value }];
  req.cookies = { get: name => jar.find(c => c.name === name), getAll: () => jar };
  return { req, flow };
}

test('VK flow cookie is signed, expiring, PKCE-bound; authorize URL carries S256 challenge', () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  const { flow, cookie } = createVkFlow('login', null, 1000, key);
  assert.deepEqual(readVkFlow(cookie, 2000, key), flow);
  assert.equal(readVkFlow(cookie, 1000 + 11 * 60 * 1000, key), null, 'expired');
  assert.equal(readVkFlow(cookie.slice(0, -2) + 'xx', 2000, key), null, 'tampered');
  assert.throws(() => createVkFlow('link', null), /not_authenticated/);
  const url = new URL(vkAuthorizeUrl(flow, '51234567', 'https://edringcolony.ru'));
  assert.equal(url.origin + url.pathname, 'https://id.vk.com/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://edringcolony.ru/api/auth/vk/callback');
  assert.equal(url.searchParams.get('code_challenge'), pkceChallenge(flow.verifier));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), flow.state);
  assert.equal(vkConfig({ VK_ID_CLIENT_ID: 'abc' }).enabled, false);
  assert.equal(vkConfig({ VK_ID_CLIENT_ID: '1' }).enabled, true);
});

test('token exchange posts device_id + verifier; errors never echo descriptions', async () => {
  const fetchImpl = fakeFetch();
  const { flow } = createVkFlow('login', null, Date.now(), key);
  const token = await exchangeVkCode({ code: 'c', deviceId: 'dev', state: flow.state, flow, clientId: '5', origin: 'https://edringcolony.ru', fetchImpl });
  assert.equal(token.accessToken, 'vk-access');
  assert.deepEqual(fetchImpl.calls[0].body, { grant_type: 'authorization_code', code: 'c', code_verifier: flow.verifier,
    client_id: '5', device_id: 'dev', redirect_uri: 'https://edringcolony.ru/api/auth/vk/callback', state: flow.state });
  const user = await fetchVkUserInfo('vk-access', '5', fetchImpl);
  assert.equal(fetchImpl.calls[1].body.access_token, 'vk-access');
  assert.equal(user.email, 'ivan@example.com');
  const bad = fakeFetch({ tokenError: 'invalid_grant' });
  await assert.rejects(() => exchangeVkCode({ code: 'c', deviceId: 'd', state: flow.state, flow, clientId: '5', fetchImpl: bad }),
    error => error.code === 'expired' && !error.message.includes('secret-detail'));
});

test('placeholder e-mail for VK accounts without mail; unlink needs another real login', () => {
  const email = vkPlaceholderEmail('77', 'https://edringcolony.ru');
  assert.equal(email, 'vk-77@vk.edringcolony.ru');
  assert.ok(isVkPlaceholderEmail(email, 'https://edringcolony.ru'));
  assert.ok(!isVkPlaceholderEmail('ivan@example.com', 'https://edringcolony.ru'));
  const origin = 'https://edringcolony.ru';
  assert.equal(canUnlinkVk({ identities: [{ provider: 'email' }], email, email_confirmed_at: 'x' }, ['discord'], origin), false);
  assert.equal(canUnlinkVk({ identities: [{ provider: 'email' }], email: 'a@b.c', email_confirmed_at: 'x' }, ['discord'], origin), true);
  assert.equal(canUnlinkVk({ identities: [{ provider: 'discord' }], email, email_confirmed_at: null }, ['discord'], origin), true);
  assert.equal(canUnlinkVk({ identities: [{ provider: 'discord' }], email, email_confirmed_at: null }, [], origin), false);
});

test('first VK login creates account + mapping; repeat login reuses it; e-mail collision is refused', async () => {
  const admin = fakeAdmin();
  const first = await resolveVkLogin(admin.admin, info, 'https://edringcolony.ru');
  assert.equal(first.created, true);
  assert.equal(admin.created[0].email, 'ivan@example.com');
  assert.equal(admin.created[0].email_confirm, true);
  assert.equal(admin.identities[0].vk_user_id, '4242');
  const again = await resolveVkLogin(admin.admin, { ...info, first_name: 'Ivan' }, 'https://edringcolony.ru');
  assert.equal(again.created, false);
  assert.equal(again.user.id, first.user.id);
  assert.equal(admin.identities[0].display_name, 'Ivan Пилот');
  const clash = fakeAdmin({ users: [{ id: 'old', email: 'ivan@example.com' }] });
  await assert.rejects(() => resolveVkLogin(clash.admin, info), error => error.code === 'email_exists');
  const noMail = fakeAdmin();
  await resolveVkLogin(noMail.admin, { user_id: '9', first_name: 'X' }, 'https://edringcolony.ru');
  assert.equal(noMail.created[0].email, 'vk-9@vk.edringcolony.ru');
});

test('linking is one VK per account and one account per VK', async () => {
  const admin = fakeAdmin({ identities: [{ user_id: 'u1', vk_user_id: '1' }] });
  await assert.rejects(() => linkVkIdentity(admin.admin, 'u2', { user_id: '1' }), e => e.code === 'already_linked_other');
  await assert.rejects(() => linkVkIdentity(admin.admin, 'u1', { user_id: '2' }), e => e.code === 'already_linked');
  await linkVkIdentity(admin.admin, 'u1', { user_id: '1', first_name: 'Same' });
  await linkVkIdentity(admin.admin, 'u2', { user_id: '2' });
  assert.equal(admin.identities.length, 2);
});

test('callback: login mints a session via magic-link hash, creates the profile, redirects to /account', async () => {
  const state = reset();
  const { req } = request();
  const response = await callback.GET(req);
  assert.equal(response.headers.get('location'), 'https://edringcolony.ru/account?provider=vk');
  assert.equal(response.cookies.get('sb-test-auth-token').value, 'vk-session');
  assert.equal(response.cookies.get(VK_FLOW_COOKIE).maxAge, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(state.inserts[0].id, 'user-1');
  assert.equal(state.inserts[0].cmdr_name, 'Иван Пилот');
});

test('callback: state mismatch, missing device_id, denial and expired cookie never create a session', async () => {
  for (const [query, code] of [['code=c1&device_id=d1&state=wrong', 'state_mismatch'], ['code=c1&state=STATE', 'no_code'],
    ['error=access_denied&state=STATE', 'cancelled']]) {
    const state = reset();
    const { req, flow } = request({ query: query.replace('STATE', 'x') });
    const response = await callback.GET(req.url.includes('state=x') ? request({ query: query.replace('STATE', flow.state) }).req : req);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.pathname, '/login');
    assert.equal(location.searchParams.get('oauth_error'), code, query);
    assert.equal(response.cookies.get('sb-test-auth-token'), undefined);
    assert.equal(state.admin.created.length, 0);
  }
  reset();
  const { req } = request({ cookie: 'garbage.garbage' });
  const response = await callback.GET(req);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('oauth_error'), 'expired');
});

test('callback: link binds VK to the signed-in UUID and refuses a switched account', async () => {
  const admin = fakeAdmin();
  reset({ before: { id: 'pilot-a' }, admin });
  const { req } = request({ mode: 'link', userId: 'pilot-a' });
  const response = await callback.GET(req);
  assert.equal(response.headers.get('location'), 'https://edringcolony.ru/account?oauth=linked&provider=vk');
  assert.deepEqual(admin.identities.map(r => [r.user_id, r.vk_user_id]), [['pilot-a', '4242']]);
  assert.equal(response.cookies.get('sb-test-auth-token'), undefined, 'link never rewrites session cookies');

  reset({ before: { id: 'pilot-b' }, admin: fakeAdmin() });
  const mismatch = await callback.GET(request({ mode: 'link', userId: 'pilot-a' }).req);
  assert.equal(new URL(mismatch.headers.get('location')).searchParams.get('oauth_error'), 'account_mismatch');

  const taken = fakeAdmin({ identities: [{ user_id: 'someone', vk_user_id: '4242' }] });
  reset({ before: { id: 'pilot-a' }, admin: taken });
  const conflict = await callback.GET(request({ mode: 'link', userId: 'pilot-a' }).req);
  assert.equal(new URL(conflict.headers.get('location')).searchParams.get('oauth_error'), 'already_linked_other');
});

test('callback: VK disabled or e-mail already registered ends without a session', async () => {
  reset({ admin: fakeAdmin({ users: [{ id: 'old', email: 'ivan@example.com' }] }) });
  const response = await callback.GET(request().req);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('oauth_error'), 'email_exists');
  reset();
  process.env.VK_ID_CLIENT_ID = '';
  const off = await callback.GET(request().req);
  assert.equal(new URL(off.headers.get('location')).searchParams.get('oauth_error'), 'not_configured');
  reset();
  globalThis.__vkTest.adminEnabled = false;
  const hidden = await callback.GET(request().req);
  assert.equal(new URL(hidden.headers.get('location')).searchParams.get('oauth_error'), 'not_configured', 'admin toggle off = provider off');
});

test('admin settings: VK hidden by default, secrets never exposed, toggle + client id gate the button', async () => {
  process.env.BILLING_STORAGE = 'file';
  process.env.BILLING_DATA_FILE = join(dir, 'billing_store.json'); // never touch the tracked data file
  process.env.VK_ID_CLIENT_ID = '';
  const { getAuthProviderSettings, updateAuthProviderSettings, publicAuthProviderSettings, resolveVkSettings, visibleGotrueProviders } =
    await bundle('src/lib/authProviders/settings.ts', 'settings-real');
  const { resetBillingAdapter } = await bundle('src/lib/billing/storage.ts', 'storage-real');
  resetBillingAdapter();
  const initial = await getAuthProviderSettings();
  assert.equal(initial.vk.enabled, false);
  assert.equal(initial.discord.enabled, true);
  assert.equal((await resolveVkSettings({})).enabled, false);
  await updateAuthProviderSettings({ vk: { enabled: true, client_id: '51234567', client_secret: 'top-secret' }, discord: { enabled: false } });
  try {
    const after = await getAuthProviderSettings();
    assert.equal(after.vk.client_secret, 'top-secret');
    const pub = publicAuthProviderSettings(after);
    assert.equal(pub.vk.has_secret, true);
    assert.equal(JSON.stringify(pub).includes('top-secret'), false);
    const resolved = await resolveVkSettings({});
    assert.deepEqual([resolved.enabled, resolved.clientId, resolved.clientSecret], [true, '51234567', 'top-secret']);
    assert.deepEqual(await visibleGotrueProviders(['discord', 'google']), ['google']);
    await updateAuthProviderSettings({ vk: { clear_secret: true } });
    assert.equal((await getAuthProviderSettings()).vk.client_secret, undefined);
  } finally {
    await updateAuthProviderSettings({ vk: { enabled: false, client_id: '', clear_secret: true }, discord: { enabled: true } });
    resetBillingAdapter();
  }
});
