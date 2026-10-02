import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSupabaseNetworkWatchdog,
  pickSupabaseNetwork,
  supabaseNetWatchdogConfig,
} from '../update-agent.mjs';

/* ──────────────────────────────────────────────────────────────────────────
   «Проверить подключение к БД»: прямой Postgres (db) недоступен — и так
   каждые несколько минут, хотя start-monitoring.sh только что всё починил.

   Имя `db` резолвится только из docker-сети стека Supabase. Любой
   `docker compose up` без deploy/compose.supabase-net.yml (другой каталог,
   старый скрипт, ручная команда) молча пересоздаёт web уже без этой сети.
   Предотвратить чужой up нельзя — поэтому update-agent (единственный
   процесс с rw-сокетом Docker) чинит последствия: сторож находит сеть, где
   supabase-db публикует alias `db`, и переподключает к ней отвалившиеся
   контейнеры web/monitor-agent на лету, называя в журнале виновника
   (контейнер пересоздан тогда-то, проект такой-то).

   Контракт:
     · сеть выбирается по alias `db`, а не по имени «похоже на supabase»;
     · отвалившийся контейнер переподключается, подключённый не трогается;
     · контейнер из ЧУЖОГО compose-проекта — отдельное предупреждение
       (это и есть классический источник «постоянно отваливается»);
     · во время обновления проекта сторож не вмешивается (isBusy);
     · без docker (systemd-режим) сторож отключает себя одной строкой;
     · SUPABASE_NET_WATCH_SECONDS=0 выключает его полностью.
   ────────────────────────────────────────────────────────────────────────── */

const NET = 'supabase_default';

function watchdogConfig(overrides = {}) {
  return {
    enabled: true,
    intervalMs: 60_000,
    networkHint: '',
    dbContainer: 'supabase-db',
    services: ['web', 'monitor-agent'],
    ...overrides,
  };
}

/**
 * Поддельный docker CLI: маршрутизирует вызовы по аргументам и записывает
 * их все — тесты проверяют и ответы, и то, какие команды реально ушли.
 */
function fakeDocker({
  dbNetworks = { [NET]: { Aliases: ['db', 'supabase-db'] } },
  containers = {},
  byService = {},
  selfProject = 'src',
  connectError = null,
  hintNetworkExists = false,
} = {}) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (line === 'inspect --format {{json .NetworkSettings.Networks}} supabase-db') {
      if (dbNetworks === null) throw new Error('No such object: supabase-db');
      return `${JSON.stringify(dbNetworks)}\n`;
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      if (hintNetworkExists) return `${args[3]}\n`;
      throw new Error(`no such network: ${args[3]}`);
    }
    if (args[0] === 'inspect' && args[1] === '--format' && args[2].includes('com.docker.compose.project')) {
      return `${selfProject}\n`;
    }
    if (args[0] === 'ps') {
      const filter = args[2] ?? '';
      const service = filter.replace('label=com.docker.compose.service=', '');
      return `${(byService[service] ?? []).join('\n')}\n`;
    }
    if (args[0] === 'inspect') {
      const info = containers[args[1]];
      if (!info) throw new Error(`No such object: ${args[1]}`);
      return `${JSON.stringify([info])}\n`;
    }
    if (args[0] === 'network' && args[1] === 'connect') {
      if (connectError) throw connectError;
      return '';
    }
    throw new Error(`fakeDocker: неожиданная команда «${line}»`);
  };
  return { docker, calls };
}

function container({ name, project = 'src', networks = [NET], running = true }) {
  return {
    Name: `/${name}`,
    Created: '2026-10-02T10:00:00Z',
    State: { Running: running },
    Config: { Labels: { 'com.docker.compose.project': project } },
    NetworkSettings: { Networks: Object.fromEntries(networks.map((n) => [n, {}])) },
  };
}

