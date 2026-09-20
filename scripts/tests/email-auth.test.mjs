import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { createRecoveryGrant, readRecoveryGrant, RECOVERY_COOKIE, RECOVERY_TTL, sessionId } from '../../src/lib/passwordRecovery.ts';
import { passwordError } from '../../src/lib/passwordPolicy.ts';

const dir = mkdtempSync(join(tmpdir(), 'edrc-email-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const root = process.cwd();
const secret = 'test-recovery-secret-not-a-real-credential';
const token = 'test.' + Buffer.from(JSON.stringify({ session_id: 'session-a' })).toString('base64url') + '.signature';
const tokenHash = 'a'.repeat(64);
writeFileSync(join(dir, 'next.mjs'), `export class NextResponse extends Response {
  cookies = { values: new Map(), set(name,value,options) { this.values.set(name,{name,value,...options}); },
    delete(name) { this.set(name,'',{maxAge:0}); }, get(name) { return this.values.get(name); } };
  static json(body, init) { return new NextResponse(JSON.stringify(body),init); }
}`);
writeFileSync(join(dir, 'supabase.mjs'), `export function createClient(url,key,options) {
  globalThis.__emailAuth.factories.push({url,key,options}); return globalThis.__emailAuth.client;
}`);
writeFileSync(join(dir, 'ssr.mjs'), `export function createServerClient(url,key,options) {
  globalThis.__emailAuth.stagedCookies = options.cookies; return globalThis.__emailAuth.client;
}`);
writeFileSync(join(dir, 'server.mjs'), `export async function createClient() { return globalThis.__emailAuth.client; }
export function createServiceClient() { return globalThis.__emailAuth.service; }`);
writeFileSync(join(dir, 'headers.mjs'), `export async function cookies() { return globalThis.__emailAuth.cookies; }`);
writeFileSync(join(dir, 'limit.mjs'), `export function checkRateLimit() { return globalThis.__emailAuth.rateAllowed; }`);
async function bundle(entry, name) {
  const outfile = join(dir, `${name}.mjs`);
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    alias: { 'next/server': join(dir, 'next.mjs'), '@supabase/supabase-js': join(dir, 'supabase.mjs'),
      '@supabase/ssr': join(dir, 'ssr.mjs'), 'next/headers': join(dir, 'headers.mjs'),
      '@/lib/supabaseServer': join(dir, 'server.mjs'), '@/lib/rateLimit': join(dir, 'limit.mjs'), '@': join(root, 'src') } });
  return import(outfile);
}
const register = await bundle('src/app/api/auth/register/route.ts', 'register');
const email = await bundle('src/app/api/auth/email/request/route.ts', 'request');
const verify = await bundle('src/app/api/auth/email/verify/route.ts', 'verify');
const password = await bundle('src/app/api/auth/password/route.ts', 'password');
const templates = await bundle('src/app/auth/templates/[template]/route.ts', 'templates');
const helpers = await bundle('src/lib/emailAuth.ts', 'helpers');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
function reset() {
  Object.assign(process.env, { NEXT_PUBLIC_SITE_URL: 'https://edringcolony.ru',
    NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.edringcolony.ru', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon',
    SUPABASE_SERVICE_ROLE_KEY: secret, AUTH_EMAIL_ENABLED: 'true' });
  const user = { id: 'pilot-a', email: 'pilot@example.net', identities: [{ provider: 'email' }], user_metadata: {} };
  const state = { factories: [], signup: [], send: [], verify: [], inserts: [], passwords: [], revoke: [], signouts: [], settingsCalls: 0,
    rateAllowed: true, settings: { mailer_autoconfirm: false, disable_signup: false, external: { email: true } },
    user, session: { user, access_token: token }, signupSession: null, signupError: null, sendError: null,
    verifyError: false, revokeError: false, passwordError: false, signoutError: false,
    cookies: { values: new Map(), get(name) { return this.values.get(name); },
      getAll() { return [...this.values].map(([name,cookie])=>({name,value:cookie.value})); } },
  };
  state.client = {
    auth: {
      signUp: async input => { state.signup.push(input); return { data: { user: state.user, session: state.signupSession }, error: state.signupError }; },
      resend: async input => { state.send.push(input); return { error: state.sendError }; },
      resetPasswordForEmail: async (...input) => { state.send.push(input); return { error: state.sendError }; },
      verifyOtp: async input => {
        state.verify.push(input);
        state.stagedCookies.setAll([{ name:'sb-test-auth-token',value:'verified-session',options:{path:'/'} }]);
        return { data: { session:state.session }, error:state.verifyError ? { message:'bad OTP' } : null };
      },
      getUser: async () => ({ data: { user:state.user }, error:null }),
      getSession: async () => ({ data: { session:state.session }, error:null }),
      updateUser: async input => { state.passwords.push(input); return { error: state.passwordError }; },
      signOut: async input => { state.signouts.push(input); return { error: state.signoutError }; },
    },
    from: () => ({ insert: async row => { state.inserts.push(row); return { error: {code:'23505'} }; } }),
  };
  state.service = { from: table => ({ update: change => ({ eq: async (...where) => {
    state.revoke.push({table,change,where}); return {error: state.revokeError};
  } }) }) };
  globalThis.__emailAuth = state;
  globalThis.fetch = async (url, options) => {
    state.settingsCalls++;
    assert.equal(url, 'https://supabase.edringcolony.ru/auth/v1/settings');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(state.settings));
  };
  return state;
}
function request(body, headers = {}) {
  return new Request('https://edringcolony.ru/api/auth/test', {
    method:'POST', headers:{origin:'https://edringcolony.ru','content-type':'application/json',...headers}, body: JSON.stringify(body),
  });
}
const signup = () => request({email:'PILOT@example.net',password:'very secure passphrase',cmdr_name:' CMDR Tester '});
function grant(state, userId = 'pilot-a', sid = 'session-a') {
  state.cookies.values.set(RECOVERY_COOKIE, {value:createRecoveryGrant(userId, sid, Date.now(), secret)});
}

