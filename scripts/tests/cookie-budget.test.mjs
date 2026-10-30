/**
 * Бюджет cookie: почему сайт «иногда не открывается из-за длинных cookies».
 *
 * Половина проверок — про чистую арифметику из `src/lib/cookieBudget.ts`:
 * какие куски сессии заведомо мёртвые и когда пора сбрасывать набор. Вторая
 * половина — про то, что пределы действительно подняты там, где их читает
 * сервер: nginx (`large_client_header_buffers`) и Node
 * (`--max-http-header-size`). Без них уборка в прокси не спасёт: браузер
 * получает 400/431 до того, как приложение увидит запрос.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { importBundle } from './helpers/bundle.mjs';

// Модуль собирается esbuild'ом вместе с его `./supabaseUrl`: Node умеет
// исполнять TypeScript, но не достраивает расширение у относительных импортов.
const {
  APP_COOKIE_PREFIXES,
  COOKIE_RESET_BYTES,
  COOKIE_WARN_BYTES,
  LEGACY_COOKIE_NAMES,
  RESET_MARKER_COOKIE,
  appCookieBytes,
  chunkIndexOf,
  cookieHeaderBytes,
  deadCookieNames,
  isAppCookie,
  resetCookieNames,
  shouldResetCookies,
} = await importBundle({ entry: 'src/lib/cookieBudget.ts' });

const ROOT = process.cwd();
const BASE = 'sb-edrc-auth-token';
const CHUNK = 3180;

/** Куски сессии так, как их пишет @supabase/ssr. */
function chunks(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `${BASE}.${index}`,
    value: 'x'.repeat(CHUNK),
  }));
}

/** Заголовок `Cookie` из списка cookie. */
function header(cookies) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

test('размер заголовка считается в байтах, а не в символах', () => {
  assert.equal(cookieHeaderBytes(''), 0);
  assert.equal(cookieHeaderBytes(null), 0);
  assert.equal(cookieHeaderBytes('a=b'), 3);
  // Кириллица в значении — два байта на символ: предел у сервера в байтах.
  assert.equal(cookieHeaderBytes('a=я'), 4);
});

test('номер куска распознаётся только у своей базовой cookie', () => {
  assert.equal(chunkIndexOf(`${BASE}.0`), 0);
  assert.equal(chunkIndexOf(`${BASE}.12`), 12);
  assert.equal(chunkIndexOf(BASE), null);
  assert.equal(chunkIndexOf(`${BASE}.01`), null);
  assert.equal(chunkIndexOf(`${BASE}.x`), null);
  assert.equal(chunkIndexOf('sb-other-auth-token.0'), null);
});

test('своими считаются только cookie приложения', () => {
  for (const prefix of APP_COOKIE_PREFIXES) assert.equal(isAppCookie(`${prefix}thing`), true);
  assert.equal(isAppCookie(LEGACY_COOKIE_NAMES[0]), true);
  assert.equal(isAppCookie('_ym_uid'), false);
  assert.equal(isAppCookie('cf_clearance'), false);
});

test('чужие cookie не попадают в счёт приложения', () => {
  const cookies = [{ name: `${BASE}.0`, value: 'x'.repeat(100) }, { name: '_ym_uid', value: 'y'.repeat(5000) }];
  const appOnly = appCookieBytes(cookies);
  assert.ok(appOnly > 100 && appOnly < 200, `ожидали ~110 байт, получили ${appOnly}`);
  assert.ok(cookieHeaderBytes(header(cookies)) > appOnly + 5000 - 1);
});

test('здоровая сессия из двух кусков не трогается', () => {
  assert.deepEqual(deadCookieNames(chunks(2)), []);
  assert.deepEqual(deadCookieNames([...chunks(2), { name: '_ym_uid', value: '1' }]), []);
});

test('базовая cookie перекрывает куски — куски удаляются', () => {
  // combineChunks читает базу первой и на ней останавливается, поэтому куски
  // в этом состоянии не читает никто: это до 6 КБ мёртвого груза.
  const cookies = [{ name: BASE, value: '{"access_token":"a"}' }, ...chunks(2)];
  assert.deepEqual(deadCookieNames(cookies).sort(), [`${BASE}.0`, `${BASE}.1`]);
});

test('кусок после дырки в нумерации удаляется', () => {
  // Нет .0 — чтение обрывается сразу, .1 и .2 не прочитать.
  const cookies = [chunks(3)[1], chunks(3)[2]];
  assert.deepEqual(deadCookieNames(cookies).sort(), [`${BASE}.1`, `${BASE}.2`]);
});

test('старая cookie входа и пустые значения тоже мусор', () => {
  const cookies = [
    { name: 'sb-session', value: 'legacy' },
    { name: `${BASE}-code-verifier`, value: '' },
    ...chunks(1),
  ];
  assert.deepEqual(deadCookieNames(cookies).sort(), ['sb-session', `${BASE}-code-verifier`].sort());
});

test('сброс не срабатывает на нормальном заголовке', () => {
  const cookies = chunks(3);
  const size = cookieHeaderBytes(header(cookies));
  assert.ok(size > COOKIE_WARN_BYTES, 'три куска уже выше предела nginx по умолчанию');
  assert.equal(shouldResetCookies({ headerBytes: size, cookies, marker: false, method: 'GET', path: '/account' }),
    false, 'живая сессия не повод выкидывать пилота');
});

test('сброс срабатывает на разросшемся наборе наших cookie', () => {
  const cookies = chunks(7);
  assert.equal(shouldResetCookies({
    headerBytes: cookieHeaderBytes(header(cookies)),
    cookies, marker: false, method: 'GET', path: '/account',
  }), true);
});

