import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PG_CONNECT_BACKOFF_MS,
  PgConnectionError,
  connectPgClient,
  connectWithRetries,
  describePgConnectionError,
  isPgConnectionError,
  pgConnectionTarget,
} from '../../src/lib/pgModule.ts';
import { createPgWriter } from '../../src/lib/galaxyImport.ts';
import { checkGalaxyDbConnection, createWriterWithFallback } from '../../src/lib/galaxyImportJob.ts';

/* ──────────────────────────────────────────────────────────────────────────
   «при импорте каталога систем ошибка getaddrinfo EAI_AGAIN db».

   Хост `db` — имя сервиса внутри compose-сети self-hosted Supabase; из
   контейнера web (или с хоста) оно не резолвится, и импорт каталога падал на
   первом же подключении с необъяснимым errno. Контракт ниже:
     · переходная ошибка DNS/отказ порта повторяется с паузами;
     · постоянная ошибка объясняет, какой хост не виден и что сделать;
     · при живом PostgREST импорт продолжается через него, а не падает;
     · пароль из строки подключения не попадает в текст ошибки.
   ────────────────────────────────────────────────────────────────────────── */

const DB_URL = 'postgresql://postgres:s3cr3t@db:5432/postgres';

/** Такой объект отдаёт Node/libpq, когда имя не резолвится. */
function dnsError(message = 'getaddrinfo EAI_AGAIN db', code = 'EAI_AGAIN') {
  return Object.assign(new Error(message), { code, syscall: 'getaddrinfo', hostname: 'db' });
}

const noSleep = async () => {};

// ─────────────────────── разбор строки подключения ───────────────────────

test('хост и порт читаются из строки подключения', () => {
  assert.deepEqual(pgConnectionTarget(DB_URL), { host: 'db', port: '5432' });
  assert.deepEqual(pgConnectionTarget('postgres://user@10.0.0.5/postgres'), { host: '10.0.0.5', port: null });
  // IPv6-литерал приходит в скобках — их надо снять.
  assert.deepEqual(pgConnectionTarget('postgresql://u@[2001:db8::1]:6432/db'), { host: '2001:db8::1', port: '6432' });
  // keyword/value-строка — не URL: host не выдуман.
  assert.equal(pgConnectionTarget('host=db port=5432 user=postgres'), null);
});

// ─────────────────────── классификация ошибки ───────────────────────

test('EAI_AGAIN — переходная ошибка DNS с именем хоста в тексте', () => {
  const failure = describePgConnectionError(dnsError(), DB_URL);

  assert.equal(failure.kind, 'dns');
  assert.equal(failure.retryable, true, 'Docker отдаёт EAI_AGAIN и для ещё не прогретого DNS');
  assert.equal(failure.host, 'db');
  assert.equal(failure.code, 'EAI_AGAIN');
  assert.match(failure.message, /db/, 'сообщение называет проблемный хост');
  assert.match(failure.message, /supabase_default/, 'сообщение подсказывает сеть Supabase');
  assert.ok(!failure.message.includes('s3cr3t'), 'пароль не должен попадать в текст ошибки');
});

test('ENOTFOUND тоже распознаётся как DNS', () => {
  const failure = describePgConnectionError(dnsError('getaddrinfo ENOTFOUND db', 'ENOTFOUND'), DB_URL);
  assert.equal(failure.kind, 'dns');
  assert.equal(failure.host, 'db');
});

test('ECONNREFUSED — база не слушает, повтор имеет смысл', () => {
  const failure = describePgConnectionError(
    Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED' }),
    'postgresql://postgres@172.18.0.2:5432/postgres',
  );
  assert.equal(failure.kind, 'refused');
  assert.equal(failure.retryable, true);
  assert.match(failure.message, /172\.18\.0\.2:5432/);
});

test('неверный пароль не повторяется и не лечится подсказкой про DNS', () => {
  const failure = describePgConnectionError(
    new Error('password authentication failed for user "postgres"'),
    DB_URL,
  );
  assert.equal(failure.kind, 'auth');
  assert.equal(failure.retryable, false);
  assert.ok(!failure.message.includes('не резолвится'));
  assert.ok(!failure.message.includes('s3cr3t'));
});

test('строка без URL не ломает диагностику', () => {
  const failure = describePgConnectionError(dnsError(), 'host=db port=5432');
  assert.equal(failure.kind, 'dns');
  assert.equal(failure.host, null);
  assert.ok(failure.message.length > 0);
});

// ─────────────────────── повторы подключения ───────────────────────

test('переходная ошибка повторяется с паузами и проходит', async () => {
  const sleeps = [];
  let calls = 0;
  const value = await connectWithRetries({
    connectionString: DB_URL,
    sleep: async (ms) => { sleeps.push(ms); },
    connect: async () => {
      calls++;
      if (calls < 3) throw dnsError();
      return 'connected';
    },
  });

  assert.equal(value, 'connected');
  assert.equal(calls, 3, 'третья попытка успешна');
  assert.deepEqual(sleeps, [PG_CONNECT_BACKOFF_MS[0], PG_CONNECT_BACKOFF_MS[1]], 'между попытками есть паузы');
});

