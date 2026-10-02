import test from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateAddress, probePgReachability } from '../../src/lib/pgReachability.ts';

/* ──────────────────────────────────────────────────────────────────────────
   «прямой Postgres (db) недоступен · timeout expired · похоже на firewall».

   Драйвер pg на любую сетевую беду отвечает одной строкой, и оператор идёт
   чинить firewall там, где на самом деле контейнер web просто не в сети
   стека Supabase, а короткое имя `db` увёл в сторону внешний DNS. Контракт:
     · имя не резолвится            → подключить web к сети Supabase;
     · резолвится в публичный адрес → это НЕ firewall, это чужой хост;
     · приватный адрес + таймаут    → вот теперь действительно сеть;
     · connection refused           → Postgres не слушает этот порт;
     · TCP открылся                 → причина не сетевая.
   ────────────────────────────────────────────────────────────────────────── */

const lookupFails = async () => {
  throw Object.assign(new Error('getaddrinfo EAI_AGAIN db'), { code: 'EAI_AGAIN' });
};
const lookupTo = (...addresses) => async () => addresses.map((address) => ({ address }));
const tcp = (result) => async () => result;

test('приватные и публичные адреса различаются', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.18.0.5', '192.168.1.10', 'fd00::1']) {
    assert.ok(isPrivateAddress(address), address);
  }
  for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '203.0.113.7']) {
    assert.ok(!isPrivateAddress(address), address);
  }
});

test('имя не резолвится — зовём подключить web к сети Supabase', async () => {
  const probe = await probePgReachability('db', 5432, { lookupImpl: lookupFails, probeImpl: tcp('timeout') });
  assert.equal(probe.kind, 'dns-missing');
  assert.deepEqual(probe.addresses, []);
  assert.match(probe.message, /не резолвится/);
  assert.match(probe.message, /compose\.supabase-net\.yml/);
});

test('публичный адрес + таймаут — это не firewall, а чужой хост', async () => {
  const probe = await probePgReachability('db', 5432, {
    lookupImpl: lookupTo('203.0.113.7'),
    probeImpl: tcp('timeout'),
  });
  assert.equal(probe.kind, 'dns-public');
  assert.match(probe.message, /ПУБЛИЧНЫЙ адрес 203\.0\.113\.7/);
  assert.match(probe.message, /firewall здесь ни при чём/);
});

test('приватный адрес + таймаут — настоящая сетевая проблема', async () => {
  const probe = await probePgReachability('db', 5432, {
    lookupImpl: lookupTo('172.18.0.5'),
    probeImpl: tcp('timeout'),
  });
  assert.equal(probe.kind, 'tcp-timeout');
  assert.match(probe.message, /docker network inspect|DOCKER-USER/);
});

test('refused — Postgres не слушает этот порт', async () => {
  const probe = await probePgReachability('127.0.0.1', 5433, {
    lookupImpl: lookupTo('127.0.0.1'),
    probeImpl: tcp('refused'),
  });
  assert.equal(probe.kind, 'tcp-refused');
  assert.match(probe.message, /порт закрыт/);
});

test('TCP открылся — причина отказа не сетевая', async () => {
  const probe = await probePgReachability('db', 5432, {
    lookupImpl: lookupTo('172.18.0.5'),
    probeImpl: tcp('ok'),
  });
  assert.equal(probe.kind, 'ok');
  assert.match(probe.message, /не сетевая/);
});

test('проба не ходит в сеть, когда адрес уже открылся первым же кандидатом', async () => {
  const tried = [];
  await probePgReachability('db', 5432, {
    lookupImpl: lookupTo('172.18.0.5', '172.18.0.6'),
    probeImpl: async (host) => {
      tried.push(host);
      return 'ok';
    },
  });
  assert.deepEqual(tried, ['172.18.0.5']);
});
