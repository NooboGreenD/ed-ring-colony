/**
 * Подтверждение адреса из админки — Админка → Управление → Пользователи.
 *
 * Прод-случай, ради которого появились действия: пилот нажал «Подтвердить» по
 * ссылке из письма, получил ошибку, учётка осталась неподтверждённой. Ссылка при
 * этом одноразовая — если её потратил почтовый сканер, сам пилот сделать ничего
 * не может, а войти по паролю нельзя, пока адрес не подтверждён. Администратору
 * оставалось просить новое письмо и надеяться.
 *
 * Здесь проверяется:
 *   1. «Подтвердить email» подтверждает адрес сервисной ролью и не притворяется
 *      успехом, когда GoTrue отказал;
 *   2. уже подтверждённый адрес не «подтверждается» второй раз молча;
 *   3. «Отправить письмо заново» пишет на адрес пилота, а на подтверждённый
 *      адрес и адрес без почты — отказывает с отдельной причиной;
 *   4. маршруты закрыты администратором: без прав действие не выполняется;
 *   5. панель показывает статус из GoTrue и не подтверждает адрес вслепую.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dir = mkdtempSync(join(tmpdir(), 'edrc-admin-email-'));
after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, 'next.mjs'), `export class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
  }
}`);
writeFileSync(join(dir, 'auth.mjs'), `export async function requireAdmin() {
  return globalThis.__adminEmail.denied
    ? { response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) }
    : { actor: { userId: 'admin-a', role: 'admin' } };
}`);
writeFileSync(join(dir, 'admin.mjs'), `export function createAdminClient() {
  if (globalThis.__adminEmail.noServiceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return globalThis.__adminEmail.admin;
}`);
writeFileSync(join(dir, 'apiT.mjs'), `export async function apiTranslate() {
  return (key, params) => params
    ? key + ' ' + JSON.stringify(params)
    : key;
}`);

async function bundle(entry, name) {
  const outfile = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [join(ROOT, entry)], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'silent',
    alias: {
      'next/server': join(dir, 'next.mjs'),
      '@/lib/billing/auth': join(dir, 'auth.mjs'),
      '@/lib/supabaseAdmin': join(dir, 'admin.mjs'),
      '@/lib/i18n/apiT': join(dir, 'apiT.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
  });
  return import(outfile);
}

const actions = await bundle('src/lib/adminEmailActions.ts', 'actions');
const status = await bundle('src/app/api/admin/users/confirm-email/route.ts', 'status');
const confirm = await bundle('src/app/api/admin/users/[id]/confirm-email/route.ts', 'confirm');
const resend = await bundle('src/app/api/admin/users/[id]/resend-confirmation/route.ts', 'resend');

const USER_ID = '11111111-2222-4333-8444-555555555555';

/** Заглушка сервисного клиента Supabase: помнит вызовы, отвечает по сценарию. */
function reset(patch = {}) {
  const state = {
    denied: false,
    noServiceKey: false,
    users: { [USER_ID]: { id: USER_ID, email: 'pilot@example.net', email_confirmed_at: null } },
    updateError: null,
    getUserError: null,
    resendError: null,
    listError: null,
    listPages: null,
    updates: [],
    resends: [],
    inserts: [],
    ...patch,
  };
  state.admin = {
    auth: {
      admin: {
        getUserById: async (id) => {
          if (state.getUserError) return { data: { user: null }, error: { message: state.getUserError } };
          const user = state.users[id];
          return user
            ? { data: { user }, error: null }
            : { data: { user: null }, error: { message: 'User not found' } };
        },
        updateUserById: async (id, payload) => {
          state.updates.push({ id, payload });
          if (state.updateError) return { data: { user: null }, error: { message: state.updateError } };
          const user = state.users[id];
          return {
            data: { user: { ...user, email_confirmed_at: '2026-11-18T20:00:00.000Z' } },
            error: null,
          };
        },
        listUsers: async ({ page }) => {
          if (state.listError) return { data: null, error: { message: state.listError } };
          const pages = state.listPages ?? [Object.values(state.users)];
          return { data: { users: pages[page - 1] ?? [] }, error: null };
        },
      },
      resend: async (payload) => {
        state.resends.push(payload);
        return { error: state.resendError };
      },
    },
    from: () => ({
      insert: async (row) => { state.inserts.push(row); return { error: { code: '23505' } }; },
    }),
  };
  globalThis.__adminEmail = state;
  return state;
}

