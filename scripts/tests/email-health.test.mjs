import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Диагностика регистрации и почты (Админка → Авторизация → «Отправка писем»).
 *
 * Прод-случай, ради которого появился файл: сайт отвечает «Новые регистрации
 * временно закрыты», диагностика показывает «disable_signup=true» и советует
 * «Выставьте GOTRUE_DISABLE_SIGNUP=false». Совет не работал: compose
 * подставляет в GOTRUE_DISABLE_SIGNUP значение DISABLE_SIGNUP из
 * /opt/supabase/.env, а строка GOTRUE_DISABLE_SIGNUP=false в этом файле не
 * влияет ни на что. Плюс без пересоздания контейнера auth GoTrue продолжает
 * жить со старым окружением.
 *
 * Здесь проверяется:
 *   1. что подсказка называет рабочее имя ключа и рабочую кнопку;
 *   2. что причина передаётся панели машинно (`action`), чтобы был один клик;
 *   3. что кнопка в панели пишет именно DISABLE_SIGNUP=false и запускает
 *      применение (иначе правка снова останется в файле, но не в контейнере).
 */

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dir = mkdtempSync(join(tmpdir(), 'edrc-email-health-'));
after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, 'next.mjs'), `export class NextResponse extends Response {
  static json(body, init) { return new NextResponse(JSON.stringify(body), init); }
}`);
writeFileSync(join(dir, 'billing-auth.mjs'), `export async function requireAdmin() {
  return globalThis.__health.adminDenied
    ? { response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) }
    : { actor: { id: 'admin-a' } };
}
export function errorResponse(err, status = 500) {
  return new Response(JSON.stringify({ error: String(err) }), { status });
}`);
writeFileSync(join(dir, 'public-url.mjs'), `export function getPublicSupabaseUrl() {
  return globalThis.__health.publicUrl ?? 'https://edringcolony.ru/api/supabase';
}`);
writeFileSync(join(dir, 'server-url.mjs'), `export function getServerSupabaseUrl() {
  return globalThis.__health.serverUrl ?? 'http://192.168.8.177:9100';
}`);
writeFileSync(join(dir, 'agent.mjs'), `export async function listSmtpKeys() {
  return globalThis.__health.agent ?? { ok: false, status: 503, error: 'agent unavailable' };
}`);

const outfile = join(dir, 'email-health.mjs');
await build({
  entryPoints: [join(ROOT, 'src/app/api/admin/email-health/route.ts')],
  outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  alias: {
    'next/server': join(dir, 'next.mjs'),
    '@/lib/billing/auth': join(dir, 'billing-auth.mjs'),
    '@/lib/supabaseUrl': join(dir, 'public-url.mjs'),
    '@/lib/supabaseServerUrl': join(dir, 'server-url.mjs'),
    '@/lib/updateAgent': join(dir, 'agent.mjs'),
    '@': join(ROOT, 'src'),
  },
});
const route = await import(outfile);

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

/** Заглушка GoTrue: /auth/v1/settings отвечает заданным набором полей. */
function gotrue(settings, { reachable = true, users = null, usersStatus = 200 } = {}) {
  globalThis.__health = { adminDenied: false, publicUrl: undefined, serverUrl: undefined };
  globalThis.fetch = async (url, options = {}) => {
    if (!reachable) throw Object.assign(new TypeError('fetch failed'), { cause: 'connect ECONNREFUSED' });
    if (String(url).includes('/auth/v1/admin/users')) {
      // Админский список закрыт ключом сервисной роли — без него проверка
      // «подтверждён ли адрес» не должна выглядеть пройденной.
      assert.equal(options.headers?.Authorization, 'Bearer test-service-role',
        'список пользователей читается только сервисной ролью');
      return new Response(JSON.stringify(users ?? { users: [] }), { status: usersStatus });
    }
    assert.match(String(url), /\/auth\/v1\/settings$/);
    return new Response(JSON.stringify(settings), { status: 200 });
  };
}

/** Пользователь GoTrue: `email_confirmed_at` — единственный признак подтверждения. */
function pilot(id, { confirmed = true, ageMinutes = 120 } = {}) {
  const created = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  return {
    id, email: `${id}@example.net`, created_at: created,
    email_confirmed_at: confirmed ? created : null,
  };
}

/**
 * Подменяет переменные окружения до конца файла.
 *
 * Исходные значения запоминаются ОДИН раз, на первый вызов. Раньше каждая
 * подмена регистрировала свой `after` и запоминала то, что стояло на момент
 * вызова: второй `env({ AUTH_EMAIL_ENABLED: 'true' })` запоминал уже
 * выставленное `'false'`, и после файла переменная оставалась выключенной —
 * проверки, идущие следом, видели чужое состояние.
 */
