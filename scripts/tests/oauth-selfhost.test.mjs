import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { createOAuthFlow, readOAuthFlow, OAUTH_FLOW_COOKIE, OAUTH_FLOW_TTL } from '../../src/lib/oauthFlow.ts';
import { getSiteUrl } from '../../src/lib/siteUrl.ts';
import { enabledOAuthProviders, oauthErrorMessage, canUnlinkOAuthIdentity } from '../../src/lib/oauthProviders.ts';

const key = 'test-service-key-not-a-production-secret';
const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'edrc-auth-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'next.mjs'), `
export class NextResponse extends Response {
  cookies = new Map();
  constructor(body, init) {
    super(body, init);
    const values = this.cookies;
    this.cookies = {
      set(name, value, options) { values.set(name, { name, value, ...options }); },
      delete(name) { values.set(name, { name, value: '', maxAge: 0 }); },
      get(name) { return values.get(name); },
    };
  }
  static next() { return new NextResponse(null, { status: 200 }); }
  static redirect(url, status = 302) { return new NextResponse(null, { status, headers: { Location: String(url) } }); }
  static json(body, init) { return new NextResponse(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } }); }
}
`);
writeFileSync(join(dir, 'ssr.mjs'), `export function createServerClient(url, key, options) {
  globalThis.__authTest.cookieOptions = options.cookies;
  globalThis.__authTest.clients++;
  return globalThis.__authTest.client;
}`);
writeFileSync(join(dir, 'server.mjs'), `export function createClient() { return globalThis.__authTest.client; }`);
writeFileSync(join(dir, 'headers.mjs'), `export function cookies() { return globalThis.__authTest.cookieStore; }`);

async function bundle(entry, name) {
  const outfile = join(dir, `${name}.mjs`);
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    alias: { 'next/server': join(dir, 'next.mjs'), '@supabase/ssr': join(dir, 'ssr.mjs'),
      'next/headers': join(dir, 'headers.mjs'), '@/lib/supabaseServer': join(dir, 'server.mjs'), '@': join(root, 'src') } });
  return import(outfile);
}
const callback = await bundle('src/app/api/auth/callback/route.ts', 'callback');
const legacyCallback = await bundle('src/app/auth/callback/route.ts', 'legacy-callback');
const actions = await bundle('src/app/login/actions.ts', 'actions');
const middleware = await bundle('src/proxy.ts', 'proxy');

function reset({ before = { id: 'pilot-a' }, afterUser, exchangeError = false, duplicateProfile = true } = {}) {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://edringcolony.ru';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.edringcolony.ru';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  process.env.AUTH_OAUTH_PROVIDERS = 'discord,google,github';
  let exchanged = false;
  const user = afterUser ?? { id: 'pilot-a', identities: [{ id: 'discord-id', provider: 'discord' }] };
  const state = { clients: 0, exchanged: 0, inserts: [], links: [], logins: [],
    cookieStore: { values: new Map(), set(name, value, options) { this.values.set(name, { value, options }); },
      delete(name) { this.values.delete(name); } },
    client: {
      auth: {
        getUser: async () => ({ data: { user: exchanged ? user : before }, error: null }),
        exchangeCodeForSession: async () => {
          state.exchanged++; exchanged = true;
          state.cookieOptions.setAll([{ name: 'sb-test-auth-token', value: 'new-session', options: { path: '/' } }]);
          return { data: { session: exchangeError ? null : { user } }, error: exchangeError ? { message: 'bad verifier' } : null };
        },
        linkIdentity: async input => { state.links.push(input); return { data: { url: 'https://discord.com/oauth2/authorize' } }; },
        signInWithOAuth: async input => { state.logins.push(input); return { data: { url: 'https://discord.com/oauth2/authorize' } }; },
      },
      from: () => ({ insert: async data => { state.inserts.push(data); return { error: duplicateProfile ? { code: '23505' } : null }; } }),
    },
  };
  globalThis.__authTest = state;
  return state;
}
function request({ mode = 'link', userId = 'pilot-a', flow, query = 'code=test-code' } = {}) {
  const value = flow ?? createOAuthFlow('discord', mode, mode === 'link' ? userId : null, Date.now(), key);
  const req = new Request(`http://web:3000/api/auth/callback?${query}`, {
    headers: { Host: 'evil.test', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'http' },
  });
  const jar = [{ name: OAUTH_FLOW_COOKIE, value }, { name: 'sb-test-auth-token-code-verifier', value: 'test-verifier' }];
  req.cookies = { get: name => jar.find(cookie => cookie.name === name), getAll: () => jar };
  return req;
}

