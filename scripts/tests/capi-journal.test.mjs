import test from 'node:test';
import assert from 'node:assert/strict';
import { journalPath, parseCapiJournal } from '../../src/lib/capi/journal.ts';
import { CapiClient, capiUserAgent, describeCapiError, isUnauthorizedError, needsCapiRelink } from '../../src/lib/capi/client.ts';

/* ──────────────────────────────────────────────────────────────────────────
   `/journal` отдаёт СЫРОЙ журнал построчным JSON. Прежний код делал
   res.json() и читал `journal.events` — то есть падал на каждом ответе, а
   весь синк отвечал 500 и не сохранял ничего.
   ────────────────────────────────────────────────────────────────────────── */

const NDJSON = [
  '{"timestamp":"2026-09-27T10:00:00Z","event":"FSDJump","StarSystem":"Colonia"}',
  '{"timestamp":"2026-09-27T10:05:00Z","event":"Docked","StationName":"Jaques Station"}',
].join('\n');

test('NDJSON журнала разбирается построчно', () => {
  const journal = parseCapiJournal(NDJSON);
  assert.equal(journal.events.length, 2);
  assert.equal(journal.events[0].event, 'FSDJump');
  assert.equal(journal.empty, false);
  assert.equal(journal.malformedLines, 0);
  // Текст пригоден для parseColonisationEvents(): тот ждёт строки журнала.
  assert.equal(journal.text.split('\n').length, 2);
});

test('обрезанная последняя строка не теряет остальные события', () => {
  const journal = parseCapiJournal(`${NDJSON}\n{"timestamp":"2026-09-27T10:06`);
  assert.equal(journal.events.length, 2);
  assert.equal(journal.malformedLines, 1);
});

test('пустое тело — это «сегодня не играли», а не ошибка', () => {
  const journal = parseCapiJournal('');
  assert.deepEqual(journal.events, []);
  assert.equal(journal.empty, true);
  assert.equal(journal.text, '');
});

test('формы {events:[...]} и [...] тоже принимаются', () => {
  const wrapped = parseCapiJournal(JSON.stringify({ events: [{ event: 'Scan' }] }));
  assert.equal(wrapped.events.length, 1);
  const array = parseCapiJournal(JSON.stringify([{ event: 'Scan' }, { event: 'Docked' }]));
  assert.equal(array.events.length, 2);
});

test('дата журнала уходит в путь, а не в query', () => {
  assert.equal(journalPath(), '/journal');
  assert.equal(journalPath('2026-09-27'), '/journal/2026/09/27');
  assert.throws(() => journalPath('27.09.2026'), /YYYY-MM-DD/);
});

test('User-Agent соответствует требованию Frontier EDCD-<App>-<version>', () => {
  assert.match(capiUserAgent('2.12.0'), /^EDCD-[A-Za-z]+-[.0-9]+$/);
  assert.match(capiUserAgent(undefined), /^EDCD-[A-Za-z]+-[.0-9]+$/);
  assert.match(capiUserAgent('v2.12.0-beta'), /^EDCD-[A-Za-z]+-[.0-9]+$/);
});

/* ── Коды ответа CAPI ──────────────────────────────────────────────────── */

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}

test('422 и 401 означают «нужен refresh», 418 — техобслуживание', async () => {
  for (const status of [401, 403, 422]) {
    await withFetch(async () => new Response('', { status }), async () => {
      const client = new CapiClient('token');
      await assert.rejects(() => client.getProfile(), (err) => {
        assert.equal(isUnauthorizedError(err), true, `status ${status}`);
        return true;
      });
    });
  }

  await withFetch(async () => new Response('teapot', { status: 418 }), async () => {
    const client = new CapiClient('token');
    await assert.rejects(() => client.getProfile(), (err) => {
      assert.equal(err.kind, 'maintenance');
      assert.equal(isUnauthorizedError(err), false, 'обновлять токен бессмысленно');
      assert.match(describeCapiError(err), /техобслуживани/i);
      return true;
    });
  });
});

