import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMonitorServer,
  enabledJobNames,
  monitorTokenMatches,
  publicContainerStatus,
  schedulerSnapshot,
} from '../monitor-agent.mjs';

test('monitor agent shares scheduler defaults and preserves an explicit empty JOBS_ENABLED', () => {
  assert.deepEqual(enabledJobNames(undefined), [
    'capi-sync', 'update-progress', 'cg-check', 'eddn-cleanup', 'galnet-sync', 'translate',
  ]);
  assert.deepEqual(enabledJobNames(''), []);
  assert.deepEqual(enabledJobNames('capi-sync, translate'), ['capi-sync', 'translate']);
});

test('scheduler status reports only timing facts and marks a stale success as a warning', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  const fresh = schedulerSnapshot({ version: 1, jobs: {
    'capi-sync': { slot: 1, lastSuccess: '2026-09-22T11:58:00.000Z', secret: 'must not escape' },
  } }, ['capi-sync'], now)[0];
  assert.equal(fresh.status, 'healthy');
  assert.equal(fresh.lastSuccessAt, '2026-09-22T11:58:00.000Z');
  assert.equal(fresh.everySeconds, 300);
  assert.equal(JSON.stringify(fresh).includes('must not escape'), false);

  const stale = schedulerSnapshot({ version: 1, jobs: {
    'capi-sync': { lastSuccess: '2026-09-22T11:40:00.000Z' },
  } }, ['capi-sync'], now)[0];
  assert.equal(stale.status, 'warning');
});

test('agent token comparison requires a Bearer token and does not accept lookalikes', () => {
  const token = 'test-monitor-token-not-a-real-secret';
  assert.equal(monitorTokenMatches(`Bearer ${token}`, token), true);
  assert.equal(monitorTokenMatches(`bearer ${token}`, token), true);
  assert.equal(monitorTokenMatches(`Bearer ${token}x`, token), false);
  assert.equal(monitorTokenMatches(token, token), false);
  assert.equal(monitorTokenMatches(`Bearer ${token}`, ''), false);
});

test('private endpoint exposes a liveness probe but protects the operational payload', async (t) => {
  const token = 'test-monitor-token-not-a-real-secret';
  const server = createMonitorServer({
    env: {
      MONITOR_AGENT_TOKEN: token,
      MONITOR_COMPOSE_PROJECT: 'test-project',
      MONITOR_JOBS_ENABLED: '',
      MONITOR_JOBS_STATE_FILE: '/not-present/jobs-state.json',
      DOCKER_SOCKET_PATH: '/not-present/docker.sock',
    },
    now: () => Date.parse('2026-09-22T12:00:00.000Z'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const rejected = await fetch(`${origin}/status`);
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { ok: false });

  const accepted = await fetch(`${origin}/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(accepted.status, 200);
  const payload = await accepted.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.docker.available, false);
  assert.deepEqual(payload.scheduler.jobs, []);
  assert.equal(JSON.stringify(payload).includes(token), false);
});

test('Docker inspect data is reduced to operational facts without configuration or secrets', () => {
  const result = publicContainerStatus({
    Id: '0123456789abcdef',
    Labels: { 'com.docker.compose.service': 'web', arbitrary: 'SECRET_LABEL' },
    State: 'running',
    Names: ['/sensitive-container-name'],
  }, {
    State: { Running: true, Status: 'running', StartedAt: '2026-09-22T12:00:00.000Z' },
    RestartCount: 2,
    Config: { Env: ['DATABASE_PASSWORD=SECRET_VALUE'], Labels: { arbitrary: 'SECRET_LABEL' } },
    Mounts: [{ Source: '/very/private/path' }],
  }, {
    memory_stats: { usage: 1024, limit: 4096 },
    cpu_stats: { cpu_usage: { total_usage: 300, percpu_usage: [1] }, system_cpu_usage: 1000, online_cpus: 1 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
  });

  assert.deepEqual(result, {
    service: 'web',
    state: 'running',
    health: 'not_configured',
    startedAt: '2026-09-22T12:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    restartCount: 2,
    metrics: { memoryBytes: 1024, memoryLimitBytes: 4096, cpuPercent: 40 },
  });
  const output = JSON.stringify(result);
  assert.equal(output.includes('SECRET_'), false);
  assert.equal(output.includes('private/path'), false);
  assert.equal(output.includes('sensitive-container'), false);
});

test('db probe: без MONITOR_DB_URL блок неактивен, недостижимая БД ничего не сливает', async (t) => {
  const token = 'test-monitor-token-not-a-real-secret';
  const baseEnv = {
    MONITOR_AGENT_TOKEN: token,
    MONITOR_JOBS_ENABLED: '',
    MONITOR_JOBS_STATE_FILE: '/not-present/jobs-state.json',
    DOCKER_SOCKET_PATH: '/not-present/docker.sock',
  };
  const listenServer = (env) => {
    const server = createMonitorServer({ env, now: () => Date.parse('2026-09-23T12:00:00.000Z') });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  };

  const silent = await listenServer(baseEnv);
  await t.test('без URL проба не запускается', async () => {
    const payload = await (await fetch(`http://127.0.0.1:${silent.address().port}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    assert.deepEqual(payload.db, { available: false }, 'белый блок — просто «не настроено»');
  });
  await new Promise((resolve) => silent.close(resolve));

  const refused = await listenServer({ ...baseEnv, MONITOR_DB_URL: 'postgresql://app:secret-db-password@127.0.0.1:1/postgres' });
  await t.test('недостижимый Postgres — предупреждение с хостом, но без пароля', async () => {
    const payload = await (await fetch(`http://127.0.0.1:${refused.address().port}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    assert.equal(payload.db.available, false, 'сбой пробы не роняет статус агента');
    assert.match(payload.db.note, /127\.0\.0\.1/, 'хост остаётся как подсказка');
    assert.equal(JSON.stringify(payload).includes('secret-db-password'), false, 'пароль не уходит наружу');
  });
  await new Promise((resolve) => refused.close(resolve));
});
