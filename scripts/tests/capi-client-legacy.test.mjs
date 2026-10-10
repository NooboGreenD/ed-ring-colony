/**
 * Frontier CAPI клиент: fallback на Legacy-хост и разбор ответов.
 *
 * Пилот в Legacy-галактике (Horizons 3.8) на Live-хосте не существует:
 * `companion.orerve.net/profile` отвечает 400/404. Данные живут на
 * `legacy-companion.orerve.net` — сайт обязан пробовать его, как делает
 * Colonial Helper, и после успеха слать на тот же хост следующие запросы
 * сессии (журнал).
 *
 * При отказе обоих хостов наружу уходит ИСХОДНАЯ ошибка Live — 400 от Live
 * может означать отказ в правах, а не неверный OAuth-вход. Подмена его
 * ошибкой Legacy запутала бы диагностику.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CapiClient, CapiError } from '../../src/lib/capi/client.ts';

const PROFILE = {
  commander: { id: 42, name: 'Legacy Cmdr', credits: 123, rank: { combat: 2 } },
  lastSystem: { id: 1, name: 'Lave' },
  ship: { id: 9, name: 'Sidewinder' },
};

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const jsonResponse = (body, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

test('Live 400 → профиль берётся с Legacy-хоста, журнал идёт туда же', async () => {
  const net = stubFetch((url) => {
    if (url.startsWith('https://companion.orerve.net/profile')) {
      return jsonResponse({ message: 'Please Visit the store to purchase Elite: Dangerous' }, 400);
    }
    if (url.startsWith('https://legacy-companion.orerve.net/profile')) {
      return jsonResponse(PROFILE);
    }
    if (url.startsWith('https://legacy-companion.orerve.net/journal')) {
      return new Response(JSON.stringify({ timestamp: '2026-10-09T10:00:00Z', event: 'FSDJump', StarSystem: 'Lave' }), { status: 200 });
    }
    return jsonResponse({}, 404);
  });
  try {
    const client = new CapiClient('token');
    const profile = await client.getProfile();

    assert.equal(profile.cmdrName, 'Legacy Cmdr');
    assert.equal(profile.credits, 123);
    assert.equal(profile.currentSystem?.name, 'Lave');

    const journal = await client.getJournal();
    assert.equal(journal.events.length, 1, 'журнал запрошен с того же (Legacy) хоста');
    assert.ok(net.calls.some((url) => url.startsWith('https://legacy-companion.orerve.net/journal')));
  } finally {
    net.restore();
  }
});

test('Live 404 → тоже fallback на Legacy', async () => {
  const net = stubFetch((url) => {
    if (url.startsWith('https://companion.orerve.net/profile')) return jsonResponse({}, 404);
    if (url.startsWith('https://legacy-companion.orerve.net/profile')) return jsonResponse(PROFILE);
    return jsonResponse({}, 404);
  });
  try {
    const profile = await new CapiClient('token').getProfile();
    assert.equal(profile.cmdrName, 'Legacy Cmdr');
  } finally {
    net.restore();
  }
});

test('оба хоста отказали — наружу уходит исходная ошибка Live, не ошибка Legacy', async () => {
  const net = stubFetch((url) => {
    if (url.includes('/profile')) {
      return jsonResponse({ message: 'Please Visit the store to purchase Elite: Dangerous' }, 400);
    }
    return jsonResponse({}, 404);
  });
  try {
    await assert.rejects(
      () => new CapiClient('token').getProfile(),
      (err) => {
        assert.ok(err instanceof CapiError);
        assert.equal(err.kind, 'no_entitlement', 'диагностика видит настоящую причину 400 Live');
        assert.equal(err.status, 400);
        return true;
      },
    );
  } finally {
    net.restore();
  }
});

test('Live 418 (техобслуживание) — fallback на Legacy не срабатывает', async () => {
  const net = stubFetch((url) => {
    if (url.startsWith('https://companion.orerve.net/profile')) return jsonResponse({}, 418);
    return jsonResponse(PROFILE); // Legacy доступен, но вызываться не должен
  });
  try {
    await assert.rejects(
      () => new CapiClient('token').getProfile(),
      (err) => err instanceof CapiError && err.kind === 'maintenance',
    );
    assert.equal(net.calls.length, 1, 'лишний запрос на Legacy за чужой отказ не делается');
  } finally {
    net.restore();
  }
});