const post = (body = {}) => new Request('https://edringcolony.ru/api/admin/users/x', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const params = (id = USER_ID) => ({ params: Promise.resolve({ id }) });

test('«Подтвердить email» подтверждает адрес сервисной ролью, без письма и ссылки', async () => {
  const state = reset();
  const result = await actions.confirmUserEmail(state.admin, USER_ID);

  assert.equal(result.ok, true);
  assert.equal(result.changed, true, 'адрес действительно поменялся');
  assert.deepEqual(state.updates, [{ id: USER_ID, payload: { email_confirm: true } }],
    'то же, что делает переход по ссылке, только без токена');
  assert.equal(state.resends.length, 0, 'письмо при этом не отправляется');
  assert.equal(state.inserts.length, 1, 'профиль создаётся, чтобы кабинет не был пустым');
});

test('payload для GoTrue — ровно `email_confirm`, без подмены адреса', async () => {
  // Проверено живым запросом к фейковому GoTrue: PUT /auth/v1/admin/users/<id>
  // уходит с телом `{"email_confirm":true}`. Ни `email`, ни `password` маршрут
  // не передаёт — администратор подтверждает уже существующий адрес, а не
  // подставляет новый (иначе чужой адрес можно было бы «подтвердить» себе).
  const state = reset();
  await actions.confirmUserEmail(state.admin, USER_ID);
  const [update] = state.updates;
  assert.deepEqual(Object.keys(update.payload), ['email_confirm']);
  assert.equal(update.payload.email_confirm, true);
});

test('уже подтверждённый адрес не «подтверждается» второй раз', async () => {
  const state = reset({
    users: { [USER_ID]: { id: USER_ID, email: 'pilot@example.net', email_confirmed_at: '2026-11-01T10:00:00Z' } },
  });
  const result = await actions.confirmUserEmail(state.admin, USER_ID);

  assert.equal(result.ok, true);
  assert.equal(result.changed, false, 'панель должна сказать «уже подтверждён», а не «готово»');
  assert.deepEqual(state.updates, [], 'лишних записей в GoTrue нет');
});

test('отказ GoTrue не выдаётся за подтверждение', async () => {
  const state = reset({ updateError: 'Database error saving user' });
  const result = await actions.confirmUserEmail(state.admin, USER_ID);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'confirm_failed');
  assert.equal(result.status, 502);
  assert.doesNotMatch(result.message, /pilot@example\.net/, 'адрес пилота в текст ошибки не попадает');
});

test('несуществующий пилот — отдельная причина, без обращения к UpdateUser', async () => {
  const state = reset();
  for (const id of ['99999999-2222-4333-8444-555555555555']) {
    const result = await actions.confirmUserEmail(state.admin, id);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_found');
    assert.equal(result.status, 404);
  }
  assert.deepEqual(state.updates, [], 'подтверждать нечего — запроса нет');
});

test('«Отправить письмо заново» пишет на адрес пилота и ведёт на страницу подтверждения', async () => {
  const state = reset();
  process.env.NEXT_PUBLIC_SITE_URL = 'https://edringcolony.ru';
  const result = await actions.resendUserConfirmation(state.admin, USER_ID);

  assert.equal(result.ok, true);
  assert.deepEqual(state.resends, [{
    type: 'signup',
    email: 'pilot@example.net',
    // Та же страница, что у «Повторить подтверждение»: письмо обязано вести на
    // сайт, а не на API Supabase (это была причина 404 в 2.28.2).
    options: { emailRedirectTo: 'https://edringcolony.ru/auth/email' },
  }]);
});

test('письмо не отправляется на подтверждённый адрес и на аккаунт без почты', async () => {
  const confirmed = reset({
    users: { [USER_ID]: { id: USER_ID, email: 'pilot@example.net', email_confirmed_at: '2026-11-01T10:00:00Z' } },
  });
  const already = await actions.resendUserConfirmation(confirmed.admin, USER_ID);
  assert.equal(already.ok, false);
  assert.equal(already.error, 'already_confirmed');
  assert.equal(confirmed.resends.length, 0, 'GoTrue отказал бы, и «письмо отправлено» было бы ложью');

  const noEmail = reset({ users: { [USER_ID]: { id: USER_ID, email: '', email_confirmed_at: null } } });
  const empty = await actions.resendUserConfirmation(noEmail.admin, USER_ID);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'no_email');
  assert.equal(noEmail.resends.length, 0);
});

test('сбой SMTP/GoTrue при отправке письма называется своим сообщением', async () => {
  const state = reset({ resendError: 'Error sending confirmation email' });
  const result = await actions.resendUserConfirmation(state.admin, USER_ID);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'send_failed');
  assert.equal(result.status, 502);
});