test('конфигурация: включён по умолчанию, SUPABASE_NET_WATCH_SECONDS=0 выключает', () => {
  const def = supabaseNetWatchdogConfig({});
  assert.equal(def.enabled, true);
  assert.equal(def.intervalMs, 60_000);
  assert.deepEqual(def.services, ['web', 'monitor-agent']);
  assert.equal(def.dbContainer, 'supabase-db');

  const off = supabaseNetWatchdogConfig({ SUPABASE_NET_WATCH_SECONDS: '0' });
  assert.equal(off.enabled, false);

  const custom = supabaseNetWatchdogConfig({
    SUPABASE_NET_WATCH_SECONDS: '5', // ниже нижней границы — поднимается до 15 с
    SUPABASE_NET_WATCH_SERVICES: ' web , jobs ',
    SUPABASE_NETWORK: 'supabase_net',
    SUPABASE_CONTAINER: 'supabase-db-1',
  });
  assert.equal(custom.intervalMs, 15_000);
  assert.deepEqual(custom.services, ['web', 'jobs']);
  assert.equal(custom.networkHint, 'supabase_net');
  assert.equal(custom.dbContainer, 'supabase-db-1');
});

test('сеть выбирается по alias db, а не по подсказке или имени', () => {
  const networks = {
    bridge: {},
    supabase_old: { Aliases: ['postgres'] },
    supabase_default: { Aliases: ['db', 'supabase-db'] },
  };
  // alias важнее подсказки, указывающей на сеть без alias
  assert.equal(pickSupabaseNetwork(networks, 'supabase_old'), 'supabase_default');
  // подсказка побеждает, когда alias опубликован и в ней
  assert.equal(
    pickSupabaseNetwork({ a: { Aliases: ['db'] }, b: { Aliases: ['db'] } }, 'b'),
    'b',
  );
  // без alias: подсказка → имя с «supabase» → первая сеть
  assert.equal(pickSupabaseNetwork({ bridge: {}, other: {} }, 'other'), 'other');
  assert.equal(pickSupabaseNetwork({ bridge: {}, supabase_x: {} }), 'supabase_x');
  assert.equal(pickSupabaseNetwork({ bridge: {} }), 'bridge');
  assert.equal(pickSupabaseNetwork(null), '');
  assert.equal(pickSupabaseNetwork({}), '');
});

test('отвалившийся web переподключается, подключённый monitor-agent не трогается', async () => {
  const { docker, calls } = fakeDocker({
    byService: { 'web': ['aaa111'], 'monitor-agent': ['bbb222'] },
    containers: {
      aaa111: container({ name: 'src-web-1', networks: ['src_default', 'src_monitor'] }),
      bbb222: container({ name: 'src-monitor-agent-1', networks: ['src_monitor', NET] }),
    },
  });
  const lines = [];
  const watchdog = createSupabaseNetworkWatchdog({
    config: watchdogConfig(),
    docker,
    log: (line) => lines.push(line),
    selfContainerId: 'self',
  });

  const summary = await watchdog.tick();
  assert.equal(summary.network, NET);
  assert.equal(summary.checked, 2);
  assert.deepEqual(summary.repaired.map((r) => r.name), ['src-web-1']);
  assert.deepEqual(summary.failed, []);

  const connects = calls.filter((args) => args[0] === 'network' && args[1] === 'connect');
  assert.deepEqual(connects, [['network', 'connect', NET, 'aaa111']]);
  assert.ok(lines.some((line) => line.includes('src-web-1') && line.includes('переподключил')), lines.join('\n'));
  // проект совпадает с проектом апдейтера — предупреждения о чужом проекте нет
  assert.ok(!lines.some((line) => line.includes('двух разных каталогов')), lines.join('\n'));
});

test('контейнер из чужого compose-проекта чинится и получает отдельное предупреждение', async () => {
  const { docker } = fakeDocker({
    selfProject: 'src',
    byService: { 'web': ['ccc333'], 'monitor-agent': [] },
    containers: {
      ccc333: container({ name: 'ed-ring-colony-web-1', project: 'ed-ring-colony', networks: ['ed-ring-colony_default'] }),
    },
  });
  const lines = [];
  const watchdog = createSupabaseNetworkWatchdog({
    config: watchdogConfig(),
    docker,
    log: (line) => lines.push(line),
    selfContainerId: 'self',
  });

  const summary = await watchdog.tick();
  assert.deepEqual(summary.repaired.map((r) => r.project), ['ed-ring-colony']);
  assert.ok(lines.some((line) => line.includes('двух разных каталогов')), lines.join('\n'));
});