test('сброс не трогает чужие cookie, отметку, API и не-GET', () => {
  const ours = chunks(7);
  const size = cookieHeaderBytes(header(ours));
  const base = { headerBytes: size, cookies: ours, marker: false, method: 'GET', path: '/' };

  assert.equal(shouldResetCookies({ ...base, headerBytes: COOKIE_RESET_BYTES - 1 }), false);
  assert.equal(shouldResetCookies({ ...base, marker: true }), false, 'вторая переадресация за минуту — это цикл');
  assert.equal(shouldResetCookies({ ...base, method: 'POST' }), false, 'переадресация потеряла бы тело');
  assert.equal(shouldResetCookies({ ...base, path: '/api/capi/profile' }), false);
  assert.equal(shouldResetCookies({ ...base, path: '/auth/callback' }), false);
  assert.equal(shouldResetCookies({
    ...base,
    cookies: [{ name: '_ym_uid', value: 'y'.repeat(30_000) }],
  }), false, 'наши cookie не виноваты — сброс ничего не даст, только выход из аккаунта');
});

test('сброс перечисляет все наши cookie и не трогает отметку', () => {
  const cookies = [{ name: `${BASE}.0`, value: 'a' }, { name: 'capi_state', value: 'b' },
    { name: 'edrc-oauth-flow', value: 'c' }, { name: RESET_MARKER_COOKIE, value: '1' },
    { name: '_ym_uid', value: 'd' }];
  assert.deepEqual(resetCookieNames(cookies).sort(), ['capi_state', 'edrc-oauth-flow', `${BASE}.0`]);
});

// ── пределы на сервере ────────────────────────────────────────────────────
test('nginx пропускает заголовок с запасом на живую сессию', () => {
  for (const file of ['deploy/nginx.conf', 'deploy/selfhost/nginx-selfhost.conf']) {
    const config = readFileSync(join(ROOT, file), 'utf8');
    const buffers = config.match(/^\s*large_client_header_buffers\s+(\d+)\s+(\d+)k/m);
    assert.ok(buffers, `${file}: нет large_client_header_buffers — действует предел 8k`);
    assert.ok(Number(buffers[2]) >= 32, `${file}: ${buffers[2]}k мало, нужно не меньше 32k`);
    assert.ok(Number(buffers[1]) >= 4, `${file}: слишком мало буферов`);
    assert.match(config, /client_header_buffer_size\s+8k/, `${file}: размер первого буфера`);
  }
});

test('Node запускается с поднятым пределом заголовков', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /CMD \["node", "--max-http-header-size=32768", "server\.js"\]/,
    'контейнер: без флага предел 16 КиБ и браузер получает 431');
  const unit = readFileSync(join(ROOT, 'deploy/ed-ring-colony.service'), 'utf8');
  assert.match(unit, /NODE_OPTIONS=--max-http-header-size=32768/,
    'systemd-установка: тот же предел, иначе исправление работает только в Docker');
});

test('прокси проходит через бюджет cookie и возвращает ответ как раньше', async () => {
  const stubs = {
    'next/server': `
export class NextResponse extends Response {
  constructor(body, init) {
    super(body, init);
    const values = new Map();
    this.cookies = {
      set(name, value, options) { values.set(name, { name, value, ...options }); },
      delete(name) { values.set(name, { name, value: '', maxAge: 0 }); },
      get(name) { return values.get(name); },
      getAll() { return [...values.values()]; },
    };
  }
  static next(init) { return new NextResponse(null, { status: 200, ...(init || {}) }); }
  static rewrite(url, init) { return new NextResponse(null, { status: 503, ...(init || {}) }); }
  static redirect(url, status = 307) { return new NextResponse(null, { status, headers: { Location: String(url) } }); }
  static json(body, init) { return new NextResponse(JSON.stringify(body), init); }
}
`,
    '@supabase/ssr': `export function createServerClient() {
  return { auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
}`,
    '@/lib/maintenanceEdge': `export async function readMaintenanceCached() { return { active: false }; }`,
  };

  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.edringcolony.ru';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon';
  const { proxy } = await importBundle({ entry: 'src/proxy.ts', stubs });

  const request = (cookies, path = '/account', method = 'GET') => {
    const headers = cookies.length ? { cookie: header(cookies) } : {};
    const req = new Request(`https://edringcolony.ru${path}`, { method, headers });
    req.nextUrl = new URL(req.url);
    req.cookies = {
      getAll: () => cookies,
      get: name => cookies.find(cookie => cookie.name === name),
    };
    return req;
  };

  // Обычный запрос: ничего не удаляем и не переадресуем.
  const plain = await proxy(request([]));
  assert.equal(plain.status, 200);
  assert.equal(plain.cookies.getAll().length, 0);

  // Мёртвый кусок удаляется тем же ответом, который уходит в браузер.
  const stale = await proxy(request([{ name: BASE, value: '{"access_token":"a"}' }, chunks(2)[0]]));
  assert.equal(stale.status, 200);
  const expired = stale.cookies.get(`${BASE}.0`);
  assert.equal(expired.value, '');
  assert.equal(expired.maxAge, 0);
  assert.equal(expired.path, '/');
  assert.equal(stale.cookies.get(BASE), undefined, 'живую базовую cookie удалять нельзя');

  // Разросшийся набор: переадресация на тот же адрес, наши cookie стёрты.
  const huge = await proxy(request(chunks(7)));
  assert.equal(huge.status, 307);
  assert.equal(huge.headers.get('Location'), 'https://edringcolony.ru/account');
  for (const name of [`${BASE}.0`, `${BASE}.6`]) {
    assert.equal(huge.cookies.get(name).maxAge, 0, `${name} должен быть стёрт`);
  }
  assert.equal(huge.cookies.get(RESET_MARKER_COOKIE).value, '1', 'без отметки сброс зациклится');
});