test('site origin is canonical and rejects insecure/userinfo/redirect injection', () => {
  assert.equal(getSiteUrl('https://edringcolony.ru/'), 'https://edringcolony.ru');
  assert.equal(getSiteUrl('http://localhost:3000'), 'http://localhost:3000');
  for (const url of ['http://edringcolony.ru', 'https://user@evil.test', 'https://host.test/a', 'https://host.test?x=1']) {
    assert.throws(() => getSiteUrl(url));
  }
});

test('OAuth flow is signed, bounded in time and binds linking to the existing UUID', () => {
  const now = Date.now();
  const value = createOAuthFlow('discord', 'link', 'pilot-a', now, key);
  assert.equal(readOAuthFlow(value, now, key).userId, 'pilot-a');
  assert.equal(readOAuthFlow(value, now + OAUTH_FLOW_TTL * 1000, key), null);
  assert.equal(readOAuthFlow(value + 'x', now, key), null);
  assert.equal(readOAuthFlow(value.split('.')[0] + '.' + 'я'.repeat(43), now, key), null);
  assert.equal(readOAuthFlow(value, now, 'different-key'), null);
  const [payload, sig] = value.split('.');
  const changed = JSON.parse(Buffer.from(payload, 'base64url'));
  changed.userId = 'pilot-b';
  assert.equal(readOAuthFlow(`${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${sig}`, now, key), null);
  assert.throws(() => createOAuthFlow('discord', 'link', null, now, key));
});

test('provider configuration is allowlisted and extra providers are opt-in', () => {
  assert.deepEqual(enabledOAuthProviders('discord,google,unknown,google,github'), ['discord', 'google', 'github']);
  assert.deepEqual(enabledOAuthProviders(''), []);
  assert.match(oauthErrorMessage('manual linking is disabled'), /GOTRUE_SECURITY_MANUAL_LINKING_ENABLED/);
});

test('Discord link callback retains the UUID and never overwrites an existing profile', async () => {
  const state = reset();
  const response = await callback.GET(request());
  assert.equal(response.headers.get('location'), 'https://edringcolony.ru/account?oauth=linked&provider=discord');
  assert.equal(response.cookies.get('sb-test-auth-token').value, 'new-session');
  assert.equal(response.cookies.get(OAUTH_FLOW_COOKIE).maxAge, 0);
  assert.equal(response.cookies.get('sb-test-auth-token-code-verifier').maxAge, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(state.inserts, [{ id: 'pilot-a', email: null }]);
});

test('login callback uses public origin instead of forwarded/Docker host', async () => {
  reset({ before: null });
  const response = await callback.GET(request({ mode: 'login' }));
  assert.equal(response.headers.get('location'), 'https://edringcolony.ru/account?provider=discord');
});

test('changed user during link never writes new session cookies or another profile', async () => {
  for (const params of [
    { before: { id: 'pilot-b' } },
    { afterUser: { id: 'pilot-b', identities: [{ provider: 'discord' }] } },
    { afterUser: { id: 'pilot-a', identities: [{ provider: 'email' }] } },
  ]) {
    const state = reset(params);
    const response = await callback.GET(request());
    assert.match(response.headers.get('location'), /account_mismatch/);
    assert.equal(response.cookies.get('sb-test-auth-token'), undefined);
    assert.equal(state.inserts.length, 0);
  }
});

test('missing/expired context and invalid exchange do not silently establish a session', async () => {
  let state = reset();
  let response = await callback.GET(request({ flow: 'invalid' }));
  assert.equal(state.clients, 0);
  assert.match(response.headers.get('location'), /expired/);
  state = reset({ exchangeError: true });
  response = await callback.GET(request());
  assert.equal(state.inserts.length, 0);
  assert.equal(response.cookies.get('sb-test-auth-token'), undefined);
  assert.match(response.headers.get('location'), /expired/);
});

test('Discord cancellation returns to account and does not reflect provider descriptions', async () => {
  const state = reset();
  const response = await callback.GET(request({ query: 'error=access_denied&error_description=secret-code-xyz' }));
  assert.equal(state.exchanged, 0);
  assert.match(response.headers.get('location'), /\/account\?oauth_error=cancelled/);
  assert.doesNotMatch(response.headers.get('location'), /secret-code-xyz/);
});

test('server action links a signed-in user even when invoked from login', async () => {
  const state = reset();
  const result = await actions.startOAuthAction('discord', 'login');
  assert.equal(result.error, null);
  assert.equal(state.links.length, 1);
  assert.equal(state.logins.length, 0);
  assert.equal(state.links[0].options.redirectTo, 'https://edringcolony.ru/api/auth/callback');
  assert.equal(state.links[0].options.scopes, 'identify email');
  const cookie = state.cookieStore.values.get(OAUTH_FLOW_COOKIE);
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.secure, true);
  assert.equal(readOAuthFlow(cookie.value, Date.now(), key).userId, 'pilot-a');
});

