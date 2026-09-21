import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOBS, jobConfig, scheduleSlot, callEndpoint, executeJob, runTick, loadState, saveState } from '../server-jobs.mjs';

const config = (extra = {}) => jobConfig({ CRON_SECRET: 'test-secret-not-a-real-credential', ...extra });
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('all six former Actions have UTC schedules, including progress', () => {
  assert.deepEqual(JOBS.map(job => job.name), [
    'capi-sync', 'update-progress', 'cg-check', 'eddn-cleanup', 'galnet-sync', 'translate',
  ]);
  for (const job of JOBS) {
    const at = Date.parse('2026-09-20T00:00:00Z') + job.offset;
    assert.equal(scheduleSlot(job, at - 1), scheduleSlot(job, at) - 1);
    assert.equal(scheduleSlot(job, at), scheduleSlot(job, at + job.period - 1));
  }
  const galnet = JOBS.find(job => job.name === 'galnet-sync');
  assert.equal(new Date(Date.parse('2026-09-20T00:00:00Z') + galnet.offset).toISOString(), '2026-09-20T06:20:00.000Z');
});

test('configuration rejects unknown jobs and ambiguous URLs, allows disabling all jobs', () => {
  assert.throws(() => config({ JOBS_ENABLED: 'typo' }), /Unknown job/);
  for (const url of ['ftp://web', 'http://u:p@web', 'http://web?secret=bad', 'http://web/api']) {
    assert.throws(() => config({ JOBS_BASE_URL: url }));
  }
  assert.deepEqual(config({ JOBS_ENABLED: '' }).jobs, []);
  assert.throws(() => config({ GALNET_TRANSLATE_LIMIT: '500' }));
});

test('each endpoint uses POST, header secret, redirect protection and timeout', async () => {
  const c = config();
  for (const job of JOBS) {
    let captured;
    await callEndpoint(c, job, async (url, init) => { captured = { url, init }; return json({ ok: true }); });
    assert.equal(captured.url.origin, 'http://web:3000');
    assert.equal(captured.url.pathname, job.path);
    assert.equal(captured.url.searchParams.has('secret'), false);
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.Authorization, `Bearer ${c.secret}`);
    assert.equal(captured.init.redirect, 'error');
    assert.ok(captured.init.signal instanceof AbortSignal);
  }
});

test('non-JSON, HTTP errors and HTTP-200 business errors all fail', async () => {
  for (const response of [new Response('<html>error</html>'), new Response('', { status: 502 }),
    new Response('', { status: 302 }), json({ ok: false }), json({ success: false }),
    json({ failed: 2 }), json({ error: 'secret that must not be logged' }), json([])]) {
    await assert.rejects(() => callEndpoint(config(), JOBS[0], async () => response),
      error => !error.message.includes('secret that must not be logged'));
  }
  let called = false;
  await assert.rejects(() => callEndpoint(config({ CRON_SECRET: '' }), JOBS[0], async () => { called = true; }), /CRON_SECRET/);
  assert.equal(called, false);
});

test('Galnet sync drains translations even when the feed is unchanged; limits passes', async () => {
  const paths = [];
  const c = config({ JOBS_TRANSLATE_PASSES: '3' });
  await executeJob(c, JOBS.find(job => job.name === 'galnet-sync'), async url => {
    paths.push(url.pathname);
    if (url.pathname === '/api/galnet') {
      assert.equal(url.searchParams.get('translate'), '1');
      assert.equal(url.searchParams.get('translateLimit'), '10');
      return json({ ok: true, inserted: 0 });
    }
    return json({ ok: true, remaining: 99 });
  });
  assert.deepEqual(paths, ['/api/galnet', '/api/cron/translate', '/api/cron/translate', '/api/cron/translate']);
});

test('unconfigured translation credentials stop the daily drain, rather than looping', async () => {
  let calls = 0;
  await executeJob(config(), JOBS.find(job => job.name === 'galnet-sync'), async url => {
    calls++;
    return json(url.pathname === '/api/galnet' ? { ok: true, fetched: 1 } :
      { ok: true, skipped: true, reason: 'not configured', remaining: 50 });
  });
  assert.equal(calls, 2);
});

test('six-hour translation keeps the old single-batch quota', async () => {
  let calls = 0;
  await executeJob(config(), JOBS.find(job => job.name === 'translate'), async () => {
    calls++; return json({ ok: true, remaining: 999 });
  });
  assert.equal(calls, 1);
});

test('empty Galnet feed is a failure, as in the previous CLI workflow', async () => {
  await assert.rejects(() => callEndpoint(config(), JOBS.find(job => job.name === 'galnet-sync'),
    async () => json({ ok: true, fetched: 0 })), /feed is empty/);
});

test('tick is sequential, does one catch-up, and persists successes without secrets', async () => {
  const c = config();
  const state = { version: 1, jobs: {} };
  const retries = {};
  const calls = [];
  let active = 0;
  const options = { config: c, state, retries, log: () => {}, now: () => Date.parse('2026-09-20T12:00:00Z'),
    persist: async (file, saved) => { assert.equal(JSON.stringify(saved).includes(c.secret), false); },
    run: async (_, job) => {
      assert.equal(active++, 0);
      await Promise.resolve();
      calls.push(job.name); active--;
      return { ok: true };
    } };
  await runTick(options);
  assert.equal(calls.length, 6);
  await runTick(options);
  assert.equal(calls.length, 6, 'do not replay the current slot');
  await runTick({ ...options, now: () => Date.parse('2026-09-23T12:00:00Z') });
  assert.equal(calls.length, 12, 'three days of downtime must not replay every missed minute');
});

test('failures retry within the same slot with backoff and do not block other jobs', async () => {
  const c = config({ JOBS_ENABLED: 'galnet-sync,translate' });
  const state = { version: 1, jobs: {} };
  const retries = {};
  let clock = Date.parse('2026-09-20T12:00:00Z');
  let attempts = 0;
  const options = { config: c, state, retries, log: () => {}, now: () => clock, persist: async () => {},
    run: async (_, job) => {
      if (job.name === 'galnet-sync' && ++attempts === 1) throw new Error('HTTP 503');
      return { ok: true };
    } };
  await runTick(options);
  assert.equal(state.jobs['galnet-sync'], undefined);
  assert.ok(state.jobs.translate);
  clock += 30_000;
  await runTick(options);
  assert.equal(attempts, 1);
  clock += 30_000;
  await runTick(options);
  assert.equal(attempts, 2);
  assert.ok(state.jobs['galnet-sync']);
  assert.equal(retries['galnet-sync'], undefined);
});

test('failure to persist state is fatal, not a successful but unrecorded run', async () => {
  await assert.rejects(() => runTick({ config: config(), state: { version: 1, jobs: {} }, retries: {},
    log: () => {}, run: async () => ({ ok: true }), persist: async () => { throw new Error('disk full'); } }), /disk full/);
});

test('state survives restart; missing starts clean, corrupt state fails visibly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'edrc-jobs-'));
  const file = join(dir, 'state.json');
  try {
    assert.deepEqual(await loadState(file), { version: 1, jobs: {} });
    const state = { version: 1, jobs: { 'capi-sync': { slot: 123 } } };
    await saveState(file, state);
    assert.deepEqual(await loadState(file), state);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), state);
    await writeFile(file, 'corrupt');
    await assert.rejects(() => loadState(file), /Cannot read scheduler state/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