test('постоянная ошибка не тратит попытки', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      connectWithRetries({
        connectionString: DB_URL,
        sleep: noSleep,
        connect: async () => {
          calls++;
          throw new Error('password authentication failed for user "postgres"');
        },
      }),
    (error) => {
      assert.ok(isPgConnectionError(error), 'бросается PgConnectionError');
      assert.equal(error.failure.kind, 'auth');
      assert.match(error.message, /отклонил подключение/);
      return true;
    },
  );
  assert.equal(calls, 1, 'повторов нет');
});

test('бесконечный EAI_AGAIN сдаётся после ограниченного числа попыток', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      connectWithRetries({
        connectionString: DB_URL,
        sleep: noSleep,
        connect: async () => {
          calls++;
          throw dnsError();
        },
      }),
    (error) => {
      assert.ok(error instanceof PgConnectionError);
      assert.equal(error.failure.kind, 'dns');
      assert.match(error.message, /getaddrinfo EAI_AGAIN db/);
      return true;
    },
  );
  assert.equal(calls, PG_CONNECT_BACKOFF_MS.length + 1, 'число попыток ограничено расписанием backoff');
});

// ─────────────────────── createPgWriter ───────────────────────

/** Фейковый `pg`: сценарий по номеру созданного клиента. */
function makeFakePg(script) {
  const clients = [];
  class FakeClient {
    constructor(config) {
      this.config = config;
      this.index = clients.length;
      this.ended = false;
      clients.push(this);
    }

    async connect() {
      const step = script(this.index);
      if (step instanceof Error) throw step;
    }

    async query() {
      return { rows: [{ n: '1300000' }], rowCount: 1 };
    }

    async end() {
      this.ended = true;
    }
  }
  class FakeQuery {}
  return { pg: { Client: FakeClient, Pool: FakeClient, Query: FakeQuery }, clients };
}

test('createPgWriter переживает сбой DNS и пишет дальше', async () => {
  const { pg, clients } = makeFakePg((index) => (index < 2 ? dnsError() : null));
  const log = [];

  const writer = await createPgWriter(DB_URL, {
    pg,
    sleep: noSleep,
    log: (line) => log.push(line),
  });

  assert.equal(writer.backend, 'pg');
  assert.equal(clients.length, 3, 'две неудачные попытки и одна успешная');
  assert.ok(clients[0].ended && clients[1].ended, 'неудачные клиенты закрыты');
  assert.equal(await writer.countRows(), 1300000);
  assert.ok(log.some((line) => line.includes('повтор через')), 'повторы видны в логе импорта');
  await writer.close();
});

test('createPgWriter объясняет недоступный хост вместо errno', async () => {
  const { pg } = makeFakePg(() => dnsError());

  await assert.rejects(
    () => createPgWriter(DB_URL, { pg, sleep: noSleep }),
    (error) => {
      assert.ok(isPgConnectionError(error));
      assert.match(error.message, /getaddrinfo EAI_AGAIN db/);
      assert.match(error.message, /не резолвится/);
      assert.match(error.message, /host\.docker\.internal|172\.17\.0\.1/);
      assert.ok(!error.message.includes('s3cr3t'));
      return true;
    },
  );
});