test('204 на журнал не роняет синк', async () => {
  await withFetch(async () => new Response(null, { status: 204 }), async () => {
    const client = new CapiClient('token');
    const journal = await client.getJournal();
    assert.equal(journal.empty, true);
    assert.deepEqual(journal.events, []);
  });
});

test('206 помечается как частичный журнал', async () => {
  await withFetch(async () => new Response(NDJSON, { status: 206 }), async () => {
    const client = new CapiClient('token');
    const journal = await client.getJournal();
    assert.equal(journal.partial, true);
    assert.equal(journal.events.length, 2);
  });
});

test('журнал за дату запрашивается путём /journal/YYYY/MM/DD', async () => {
  let requested = null;
  await withFetch(async (url) => {
    requested = String(url);
    return new Response(NDJSON, { status: 200 });
  }, async () => {
    await new CapiClient('token').getJournal('2026-09-27');
  });
  assert.equal(requested, 'https://companion.orerve.net/journal/2026/09/27');
});

test('профиль возвращается уже нормализованным', async () => {
  await withFetch(async () => new Response(JSON.stringify({
    commander: { name: 'Nova', credits: 42, rank: { combat: 2 } },
    lastSystem: { name: 'Sol' },
  }), { status: 200 }), async () => {
    const profile = await new CapiClient('token').getProfile();
    assert.equal(profile.cmdrName, 'Nova');
    assert.equal(profile.credits, 42);
    assert.equal(profile.ranks.combat, 2);
    assert.equal(profile.currentSystem?.name, 'Sol');
  });
});

test('пустое тело на /profile — понятная ошибка, а не SyntaxError', async () => {
  await withFetch(async () => new Response('', { status: 200 }), async () => {
    await assert.rejects(() => new CapiClient('token').getProfile(), (err) => {
      assert.equal(err.kind, 'no_content');
      assert.match(describeCapiError(err), /не заходил в игру/);
      return true;
    });
  });
});

test('запрос уходит с Bearer-токеном и корректным User-Agent', async () => {
  let headers = null;
  await withFetch(async (_url, init) => {
    headers = init.headers;
    return new Response(JSON.stringify({ commander: { name: 'Nova' } }), { status: 200 });
  }, async () => {
    await new CapiClient('secret-token').getProfile();
  });
  assert.equal(headers.Authorization, 'Bearer secret-token');
  assert.match(headers['User-Agent'], /^EDCD-EDRingColony-[.0-9]+$/);
});

/* ──────────────────────────────────────────────────────────────────────────
   HTTP 400 от CAPI — это не «кривой запрос», а «за аккаунтом нет игры»:
   токен выдан учётке магазина Frontier, тогда как игра куплена в Steam или
   Epic. Пилот в этот момент видел «HTTP 400» и считал привязку сломанной
   без единой подсказки, что делать.
   ────────────────────────────────────────────────────────────────────────── */

test('400 распознаётся как «аккаунт без Elite Dangerous», а не как сбой сервера', async () => {
  await withFetch(
    async () => new Response('Please Visit the store to purchase Elite: Dangerous.', { status: 400 }),
    async () => {
      await assert.rejects(() => new CapiClient('token').getProfile(), (err) => {
        assert.equal(err.kind, 'no_entitlement');
        assert.equal(err.status, 400);
        // Повторять запрос бессмысленно, обновлять токен — тоже.
        assert.equal(isUnauthorizedError(err), false);
        assert.equal(needsCapiRelink(err), true, 'неверная платформа требует переподключения');
        const text = describeCapiError(err);
        assert.match(text, /не видит купленную Elite Dangerous/);
        assert.match(text, /Steam/);
        assert.match(text, /Epic/);
        return true;
      });
    },
  );
});

test('прочие 4xx/5xx остаются «ошибкой сервера»', async () => {
  await withFetch(async () => new Response('nope', { status: 500 }), async () => {
    await assert.rejects(() => new CapiClient('token').getProfile(), (err) => {
      assert.equal(err.kind, 'server');
      assert.match(describeCapiError(err), /ошибкой 500/);
      return true;
    });
  });
});