test('signup uses anonymous signUp + confirmation, never admin account creation or profile overwrite', async () => {
  const state = reset();
  const result = await register.POST(signup());
  assert.equal(result.status,202);
  assert.equal((await result.json()).confirmationRequired,true);
  assert.deepEqual(state.signup, [{email:'pilot@example.net',password:'very secure passphrase',
    options:{data:{cmdr_name:'CMDR Tester'},emailRedirectTo:'https://edringcolony.ru/auth/email'}}]);
  assert.equal(state.factories[0].key,'test-anon');
  assert.equal(state.inserts.length,0);
  assert.equal(state.signouts.length,0);
  assert.equal(result.cookies.get('sb-test-auth-token'),undefined);
});

test('missing/unsafe GoTrue settings and disabled signup fail before creating an account', async () => {
  for(const settings of [{mailer_autoconfirm:true,disable_signup:false},{}, {mailer_autoconfirm:false,disable_signup:true},
    {mailer_autoconfirm:false,disable_signup:false,external:{email:false}}]) {
    const state=reset();state.settings=settings;
    assert.equal((await register.POST(signup())).status,503);
    assert.equal(state.signup.length,0);
  }
  const state=reset();process.env.AUTH_EMAIL_ENABLED='false';
  assert.equal((await register.POST(signup())).status,503);
  assert.equal(state.settingsCalls,0);
});

test('unexpected auto-confirm session is not reported as a successful registration', async () => {
  const state=reset();state.signupSession=state.session;
  const result=await register.POST(signup());
  assert.equal(result.status,503);
  assert.deepEqual(state.signouts,[{scope:'global'}]);
  assert.equal(result.cookies.get('sb-test-auth-token'),undefined);
});

