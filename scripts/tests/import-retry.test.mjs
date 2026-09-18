import test from 'node:test';
import assert from 'node:assert/strict';

import { sendInChunks } from '../../src/lib/importRetry.ts';

/* ──────────────────────────────────────────────────────────────────────────
   `sendInChunks` — ядро исправления бага «загрузка обрывается на 30-м пакете
   из 500+». Проверки ниже описывают контракт:
     · одна неудачная пачка не обрывает остальные;
     · отложенные пачки повторяются, и между проходами есть пауза;
     · неисчерпаемый отказ попадает в `deferred`, а не в исключение.
   ────────────────────────────────────────────────────────────────────────── */

/** Стаб отправки: `script` описывает ответ по номеру вызова. */
function makeSender(script) {
  const sent = [];
  return {
    sent,
    send: async (chunk) => {
      sent.push(chunk);
      const step = script(sent.length - 1) ?? script(script.length - 1);
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const noSleep = async () => {};

/** Разбить список на пачки заданного размера. */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

test('все пачки доходят, когда база справляется', async () => {
  const { sent, send } = makeSender(() => ({ inserted: 2, duplicates: 0, deferred: 0 }));
  const outcome = await sendInChunks(chunk([1, 2, 3, 4, 5, 6], 2), { send, sleep: noSleep });

  assert.equal(sent.length, 3, 'пачек отправлено три');
  assert.equal(outcome.inserted, 6);
  assert.equal(outcome.deferred, 0);
  assert.equal(outcome.retriedChunks, 0, 'повторов не было');
});

test('сбой одной пачки не обрывает остальные', async () => {
  // Исходный баг: исключение на 30-м пакете обрывало загрузку 500+ пачек.
  const { sent, send } = makeSender((i) => (i === 0 ? new Error('network down') : { inserted: 2, deferred: 0 }));
  const outcome = await sendInChunks(chunk([1, 2, 3, 4, 5, 6], 2), { send, sleep: noSleep });

  assert.equal(sent.length, 4, 'первая пачка повторена, остальные две дошли');
  assert.equal(outcome.inserted, 6, 'потерянная пачка записана при повторе');
  assert.equal(outcome.deferred, 0);
});

test('отложенные пачки повторяются и дозаписываются', async () => {
  // Первый вызов каждой пачки откладывает половину строк, повтор succeeds.
  const { sent, send } = makeSender((i) => (i < 2 ? { inserted: 1, deferred: 1 } : { inserted: 1, deferred: 0 }));
  const outcome = await sendInChunks(chunk([1, 2, 3, 4], 2), { send, sleep: noSleep });

  assert.equal(sent.length, 4, 'обе пачки повторены');
  assert.equal(outcome.deferred, 0, 'повтор закрыл отставание');
  assert.equal(outcome.retriedChunks, 2);
});

test('между повторными проходами есть пауза', async () => {
  // Пауза обязательна: база только что не успела по statement_timeout, и
  // мгновенный повтор почти наверняка не успеет снова.
  const sleeps = [];
  const { send } = makeSender((i) => (i < 2 ? { inserted: 1, deferred: 1 } : { inserted: 1, deferred: 0 }));
  await sendInChunks(chunk([1, 2, 3, 4], 2), {
    send,
    retryDelayMs: 1500,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(sleeps, [1500], 'ровно одна пауза перед повторным проходом');
});

test('исчерпанный повтор попадает в deferred, а не в исключение', async () => {
  const { send } = makeSender(() => ({ inserted: 0, deferred: 2 }));
  const outcome = await sendInChunks(chunk([1, 2, 3, 4], 2), { send, sleep: noSleep, retryPasses: 2 });

  assert.equal(outcome.deferred, 4, 'обе пачки остались незаписанными');
  assert.equal(outcome.retriedChunks, 4, 'каждая пачка повторена дважды');
});

test('бесконечно падающая пачка не зацикливает загрузку', async () => {
  const { sent, send } = makeSender(() => new Error('always down'));
  const outcome = await sendInChunks(chunk([1, 2, 3, 4], 2), { send, sleep: noSleep, retryPasses: 3 });

  // 2 пачки × (1 основной + 3 повтора) = 8 вызовов, и не больше.
  assert.equal(sent.length, 8, 'число повторов ограничено');
  assert.equal(outcome.deferred, 4, 'незаписанные строки учтены');
});

test('прогресс основного прохода растёт от 1 до total', async () => {
  const seen = [];
  const { send } = makeSender(() => ({ inserted: 1, deferred: 0 }));
  await sendInChunks(chunk([1, 2, 3], 1), {
    send,
    sleep: noSleep,
    onProgress: (index, total) => seen.push([index, total]),
  });

  assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]]);
});

test('пустой список не отправляет ничего', async () => {
  const { sent, send } = makeSender(() => ({ inserted: 1, deferred: 0 }));
  const outcome = await sendInChunks([], { send, sleep: noSleep });

  assert.equal(sent.length, 0);
  assert.equal(outcome.inserted, 0);
  assert.equal(outcome.deferred, 0);
});