const SAVED_ENV = new Map();
function env(patch) {
  const first = SAVED_ENV.size === 0;
  for (const [key, value] of Object.entries(patch)) {
    if (!SAVED_ENV.has(key)) SAVED_ENV.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (!first) return;
  after(() => {
    for (const [key, value] of SAVED_ENV) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    SAVED_ENV.clear();
  });
}

env({
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  AUTH_EMAIL_ENABLED: 'true',
  NEXT_PUBLIC_SITE_URL: 'https://edringcolony.ru',
});

async function diagnose() {
  const response = await route.GET(new Request('https://edringcolony.ru/api/admin/email-health'));
  assert.equal(response.status, 200);
  return response.json();
}

const check = (body, id) => body.checks.find((item) => item.id === id);

test('диагностика: закрытая регистрация — рабочая подсказка и машинное действие', async () => {
  gotrue({ mailer_autoconfirm: false, disable_signup: true, external: { email: true } });
  const body = await diagnose();

  assert.equal(body.ok, false);
  const signup = check(body, 'signup');
  assert.equal(signup.ok, false);
  assert.equal(signup.action, 'enable-signup', 'панель должна получить машиночитаемую причину');

  // Главное: совет ведёт к имени ключа, которое реально читает compose…
  assert.match(signup.fix, /DISABLE_SIGNUP=false/);
  // …и к пересозданию контейнера: без него GoTrue живёт со старым окружением.
  assert.match(signup.fix, /Применить и перезапустить|пересозда/i);
  // Старый совет «просто выставьте GOTRUE_DISABLE_SIGNUP=false» не работает…
  assert.doesNotMatch(signup.fix, /^Выставьте GOTRUE_DISABLE_SIGNUP=false\.$/);
  // …и это сказано прямо, чтобы админ не искал причину второй раз.
  assert.match(signup.fix, /GOTRUE_DISABLE_SIGNUP\s+в\s+\.env\s+игнорируется/);
});

test('диагностика: SITE_URL стека ведёт на API — это отдельная проверка с починкой', async () => {
  // Прод-случай: письмо приходило со ссылкой на supabase.<домен>/auth/v1/verify
  // и отвечало 404, потому что в SITE_URL стека лежал адрес API.
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } });
  globalThis.__health.agent = { ok: true, payload: { siteUrl: 'https://supabase.edringcolony.ru', siteUrlIsApi: true } };
  const body = await diagnose();

  assert.equal(body.ok, false, 'неподтверждаемые адреса — не «всё хорошо»');
  const site = check(body, 'mail-site-url');
  assert.equal(site.ok, false);
  assert.equal(site.action, 'fix-site-url', 'панель получает машиночитаемую причину');
  assert.match(site.detail, /auth\/v1\/verify/, 'объяснено, какую ссылку откроет пилот');
  assert.match(site.detail, /404/, 'и почему он видит 404');
  assert.match(site.fix, /Применить и перезапустить/, 'подсказка ведёт к рабочей кнопке');
});

test('диагностика: адрес сайта в письмах верный — проверка пройдена', async () => {
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } });
  globalThis.__health.agent = { ok: true, payload: { siteUrl: 'https://edringcolony.ru', siteUrlIsApi: false } };
  const body = await diagnose();

  const site = check(body, 'mail-site-url');
  assert.equal(site.ok, true);
  assert.equal(site.action, undefined, 'чинить нечего');
  assert.match(site.detail, /https:\/\/edringcolony\.ru/);
});

test('диагностика: агент недоступен — проверки адреса нет, остальное работает', async () => {
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } });
  globalThis.__health.agent = { ok: false, status: 503, error: 'agent unavailable' };
  const body = await diagnose();

  assert.equal(check(body, 'mail-site-url'), undefined, 'без агента — без выдуманного вердикта');
  assert.equal(body.ok, true, 'остальные проверки не задеты');
});

test('диагностика: открытая регистрация — без действия и без подсказки', async () => {
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } });
  const body = await diagnose();

  assert.equal(body.ok, true, 'все проверки пройдены');
  const signup = check(body, 'signup');
  assert.equal(signup.ok, true);
  assert.equal(signup.action, undefined, 'чинить нечего — кнопки быть не должно');
  assert.equal(signup.fix, undefined);
});

test('диагностика: GoTrue не сообщил disable_signup — это не «всё хорошо»', async () => {
  gotrue({ mailer_autoconfirm: false, external: { email: true } });
  const body = await diagnose();

  const signup = check(body, 'signup');
  assert.equal(signup.ok, false, 'неизвестное состояние нельзя выдавать за рабочее');
  assert.match(signup.detail, /не сообщил disable_signup/);
  assert.equal(signup.action, 'enable-signup');
});

test('диагностика: формы сайта выключены — своя причина для одного клика', async () => {
  env({ AUTH_EMAIL_ENABLED: 'false' });
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } });
  const body = await diagnose();
  env({ AUTH_EMAIL_ENABLED: 'true' });

  const flag = check(body, 'site-flag');
  assert.equal(flag.ok, false);
  assert.equal(flag.action, 'enable-site-forms');
  assert.match(flag.fix, /Применить и перезапустить/);
});