test('email sending responses do not reveal account existence or upstream errors', async () => {
  for(const type of ['signup','recovery']) {
    const state=reset();
    const first=await email.POST(request({email:'pilot@example.net',type}));
    state.sendError={message:'Secret: SMTP down, registered mailbox pilot@example.net',status:500};
    const second=await email.POST(request({email:'pilot@example.net',type}));
    assert.equal(first.status,202);assert.equal(second.status,202);
    assert.equal(await first.text(),await second.text());
  }
});

test('same-origin JSON, bounded body and rate limit are required before auth work', async () => {
  const state=reset();
  assert.equal((await register.POST(request({}, {origin:'https://evil.test'}))).status,403);
  assert.equal((await register.POST(request({}, {'content-type':'text/plain'}))).status,415);
  assert.equal((await register.POST(request({padding:'x'.repeat(9000)}))).status,413);
  assert.equal((await register.POST(request(null))).status,400);
  state.rateAllowed=false;
  assert.equal((await register.POST(signup())).status,429);
  assert.equal(state.signup.length,0);
  assert.equal(state.settingsCalls,0);
});

test('proxy IP selection does not let attacker-prepended forwarded IPs bypass rate limits', () => {
  reset();
  assert.equal(helpers.authRequestIp(request({}, {'x-forwarded-for':'evil, 203.0.113.10'})),'203.0.113.10');
  assert.equal(helpers.authRequestIp(request({}, {'x-forwarded-for':'1.2.3.4', 'x-real-ip':'203.0.113.11'})),'203.0.113.11');
  assert.equal(helpers.authRequestIp(request({}, {'x-real-ip':'arbitrary-key'})),'unknown');
});

test('password policy counts Unicode characters and bounds UTF-8 without trimming', () => {
  assert.match(passwordError('short'),/12/);
  assert.match(passwordError('😀'.repeat(6)),/12/);
  assert.match(passwordError('я'.repeat(40)),/72/);
  assert.equal(passwordError('passphrase with spaces'),null);
});