test('server action rejects anonymous linking and disabled/unknown providers', async () => {
  const state = reset({ before: null });
  assert.ok((await actions.startOAuthAction('discord', 'link')).error);
  assert.ok((await actions.startOAuthAction('untrusted', 'login')).error);
  process.env.AUTH_OAUTH_PROVIDERS = 'discord';
  assert.ok((await actions.startOAuthAction('google', 'login')).error);
  assert.equal(state.links.length + state.logins.length, 0);
});

test('anonymous login uses OAuth sign-in; provider failures are returned, not thrown', async () => {
  const state = reset({ before: null });
  assert.ok((await actions.startOAuthAction('google', 'login')).url);
  assert.equal(state.logins[0].provider, 'google');
  state.client.auth.signInWithOAuth = async () => ({ data: null, error: { message: 'provider is not enabled' } });
  const result = await actions.startOAuthAction('github', 'login');
  assert.equal(result.url, null);
  assert.match(result.error, /GitHub/);
});

test('browser API sessions still refresh; cron and uploader requests bypass session middleware', async () => {
  for (const [path, method, shouldRefresh] of [
    ['/account', 'GET', true], ['/api/capi/profile', 'GET', true], ['/api/squadrons/my', 'GET', true],
    ['/api/cron/capi-sync', 'POST', false], ['/api/logs/upload', 'POST', false],
    ['/api/auth/callback', 'GET', false], ['/auth/callback', 'GET', false], ['/api/galnet', 'POST', false],
  ]) {
    const state = reset();
    const req = new Request(`https://edringcolony.ru${path}`, { method });
    req.nextUrl = new URL(req.url);
    req.cookies = { getAll: () => [], set() {} };
    const response = await middleware.proxy(req);
    assert.equal(response.status, 200);
    assert.equal(state.clients > 0, shouldRefresh, path);
  }
});

test('unlinking requires another enabled identity or confirmed email identity', () => {
  const discord = { identity_id: 'identity-a', id: '123', provider: 'discord' };
  const email = { identity_id: 'identity-b', id: 'user-id', provider: 'email' };
  const github = { identity_id: 'identity-c', id: '456', provider: 'github' };
  assert.equal(canUnlinkOAuthIdentity({ identities: [discord] }, 'discord', ['discord']), false);
  assert.equal(canUnlinkOAuthIdentity({ identities: [discord, email] }, 'discord', ['discord']), false);
  assert.equal(canUnlinkOAuthIdentity({ identities: [discord, email], email_confirmed_at: '2026-09-20' }, 'discord', ['discord']), true);
  assert.equal(canUnlinkOAuthIdentity({ identities: [discord, github] }, 'discord', ['discord']), false);
  assert.equal(canUnlinkOAuthIdentity({ identities: [discord, github] }, 'discord', ['discord', 'github']), true);
});

test('provider subject collisions do not hide a valid alternative identity', () => {
  const identities = [
    { identity_id: 'identity-a', id: '123', provider: 'discord' },
    { identity_id: 'identity-b', id: '123', provider: 'github' },
  ];
  assert.equal(canUnlinkOAuthIdentity({ identities }, 'discord', ['discord', 'github']), true);
});


test('legacy callback redirects server-side before any client can consume the PKCE code', async () => {
  const state = reset();
  const response = legacyCallback.GET(new Request('https://evil.test/auth/callback?code=abc%2B123'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://edringcolony.ru/api/auth/callback?code=abc%2B123');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(state.exchanged, 0);
  assert.equal(response.cookies.get('sb-test-auth-token'), undefined);
});


test('SSR refresh cookies are never cacheable, including subsequent setAll calls', async () => {
  const state = reset();
  state.client.auth.getUser = async () => {
    state.cookieOptions.setAll([{ name: 'refresh-one', value: 'first', options: {path:'/'} }],
      { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0', Expires:'0', Pragma:'no-cache' });
    state.cookieOptions.setAll([{ name: 'refresh-two', value: 'second', options: {path:'/'} }], {});
    return { data:{user:{id:'pilot-a'}},error:null };
  };
  const request = new Request('https://edringcolony.ru/account');
  request.nextUrl = new URL(request.url);
  request.cookies = { getAll:()=>[],set(){} };
  const response = await middleware.proxy(request);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(response.headers.get('Expires'), '0');
  assert.equal(response.cookies.get('refresh-one').value, 'first');
  assert.equal(response.cookies.get('refresh-two').value, 'second');
});
