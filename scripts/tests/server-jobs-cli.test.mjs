import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../server-jobs.mjs', import.meta.url));
const secret = 'local-smoke-test-not-a-real-secret';

async function invoke(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child;
  try {
    child = spawn(process.execPath, [script, '--once', 'capi-sync'], {
      env: { ...process.env, CRON_SECRET: secret, JOBS_ENABLED: 'capi-sync',
        JOBS_BASE_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { code, output };
  } finally {
    if (child && child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
  }
}

test('real job CLI sends the expected authenticated POST and exits successfully', { timeout: 10_000 }, async () => {
  let request;
  const result = await invoke((req, res) => {
    request = { method: req.method, url: req.url, secret: req.headers.authorization };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, synced: 0 }));
  });
  assert.deepEqual(request, { method: 'POST', url: '/api/cron/capi-sync', secret: `Bearer ${secret}` });
  assert.equal(result.code, 0);
  assert.match(result.output, /success/);
  assert.equal(result.output.includes(secret), false);
});

test('real CLI reports HTTP/business failures and never follows a redirect carrying the secret', { timeout: 10_000 }, async () => {
  for (const [status, payload] of [[503, { error: secret }], [200, { ok: false, error: secret }], [307, {}]]) {
    let calls = 0;
    const result = await invoke((req, res) => {
      calls++;
      res.writeHead(status, { 'Content-Type': 'application/json', Location: '/should-not-follow' });
      res.end(JSON.stringify(payload));
    });
    assert.equal(result.code, 1);
    assert.equal(calls, 1);
    assert.equal(result.output.includes(secret), false);
  }
});