test('confirmation and recovery templates send TokenHash links, never automatic verification URLs', async () => {
  reset();
  for(const template of ['signup','recovery']) {
    const response=await templates.GET(new Request('https://edringcolony.ru'),{params:Promise.resolve({template})});
    const html=await response.text();
    assert.equal(response.status,200);
    assert.match(html,/{{ .TokenHash }}/);
    assert.match(html,/\/auth\/email#token_hash=/);
    assert.match(html,new RegExp(`type=${template}`));
    assert.doesNotMatch(html,/ConfirmationURL|\/auth\/v1\/verify|access_token=/);
  }
  assert.equal((await templates.GET(new Request('https://edringcolony.ru'),{params:Promise.resolve({template:'unknown'})})).status,404);
  assert.equal(verify.GET,undefined);
});

test('valid signup confirmation writes a verified session but no password-reset grant', async () => {
  const state=reset();
  const result=await verify.POST(request({type:'signup',token_hash:tokenHash}));
  assert.equal(result.status,200);
  assert.equal((await result.json()).next,'/account');
  assert.equal(result.cookies.get('sb-test-auth-token').value,'verified-session');
  assert.equal(result.cookies.get(RECOVERY_COOKIE).maxAge,0);
  assert.equal(state.inserts.length,1);
});

test('invalid, consumed or wrong-type verification never applies staged auth cookies', async () => {
  const state=reset();state.verifyError=true;
  const result=await verify.POST(request({type:'recovery',token_hash:tokenHash}));
  assert.equal(result.status,400);
  assert.equal(result.cookies.get('sb-test-auth-token'),undefined);
  assert.equal(state.inserts.length,0);
  assert.equal((await verify.POST(request({type:'email_change',token_hash:tokenHash}))).status,400);
  assert.equal(state.verify.length,1);
});

test('recovery email grants a short-lived HttpOnly capability bound to user and session', async () => {
  reset();
  const result=await verify.POST(request({type:'recovery',token_hash:tokenHash}));
  const cookie=result.cookies.get(RECOVERY_COOKIE);
  assert.equal(result.status,200);assert.equal(cookie.httpOnly,true);assert.equal(cookie.secure,true);
  assert.equal(cookie.sameSite,'lax');assert.equal(cookie.maxAge,RECOVERY_TTL);
  assert.equal(readRecoveryGrant(cookie.value,Date.now(),secret).userId,'pilot-a');
  assert.equal(readRecoveryGrant(cookie.value,Date.now(),secret).sessionId,'session-a');
});

test('recovery grants reject expiration, tampering, Unicode signatures and wrong purpose', () => {
  const now=Date.now();const value=createRecoveryGrant('pilot-a','session-a',now,secret);
  assert.ok(readRecoveryGrant(value,now,secret));
  assert.equal(readRecoveryGrant(value,now+RECOVERY_TTL*1000,secret),null);
  assert.equal(readRecoveryGrant(value,now,'another-secret'),null);
  assert.equal(readRecoveryGrant(value.split('.')[0]+'.'+'я'.repeat(43),now,secret),null);
  assert.equal(sessionId('not-a-token'),null);
});

test('reset cannot run without a recovery grant, after user switch, or in another session', async () => {
  for(const kind of ['missing','different-user','different-session']) {
    const state=reset();
    if(kind!=='missing')grant(state,kind==='different-user'?'pilot-b':'pilot-a',kind==='different-session'?'session-b':'session-a');
    assert.equal((await password.POST(request({password:'a new secure passphrase'}))).status,401);
    assert.equal(state.passwords.length,0);
    assert.equal(state.revoke.length,0);
  }
});

test('successful recovery revokes uploader tokens and refresh sessions without deleting profiles', async () => {
  const state=reset();grant(state);
  assert.equal((await password.GET()).status,200);
  const result=await password.POST(request({password:'a new secure passphrase'}));
  assert.equal(result.status,200);assert.equal((await result.json()).warning,null);
  assert.deepEqual(state.revoke,[{table:'api_tokens',change:{is_revoked:true},where:['user_id','pilot-a']}]);
  assert.deepEqual(state.signouts,[{scope:'global'}]);
  assert.equal(result.cookies.get(RECOVERY_COOKIE).maxAge,0);
});

test('password update failure does not revoke tokens; partial cleanup is reported honestly', async () => {
  let state=reset();grant(state);state.passwordError={message:'too weak'};
  assert.equal((await password.POST(request({password:'a new secure passphrase'}))).status,400);
  assert.equal(state.revoke.length,0);assert.equal(state.signouts.length,0);
  state=reset();grant(state);state.revokeError={message:'db down'};
  const result=await password.POST(request({password:'a new secure passphrase'}));
  assert.equal(result.status,200);assert.match((await result.json()).warning,/токены Uploader/);
  assert.equal(result.cookies.get(RECOVERY_COOKIE).maxAge,0);
});

test('browser URL autologin is disabled; signup UI no longer signs in without confirmation', () => {
  assert.match(readFileSync('src/lib/supabaseClient.ts','utf8'),/detectSessionInUrl: false/);
  assert.doesNotMatch(readFileSync('src/app/register/page.tsx','utf8'),/signInWithPassword/);
  assert.match(readFileSync('src/app/auth/email/page.tsx','utf8'),/onClick=.*confirm/);
});

test('signup errors do not reveal whether the address already exists', async () => {
  const state = reset();
  const success = await (await register.POST(signup())).text();
  for (const error of [{code:'user_already_exists',status:422}, {code:'unexpected_failure',status:500}, {code:'over_email_send_rate_limit',status:429}]) {
    state.signupError = error;
    const response = await register.POST(signup());
    assert.equal(response.status, 202);
    assert.equal(await response.text(), success);
  }
});