test('connectPgClient пробует подключиться указанным числом попыток', async () => {
  const { pg, clients } = makeFakePg(() => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

  await assert.rejects(
    () => connectPgClient({ connectionString: DB_URL, pg, attempts: 2, sleep: noSleep }),
    /ECONNREFUSED/,
  );
  assert.equal(clients.length, 2);
});

// ─────────────────────── откат на PostgREST ───────────────────────

function fakeWriter(backend) {
  return { backend, written: 0, add: async () => {}, flush: async () => 0, countRows: async () => 0, readPoints: async () => 0, close: async () => {} };
}

function pgConnectionFailure() {
  return new PgConnectionError(describePgConnectionError(dnsError(), DB_URL));
}

test('мёртвый прямой Postgres не валит импорт, если настроен PostgREST', async () => {
  const log = [];
  const supabase = fakeWriter('supabase');
  let pgCalls = 0;

  const result = await createWriterWithFallback({
    backend: 'pg',
    connectionString: DB_URL,
    truncate: false,
    supabaseFallback: true,
    log: (line) => log.push(line),
    createPg: async () => {
      pgCalls++;
      throw pgConnectionFailure();
    },
    createSupabase: async () => supabase,
  });

  assert.equal(pgCalls, 1);
  assert.equal(result.backend, 'supabase', 'импорт продолжает работать через PostgREST');
  assert.equal(result.writer, supabase);
  assert.ok(log.some((line) => line.includes('getaddrinfo EAI_AGAIN db')), 'причина видна в логе');
  assert.ok(log.some((line) => line.includes('PostgREST')), 'переключение озвучено');
});

test('без PostgREST ошибка остаётся ошибкой — и объяснением', async () => {
  await assert.rejects(
    () =>
      createWriterWithFallback({
        backend: 'pg',
        connectionString: DB_URL,
        truncate: false,
        supabaseFallback: false,
        createPg: async () => {
          throw pgConnectionFailure();
        },
        createSupabase: async () => fakeWriter('supabase'),
      }),
    (error) => {
      assert.match(error.message, /не резолвится/);
      assert.ok(!(error instanceof PgConnectionError), 'наружу отдаётся обычная ошибка с готовым текстом');
      return true;
    },
  );
});

test('штатная фабрика Postgres тоже уводит на PostgREST (без подмены createPg)', async () => {
  // Никакой инъекции: реальный createPgWriter → connectPgClient → PgConnectionError.
  const log = [];
  const result = await createWriterWithFallback({
    backend: 'pg',
    connectionString: DB_URL,
    truncate: false,
    supabaseFallback: true,
    pgAttempts: 1,
    log: (line) => log.push(line),
    createSupabase: async () => fakeWriter('supabase'),
  });

  assert.equal(result.backend, 'supabase');
  assert.ok(log.some((line) => line.includes('не резолвится')), 'причина падения прямого подключения озвучена');
});

test('успешное прямое подключение не переключает режим', async () => {
  const pgWriter = fakeWriter('pg');
  let supabaseCalls = 0;

  const result = await createWriterWithFallback({
    backend: 'pg',
    connectionString: DB_URL,
    truncate: true,
    supabaseFallback: true,
    createPg: async () => pgWriter,
    createSupabase: async () => {
      supabaseCalls++;
      return fakeWriter('supabase');
    },
  });

  assert.equal(result.backend, 'pg');
  assert.equal(result.writer, pgWriter);
  assert.equal(supabaseCalls, 0);
});

test('обычная (не сетевая) ошибка тоже уводит на PostgREST', async () => {
  const log = [];
  const result = await createWriterWithFallback({
    backend: 'pg',
    connectionString: DB_URL,
    truncate: false,
    supabaseFallback: true,
    log: (line) => log.push(line),
    createPg: async () => {
      throw new Error('pg module is incomplete (Client/Pool/Query missing)');
    },
    createSupabase: async () => fakeWriter('supabase'),
  });

  assert.equal(result.backend, 'supabase');
  assert.ok(log.some((line) => line.includes('pg module is incomplete')));
});

test('supabase-режим по-прежнему не умеет --truncate', async () => {
  await assert.rejects(
    () =>
      createWriterWithFallback({
        backend: 'supabase',
        connectionString: null,
        truncate: true,
        supabaseFallback: true,
        createSupabase: async () => fakeWriter('supabase'),
      }),
    /--truncate доступен только при прямом подключении/,
  );
});

test('откат на PostgREST предупреждает, что TRUNCATE пропущен', async () => {
  const log = [];
  await createWriterWithFallback({
    backend: 'pg',
    connectionString: DB_URL,
    truncate: true,
    supabaseFallback: true,
    log: (line) => log.push(line),
    createPg: async () => {
      throw pgConnectionFailure();
    },
    createSupabase: async () => fakeWriter('supabase'),
  });

  assert.ok(log.some((line) => line.includes('TRUNCATE')), 'пропуск очистки не молчаливый');
});

// ─────────────────────── проверка из веб-процесса ───────────────────────
//
// В production-образе нет `scripts/`, поэтому «--check-db» там недоступен:
// диагностику отдаёт `checkGalaxyDbConnection` (Админка → «Каталог систем» →
// «Проверить подключение к БД», action `check-db`).

test('без DATABASE_URL проверка говорит про PostgREST', async () => {
  const check = await checkGalaxyDbConnection({ env: {} });

  assert.equal(check.direct.configured, false);
  assert.equal(check.direct.ok, false);
  assert.match(check.direct.message, /DATABASE_URL/);
  assert.equal(check.postgrest.configured, false);
  assert.equal(check.backend, null);
});

test('невидимый хост диагностируется одной попыткой', async () => {
  // Порт 1 на loopback отвечает ECONNREFUSED мгновенно — реальный сокет, без stub.
  const started = Date.now();
  const check = await checkGalaxyDbConnection({
    env: {
      DATABASE_URL: 'postgresql://postgres:s3cr3t@127.0.0.1:1/postgres',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    },
  });

  assert.equal(check.direct.configured, true);
  assert.equal(check.direct.ok, false);
  assert.equal(check.direct.host, '127.0.0.1');
  assert.match(check.direct.message, /не отвечает/);
  assert.ok(!check.direct.message.includes('s3cr3t'), 'пароль не уходит в интерфейс');
  assert.equal(check.postgrest.configured, true, 'импорт может уйти на PostgREST');
  assert.equal(check.backend, 'pg', 'приоритет прямого подключения сохраняется');
  assert.ok(Date.now() - started < 10_000, 'одна попытка, без полного расписания повторов');
});

test('нерезолвящийся хост даёт тот же диагноз, что видит оператор', async () => {
  const check = await checkGalaxyDbConnection({
    env: { DATABASE_URL: 'postgresql://postgres@db:5432/postgres' },
  });

  assert.equal(check.direct.ok, false);
  assert.equal(check.direct.host, 'db');
  assert.match(check.direct.message, /db/);
});