test('во время обновления проекта сторож не вмешивается', async () => {
  const { docker, calls } = fakeDocker({});
  const watchdog = createSupabaseNetworkWatchdog({
    config: watchdogConfig(),
    docker,
    log: () => {},
    isBusy: () => true,
    selfContainerId: 'self',
  });
  const summary = await watchdog.tick();
  assert.equal(summary.skipped, true);
  assert.equal(calls.length, 0);
});

test('supabase-db временно отсутствует: используется явно заданная сеть', async () => {
  const { docker, calls } = fakeDocker({
    dbNetworks: null,
    hintNetworkExists: true,
    byService: { 'web': ['ddd444'], 'monitor-agent': [] },
    containers: {
      ddd444: container({ name: 'src-web-1', networks: ['src_default'] }),
    },
  });
  const watchdog = createSupabaseNetworkWatchdog({
    config: watchdogConfig({ networkHint: NET }),
    docker,
    log: () => {},
    selfContainerId: 'self',
  });
  const summary = await watchdog.tick();
  assert.equal(summary.network, NET);
  assert.deepEqual(summary.repaired.map((r) => r.name), ['src-web-1']);
  assert.ok(calls.some((args) => args[0] === 'network' && args[1] === 'inspect'));
});

test('без supabase-db и без сети — пропуск с одной строкой в журнале, без спама', async () => {
  const { docker } = fakeDocker({ dbNetworks: null });
  const lines = [];
  const watchdog = createSupabaseNetworkWatchdog({
    config: watchdogConfig(),
    docker,
    log: (line) => lines.push(line),
    selfContainerId: 'self',
  });
  const first = await watchdog.tick();
  const second = await watchdog.tick();
  assert.equal(first.network, null);
  assert.equal(second.network, null);
  assert.equal(lines.filter((line) => line.includes('не найден')).length, 1, lines.join('\n'));
});

test('docker недоступен (systemd-режим) — сторож отключает себя одной строкой', async () => {
  const lines = [];
  const docker = async () => {
    throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
  };
  const watchdog = createSupabaseNetworkWatchdog({
    config: watchdogConfig(),
    docker,
    log: (line) => lines.push(line),
    selfContainerId: 'self',
  });
  await watchdog.tick();
  const after = await watchdog.tick();
  assert.equal(after.skipped, true);
  assert.equal(lines.filter((line) => line.includes('отключён')).length, 1, lines.join('\n'));
});

test('гонка «уже подключён» считается успешным ремонтом', async () => {
  const { docker } = fakeDocker({
    byService: { 'web': ['eee555'], 'monitor-agent': [] },
    containers: {
      eee555: container({ name: 'src-web-1', networks: ['src_default'] }),
    },
    connectError: Object.assign(
      new Error('endpoint with name src-web-1 already exists in network supabase_default'),
      { stderr: 'already exists in network' },
    ),
  });
  const watchdog = createSupabaseNetworkWatchdog({
    config: watchdogConfig(),
    docker,
    log: () => {},
    selfContainerId: 'self',
  });
  const summary = await watchdog.tick();
  assert.deepEqual(summary.failed, []);
  assert.deepEqual(summary.repaired.map((r) => r.name), ['src-web-1']);
});

test('другая ошибка подключения попадает в failed и в журнал один раз', async () => {
  const { docker } = fakeDocker({
    byService: { 'web': ['fff666'], 'monitor-agent': [] },
    containers: {
      fff666: container({ name: 'src-web-1', networks: ['src_default'] }),
    },
    connectError: Object.assign(new Error('permission denied'), { stderr: 'permission denied' }),
  });
  const lines = [];
  const watchdog = createSupabaseNetworkWatchdog({
    config: watchdogConfig(),
    docker,
    log: (line) => lines.push(line),
    selfContainerId: 'self',
  });
  const first = await watchdog.tick();
  const second = await watchdog.tick();
  assert.deepEqual(first.failed.map((r) => r.name), ['src-web-1']);
  assert.deepEqual(second.failed.map((r) => r.name), ['src-web-1']);
  assert.equal(lines.filter((line) => line.includes('не удалось подключить')).length, 1, lines.join('\n'));
});
