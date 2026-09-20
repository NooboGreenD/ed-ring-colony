import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'edrc-cron-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const shim = join(dir, 'next.mjs');
writeFileSync(shim, `export const NextResponse = { json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...init.headers, 'Content-Type': 'application/json' } });
} };`);
const authFile = join(dir, 'auth.mjs');
await build({ entryPoints: [join(root, 'src/lib/cronAuth.ts')], outfile: authFile, bundle: true,
  format: 'esm', platform: 'node', logLevel: 'silent', alias: { 'next/server': shim } });
const { isCronAuthorized, runCronTask } = await import(authFile);
const secret = 'test-cron-secret';
const req = (headers = {}, query = '') => new Request(`http://web:3000/api/cron/test${query}`, { headers });

test('cron requires a configured header secret, not Vercel UA or query secret', () => {
  for (const configured of [undefined, '', '   ']) assert.equal(isCronAuthorized(req(), configured), false);
  assert.equal(isCronAuthorized(req({ 'user-agent': 'vercel-cron/1.0' }), secret), false);
  assert.equal(isCronAuthorized(req({}, `?secret=${secret}`), secret), false);
  assert.equal(isCronAuthorized(req({ authorization: 'Bearer wrong' }), secret), false);
  assert.equal(isCronAuthorized(req({ authorization: `Bearer ${secret}` }), secret), true);
  assert.equal(isCronAuthorized(req({ 'x-cron-secret': secret }), secret), true);
});

test('authorization happens before job work and overlapping calls receive 409', async () => {
  process.env.CRON_SECRET = secret;
  let calls = 0;
  const rejected = await runCronTask(req({ 'user-agent': 'vercel-cron/1.0' }), 'test', async () => { calls++; });
  assert.equal(rejected.status, 401);
  assert.equal(calls, 0);
  let finish;
  const first = runCronTask(req({ authorization: `Bearer ${secret}` }), 'test', async () => {
    calls++;
    await new Promise(resolve => { finish = resolve; });
    return Response.json({ ok: true });
  });
  const second = await runCronTask(req({ authorization: `Bearer ${secret}` }), 'test', async () => { calls++; });
  assert.equal(second.status, 409);
  assert.equal(second.headers.get('retry-after'), '60');
  assert.equal(calls, 1);
  finish();
  assert.equal((await first).status, 200);
  const third = await runCronTask(req({ authorization: `Bearer ${secret}` }), 'test', async () => Response.json({ ok: true }));
  assert.equal(third.status, 200);
});

test('all real cron and Galnet write handlers reject spoofed Vercel requests', async () => {
  // Stub only external services. Keep route handlers and authorization real;
  // any attempted database work is an error, not a successful fake response.
  const db = join(dir, 'db.mjs');
  writeFileSync(db, `export function createAdminClient() { throw new Error('unauthorized DB access'); }
    export const createServiceClient = createAdminClient;
    export const createClient = createAdminClient;
    export const supabaseAdmin = {};
  `);
  const dependencies = [
    'src/app/api/cron/capi-sync/route.ts', 'src/app/api/cron/cg-check/route.ts',
    'src/app/api/cron/eddn-cleanup/route.ts', 'src/app/api/cron/translate/route.ts',
    'src/app/api/cron/update-progress/route.ts', 'src/app/api/galnet/route.ts',
  ];
  process.env.CRON_SECRET = secret;
  for (const [index, entry] of dependencies.entries()) {
    const outfile = join(dir, `route-${index}.mjs`);
    await build({ entryPoints: [join(root, entry)], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
      alias: { 'next/server': shim, '@/lib/supabaseAdmin': db, '@/lib/supabaseServer': db, '@': join(root, 'src') },
    });
    const route = await import(outfile);
    const methods = entry.includes('/galnet/') ? ['POST', 'PATCH'] : ['GET', 'POST'];
    for (const method of methods) {
      const response = await route[method](req({ 'user-agent': 'vercel-cron/1.0' }, `?secret=${secret}`));
      assert.equal(response.status, 401, `${entry} ${method}`);
    }
  }
});