test('диагностика: включённый autoconfirm — подсказка про SMTP, без «включить»', async () => {
  gotrue({ mailer_autoconfirm: true, disable_signup: false, external: { email: true } });
  const body = await diagnose();

  const autoconfirm = check(body, 'mailer-autoconfirm');
  assert.equal(autoconfirm.ok, false);
  assert.equal(autoconfirm.action, 'configure-smtp', 'за админа SMTP-пароль не подставить');
  assert.match(autoconfirm.fix, /SMTP/);
});

test('диагностика: адрес так и не подтвердился — это отдельная причина, а не «всё хорошо»', async () => {
  // Прод-случай: пилот нажал «Подтвердить», увидел ошибку, и учётка осталась
  // неподтверждённой. Остальные проверки при этом зелёные — SMTP настроен,
  // GoTrue отвечает, регистрация открыта. Без этой проверки панель говорила
  // «всё в порядке», хотя войти по паролю нельзя.
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } }, {
    users: { users: [pilot('pilot-a', { confirmed: false }), pilot('pilot-b', { confirmed: false }), pilot('pilot-c')] },
  });
  const body = await diagnose();

  const mailboxes = check(body, 'confirmed-mailboxes');
  assert.equal(mailboxes.ok, false, 'неподтверждённые адреса — не «всё хорошо»');
  assert.equal(body.ok, false);
  assert.match(mailboxes.detail, /^(Не подтверждено адресов: )?2\b/, 'считаем только неподтверждённые');
  assert.match(mailboxes.detail, /одноразов/i, 'и объясняем, почему ссылка «уже использована»');
  assert.match(mailboxes.fix, /новое письмо|Подтверждение|подтверждени/i, 'подсказка ведёт к рабочему шагу');
  // Пароль SMTP и адреса пилотов наружу не уходят.
  assert.doesNotMatch(JSON.stringify(body), /@example\.net/, 'письма-адреса в отчёт не попадают');
});

test('диагностика: все адреса подтверждены — проверка зелёная', async () => {
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } }, {
    users: { users: [pilot('pilot-a'), pilot('pilot-b')] },
  });
  const body = await diagnose();

  const mailboxes = check(body, 'confirmed-mailboxes');
  assert.equal(mailboxes.ok, true);
  assert.equal(mailboxes.fix, undefined, 'чинить нечего');
  assert.equal(body.ok, true);
});

test('диагностика: только что зарегистрированный адрес не считается брошенным', async () => {
  // Пилот открыл форму минуту назад и ещё читает письмо: это не дефект.
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } }, {
    users: { users: [pilot('pilot-new', { confirmed: false, ageMinutes: 2 })] },
  });
  const body = await diagnose();

  assert.equal(check(body, 'confirmed-mailboxes').ok, true, 'льгота на чтение письма');
});

test('диагностика: админский список недоступен — проверки нет, чужих вердиктов нет', async () => {
  gotrue({ mailer_autoconfirm: false, disable_signup: false, external: { email: true } }, { usersStatus: 403 });
  const body = await diagnose();

  assert.equal(check(body, 'confirmed-mailboxes'), undefined, 'неизвестное состояние не выдаём за рабочее');
  assert.equal(body.ok, true, 'остальные проверки не задеты');
  assert.equal(globalThis.__health.agent, undefined, 'агент тут ни при чём');
});

test('панель: кнопка «Включить и применить» пишет DISABLE_SIGNUP=false и запускает применение', () => {
  const card = readFileSync(join(ROOT, 'src/components/Admin/MailSettingsCard.tsx'), 'utf8');

  // Ручка починки существует и знает про оба действия диагностики.
  assert.match(card, /const repair = useCallback/, 'в панели есть починка из диагностики');
  assert.match(card, /action === 'enable-signup'/);
  assert.match(card, /action === 'enable-site-forms'/);

  // Имя ключа — то, которое читает compose (GOTRUE_… игнорируется).
  const signupBlock = card.slice(card.indexOf("action === 'enable-signup'"));
  const block = signupBlock.slice(0, signupBlock.indexOf("action === 'enable-site-forms'"));
  assert.match(block, /key: 'DISABLE_SIGNUP', value: 'false'/);
  assert.doesNotMatch(block, /GOTRUE_DISABLE_SIGNUP/);

  // Без пересоздания контейнера auth файл меняется, а GoTrue — нет.
  assert.match(card, /\/api\/admin\/smtp\/apply/, 'после правки панель запускает применение');

  // Кнопка показывается только у проверок, которые реально чинятся одним кликом.
  assert.match(card, /check\.action && check\.action !== 'configure-smtp'/);
  assert.match(card, /mail\.enableApply/);
  assert.match(card, /setSignupOpen\(true\)/, 'галочка в панели обновляется без перезагрузки страницы');

  // Ловушка с именем ключа видна до нажатия «Сохранить», а не только после.
  assert.match(card, /status\?\.legacySignupKey/, 'панель предупреждает про GOTRUE_DISABLE_SIGNUP в .env');
  assert.match(card, /mail\.legacyMid/, 'в предупреждении — текст с рабочим именем');
  assert.match(card, /<code>DISABLE_SIGNUP<\/code>/, 'в предупреждении — рабочее имя');
});
