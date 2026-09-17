import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  FRONTIER_PUBLIC_CLIENT_ID,
  buildAuthUrl,
  createCodeChallenge,
  createCodeVerifier,
  createPkcePair,
  exchangeCode,
  frontierClientId,
  isPkceConfigured,
  isTokenExpiredStatus,
} from '../../src/lib/capi/oauth.ts';

// Все тесты ниже работают с подменённым окружением: OAuth-функции читают
// process.env в момент вызова, поэтому достаточно поставить/снять переменные.
// Файл `.mjs`, поэтому TypeScript-аннотаций здесь быть не должно: Node их не
// вырезает и падает с SyntaxError, а `npm test` при этом просто теряет файл.
function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const REDIRECT = 'https://example.test/api/capi/callback';

test('верификатор PKCE сохраняет «=», challenge — нет', () => {
  const verifier = createCodeVerifier();
  assert.equal(verifier.length, 44);
  assert.ok(verifier.endsWith('='), 'Frontier требует «=» у code_verifier');
  assert.ok(!verifier.includes('+') && !verifier.includes('/'), 'URL-safe base64');

  const challenge = createCodeChallenge(verifier);
  assert.ok(!challenge.endsWith('='), 'challenge обязан быть без «=»');
  const expected = createHash('sha256').update(verifier, 'utf8').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);
});

test('вектор из RFC 7636 сходится', () => {
  assert.equal(
    createCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('пара PKCE согласована и уникальна', () => {
  const first = createPkcePair();
  const second = createPkcePair();
  assert.equal(first.challenge, createCodeChallenge(first.verifier));
  assert.notEqual(first.verifier, second.verifier);
});

test('ссылка авторизации содержит PKCE-параметры', () => {
  const url = withEnv({ FRONTIER_REDIRECT_URI: REDIRECT }, () =>
    buildAuthUrl('st8', { codeChallenge: 'ch123' }));
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://auth.frontierstore.net/auth');
  assert.equal(parsed.searchParams.get('code_challenge'), 'ch123');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('audience'), 'frontier');
  assert.equal(parsed.searchParams.get('scope'), 'auth capi');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('state'), 'st8');
  assert.equal(parsed.searchParams.get('redirect_uri'), REDIRECT);
  // Секрет в URL попадать не должен никогда.
  assert.equal(parsed.searchParams.has('client_secret'), false);
});

test('client_id по умолчанию — публичный клиент Frontier, секрет не нужен', () => {
  const clientId = withEnv({ FRONTIER_CLIENT_ID: undefined, FRONTIER_CLIENT_SECRET: undefined },
    () => frontierClientId());
  assert.equal(clientId, FRONTIER_PUBLIC_CLIENT_ID);
  // «Настроен» означает наличие redirect_uri, а не секрета.
  assert.equal(withEnv({ FRONTIER_REDIRECT_URI: REDIRECT }, () => isPkceConfigured()), true);
  assert.equal(withEnv({ FRONTIER_REDIRECT_URI: undefined }, () => isPkceConfigured()), false);
});

test('обмен кода требует верификатор или секрет', async () => {
  await withEnv({ FRONTIER_REDIRECT_URI: REDIRECT, FRONTIER_CLIENT_SECRET: undefined },
    async () => {
      await assert.rejects(() => exchangeCode('code', {}), /code verifier|CLIENT_SECRET/);
    });
});

test('обмен кода отправляет code_verifier без client_secret', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', expires_in: 14400, token_type: 'Bearer',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const tokens = await withEnv(
      { FRONTIER_REDIRECT_URI: REDIRECT, FRONTIER_CLIENT_SECRET: undefined },
      () => exchangeCode('the-code', { codeVerifier: 'verifier=' }),
    );
    assert.equal(tokens.access_token, 'at');
    assert.equal(captured.url, 'https://auth.frontierstore.net/token');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['Content-Type'], 'application/x-www-form-urlencoded');

    const body = String(captured.init.body);
    assert.ok(body.includes('grant_type=authorization_code'), body);
    assert.ok(body.includes('code_verifier=verifier%3D'), '«=» в верификаторе сохраняется');
    assert.equal(body.includes('client_secret'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CAPI 422 считается истёкшим токеном', () => {
  for (const status of [401, 403, 422]) assert.equal(isTokenExpiredStatus(status), true, String(status));
  for (const status of [200, 404, 500]) assert.equal(isTokenExpiredStatus(status), false, String(status));
});