/* ── маршруты ─────────────────────────────────────────────────────── */

test('маршрут подтверждения: без прав действие не выполняется', async () => {
  const state = reset({ denied: true });
  const response = await confirm.POST(post(), params());

  assert.equal(response.status, 403);
  assert.deepEqual(state.updates, [], 'чужой запрос не должен подтверждать адрес');
});

test('маршрут подтверждения: мусорный id отсекается до GoTrue', async () => {
  const state = reset();
  const response = await confirm.POST(post(), params('not-a-uuid'));
  assert.equal(response.status, 400);
  assert.deepEqual(state.updates, []);
});

test('маршрут подтверждения: успех, повтор и отказ различаются статусом и текстом', async () => {
  let state = reset();
  const ok = await confirm.POST(post(), params());
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.changed, true);
  assert.equal(okBody.confirmedAt, '2026-11-18T20:00:00.000Z', 'панель обновит строку без перезагрузки');
  assert.match(okBody.message, /admin\.emailConfirmDone/);

  state = reset({ updateError: 'boom' });
  const failed = await confirm.POST(post(), params());
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /admin\.emailConfirmFailed/);
});

test('маршрут отправки письма: причины отказа различимы', async () => {
  let state = reset();
  const ok = await resend.POST(post(), params());
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).message, /admin\.emailResent/);

  state = reset({
    users: { [USER_ID]: { id: USER_ID, email: 'pilot@example.net', email_confirmed_at: '2026-11-01T10:00:00Z' } },
  });
  assert.equal((await resend.POST(post(), params())).status, 409, 'адрес уже подтверждён');

  state = reset({ resendError: 'smtp down' });
  assert.equal((await resend.POST(post(), params())).status, 502, 'SMTP не принял письмо');
});

test('статус подтверждения: список адресов закрыт администратором и не выдумывается', async () => {
  let state = reset();
  state.users[USER_ID].email_confirmed_at = '2026-11-10T10:00:00Z';
  const response = await status.GET(new Request('https://edringcolony.ru/api/admin/users/confirm-email'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.unavailable, false);
  assert.equal(body.confirmed[USER_ID], '2026-11-10T10:00:00Z');
  assert.equal(response.headers.get('cache-control'), 'no-store');

  state = reset({ denied: true });
  assert.equal((await status.GET(new Request('https://edringcolony.ru/x'))).status, 403);

  state = reset({ noServiceKey: true });
  const noKey = await (await status.GET(new Request('https://edringcolony.ru/x'))).json();
  assert.equal(noKey.unavailable, true, 'без сервисной роли статус неизвестен, а не «всё хорошо»');
  assert.deepEqual(noKey.confirmed, {});

  state = reset({ listError: 'connection refused' });
  const down = await (await status.GET(new Request('https://edringcolony.ru/x'))).json();
  assert.equal(down.unavailable, true);
});

test('статус подтверждения читает весь список, а не первую страницу', async () => {
  // 200 — размер страницы GoTrue. Второй адрес приходит только со второй
  // страницы: без пагинации панель считала бы его «неизвестным».
  const first = Array.from({ length: 200 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    email_confirmed_at: '2026-11-10T10:00:00Z',
  }));
  const second = [{ id: USER_ID, email_confirmed_at: null }];
  const state = reset({ listPages: [first, second] });
  const body = await (await status.GET(new Request('https://edringcolony.ru/x'))).json();
  assert.equal(body.confirmed[USER_ID], null, 'второй страницы тоже видна');
  assert.equal(Object.keys(body.confirmed).length, 201);
});

test('панель: кнопка только у неподтверждённых, статус берётся из GoTrue', () => {
  const page = readFileSync(join(ROOT, 'src/app/admin/page.tsx'), 'utf8');

  // Статус приходит отдельным маршрутом — в profiles этого поля нет.
  assert.match(page, /authFetch\('\/api\/admin\/users\/confirm-email'/);
  assert.match(page, /admin\.mailConfirm/);
  assert.match(page, /admin\.mailResend/);
  // null — «неизвестно», а не «не подтверждён»: иначе все строки мигали бы.
  assert.match(page, /Object\.prototype\.hasOwnProperty\.call\(mailStatus, u\.id\)/);
  assert.match(page, /status === null && \(<>/);
  // После успеха строка обновляется без перезагрузки страницы.
  assert.match(page, /setMailStatus\(\(prev\) => \(\{ \.\.\.prev, \[id\]: body\.confirmedAt \}\)\)/);
  // Отказ сервера показывается текстом, а не теряется.
  assert.match(page, /setMailNotice\(\{ id, ok: false/);
});
