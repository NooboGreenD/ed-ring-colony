import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOBS, DEFAULT_JOBS, jobConfig, scheduleSlot, callEndpoint, executeJob, runTick, loadState, saveState } from '../server-jobs.mjs';

const config = (extra = {}) => jobConfig({ CRON_SECRET: 'test-secret-not-a-real-credential', ...extra });
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('all six former Actions have UTC schedules, including progress', () => {
  assert.deepEqual(JOBS.map(job => job.name), [
    'capi-sync', 'update-progress', 'cg-check', 'eddn-cleanup', 'galnet-sync', 'translate', 'galaxy-import',
  ]);
  // The Spansh catalog import stays opt-in: it must not run on a bare scheduler.
  assert.deepEqual(DEFAULT_JOBS, [
    'capi-sync', 'update-progress', 'cg-check', 'eddn-cleanup', 'galnet-sync', 'translate',
  ]);
  assert.deepEqual(config().jobs.map(job => job.name), DEFAULT_JOBS);
  assert.deepEqual(config({ JOBS_ENABLED: 'galaxy-import' }).jobs.map(job => job.name), ['galaxy-import']);
  for (const job of JOBS) {
    const at = Date.parse('2026-09-20T00:00:00Z') + job.offset;
    assert.equal(scheduleSlot(job, at - 1), scheduleSlot(job, at) - 1);
    assert.equal(scheduleSlot(job, at), scheduleSlot(job, at + job.period - 1));
  }
  const galnet = JOBS.find(job => job.name === 'galnet-sync');
  assert.equal(new Date(Date.parse('2026-09-20T00:00:00Z') + galnet.offset).toISOString(), '2026-09-20T06:20:00.000Z');
  const galaxy = JOBS.find(job => job.name === 'galaxy-import');
  assert.equal(new Date(Date.parse('2026-09-20T00:00:00Z') + galaxy.offset).toISOString(), '2026-09-20T02:00:00.000Z');
  assert.equal(galaxy.period, 24 * 60 * 60 * 1000);
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

test('Galnet jobs are queue-based: partial per-article failures do not fail the slot', async () => {
  // Недопереведённая статья — это «догонит следующий слот», а не провал задачи:
  // иначе один сбойный перевод замораживал state-файл и всё окно «Фоновые задачи».
  await assert.doesNotReject(() => callEndpoint(config(), JOBS.find(job => job.name === 'translate'),
    async () => json({ ok: true, processed: 10, translated: 7, failed: 3, remaining: 12 })));
  await assert.doesNotReject(() => callEndpoint(config(), JOBS.find(job => job.name === 'galnet-sync'),
    async () => json({ ok: true, success: false, fetched: 30, inserted: 5, translated: 0,
      errors: ['translate:nid: Yandex quota exceeded'] })));
  // Структурные ошибки остаются провалом.
  await assert.rejects(() => callEndpoint(config(), JOBS.find(job => job.name === 'translate'),
    async () => json({ ok: false, errors: ['galnet_news: query failed'] })));
  await assert.rejects(() => callEndpoint(config(), JOBS.find(job => job.name === 'galnet-sync'),
    async () => json({ ok: false, error: 'Galnet HTTP 503' })));
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
  // Сбой больше не невидимка: в state попадает причина, но БЕЗ slot/lastSuccess —
  // слот не закрывается, повтор в этом же слоте остаётся возможным.
  assert.equal(state.jobs['galnet-sync'].slot, undefined);
  assert.equal(state.jobs['galnet-sync'].lastSuccess, undefined);
  assert.equal(state.jobs['galnet-sync'].lastError, 'HTTP 503');
  assert.equal(state.jobs['galnet-sync'].failures, 1);
  assert.ok(state.jobs['galnet-sync'].lastFailureAt);
  assert.ok(state.jobs.translate);
  clock += 30_000;
  await runTick(options);
  assert.equal(attempts, 1, 'backoff holds the retry inside the same slot');
  clock += 30_000;
  await runTick(options);
  assert.equal(attempts, 2);
  assert.ok(state.jobs['galnet-sync'].slot, 'success closes the slot');
  assert.equal(state.jobs['galnet-sync'].lastError, undefined, 'success clears the failure line');
  assert.equal(state.jobs['galnet-sync'].lastFailureAt, undefined);
  assert.equal(state.jobs['galnet-sync'].failures, undefined);
  assert.equal(retries['galnet-sync'], undefined);
});

test('repeated failures accumulate the counter and keep the previous success fields', async () => {
  const c = config({ JOBS_ENABLED: 'translate' });
  const state = { version: 1, jobs: {} };
  const retries = {};
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const options = { config: c, state, retries, log: () => {}, now: () => clock, persist: async () => {},
    run: async () => { throw new Error('queue query failed'); } };
  await runTick(options);
  const firstFailureAt = state.jobs.translate.lastFailureAt;
  clock += 10 * 60_000;
  await runTick(options);
  assert.equal(state.jobs.translate.failures, 2);
  assert.equal(state.jobs.translate.lastError, 'queue query failed');
  assert.notEqual(state.jobs.translate.lastFailureAt, firstFailureAt);
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
