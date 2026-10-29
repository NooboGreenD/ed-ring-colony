/**
 * Почему админка не пускает и не врёт ли она про права.
 *
 * Задача модуля — превратить ответ PostgREST в понятную причину. Это важно
 * ровно в той ситуации, из-за которой он появился: роль в базе `admin`, psql
 * это подтверждает, а страница пишет «Доступ запрещён» и молчит о причине.
 *
 * Проверяем три вещи:
 *
 *  1. разбор кодов PostgREST/Postgres — сессия, кэш схемы, гранты, отсутствующая
 *     таблица, отсутствующая строка — различаются, а не сваливаются в «нет прав»;
 *  2. решение о доступе: отказ никогда не выдаёт себя за выдачу прав (в том
 *     числе пустой профиль и «нет сессии»);
 *  3. маршрут `/api/admin/access` действительно достаёт роль сервисным ключом,
 *     когда браузерный путь к базе сломан, и не отдаёт чужих данных.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем.
}
const maybe = esbuild ? test : test.skip;

const work = mkdtempSync(join(tmpdir(), 'edrc-admin-access-'));
test.after(() => rmSync(work, { recursive: true, force: true }));

async function loadLib() {
  const outfile = join(work, 'adminAccess.mjs');
  await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'lib', 'adminAccess.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

maybe('коды PostgREST разбираются в разные причины, а не в «нет прав»', async () => {
  const { classifyProfileError } = await loadLib();

  assert.equal(classifyProfileError(null), 'none');
  assert.equal(classifyProfileError({ code: 'PGRST116', message: 'JSON object requested' }), 'missing-row');
  assert.equal(classifyProfileError({ code: '42703', message: 'column profiles.role does not exist' }), 'missing-table');
  assert.equal(classifyProfileError({ code: '42P01', message: 'relation "public.helper_devices" does not exist' }), 'missing-table');
  assert.equal(
    classifyProfileError({ code: 'PGRST204', message: "Could not find the 'role' column in the schema cache" }),
    'schema',
  );
  assert.equal(
    classifyProfileError({ code: '42501', message: 'permission denied for table profiles' }),
    'grant',
  );
  assert.equal(
    classifyProfileError({ message: 'new row violates row-level security policy for table "profiles"' }),
    'grant',
  );
  assert.equal(classifyProfileError({ code: 'PGRST301', message: 'JWT expired' }), 'session');
  assert.equal(classifyProfileError({ message: 'TypeError: fetch failed' }), 'network');
  assert.equal(classifyProfileError({ message: 'getaddrinfo EAI_AGAIN db' }), 'network');
  assert.equal(classifyProfileError({ message: 'что-то новое' }), 'unknown');
});

maybe('решение о доступе: отказ не превращается в права', async () => {
  const { decideAccess } = await loadLib();

  assert.equal(decideAccess({ userId: null }).role, 'guest');
  assert.equal(decideAccess({ userId: null }).staff, false);

  const admin = decideAccess({ userId: 'u1', profile: { role: 'admin', cmdr_name: 'CMDR' } });
  assert.equal(admin.staff, true);
  assert.equal(admin.reason, 'staff');

  for (const role of ['moderator', 'support_manager']) {
    assert.equal(decideAccess({ userId: 'u1', profile: { role } }).staff, true, role);
  }

  const user = decideAccess({ userId: 'u1', profile: { role: 'user' } });
  assert.equal(user.staff, false);
  assert.equal(user.reason, 'not-staff');

  // Строка не пришла без ошибки — это не «права есть».
  const noRow = decideAccess({ userId: 'u1', profile: null });
  assert.equal(noRow.staff, false);
  assert.equal(noRow.hint, 'missing-row');

  // Ошибка чтения — тоже отказ, но с настоящей причиной и текстом сервера.
  const failed = decideAccess({
    userId: 'u1',
    profile: null,
    error: { code: '42501', message: 'permission denied for table profiles' },
  });
  assert.equal(failed.staff, false);
  assert.equal(failed.reason, 'query-failed');
  assert.equal(failed.hint, 'grant');
  assert.match(failed.serverMessage, /permission denied/);

  // Незнакомый код не должен выглядеть как пустая строка в интерфейсе.
  const odd = decideAccess({ userId: 'u1', error: { code: 'XX000' } });
  assert.ok(odd.serverMessage.length > 0);
});

/* ── маршрут /api/admin/access ─────────────────────────────────────── */

const NEXT_SERVER_STUB = `export class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
  }
}
`;

/** Сервисный клиент: отвечает как настоящий, но из памяти теста. */
const ADMIN_STUB = `export function createAdminClient() {
  const state = globalThis.__adminAccessState;
  if (state.adminThrows) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => state.serviceReply }) }),
  }) };
}
`;

/** Сессия: пользователь и клиент под его токеном (RLS применяется по-настоящему). */
const SESSION_STUB = `export async function authFromRequest() {
  const state = globalThis.__adminAccessState;
  return {
    user: state.user,
    supabase: { from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => state.sessionReply }) }),
    }) },
  };
}
`;

async function buildRoute() {
  const dir = mkdtempSync(join(work, 'route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'admin.mjs'), ADMIN_STUB);
  writeFileSync(join(dir, 'session.mjs'), SESSION_STUB);
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, "export * as access from '@/app/api/admin/access/route';\n");
  const bundle = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: {
      'next/server': join(dir, 'next-server.mjs'),
      '@/lib/supabaseAdmin': join(dir, 'admin.mjs'),
      '@/lib/requestUser': join(dir, 'session.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });
  const mod = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);
  return mod.access;
}

const setState = (state) => { globalThis.__adminAccessState = state; };
const call = async (route) => {
  const res = await route.GET(new Request('http://localhost/api/admin/access'));
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
};

maybe('сервер подтверждает роль даже когда браузерный путь к базе сломан', async () => {
  const route = await buildRoute();
  setState({
    user: { id: 'user-admin', email: 'admin@example.com' },
    // Браузер получает отказ политики...
    sessionReply: { data: null, error: { code: '42501', message: 'permission denied for table profiles' } },
    // ...а сервисный ключ видит настоящую роль.
    serviceReply: { data: { role: 'admin', cmdr_name: 'CMDR Admin' }, error: null },
  });
  const { status, cache, body } = await call(route);
  assert.equal(status, 200);
  assert.match(cache || '', /no-store/);
  assert.equal(body.role, 'admin');
  assert.equal(body.staff, true);
  assert.equal(body.source, 'service');
  // Наружу уходят только собственные данные.
  assert.equal(body.userId, 'user-admin');
  assert.equal(body.email, 'admin@example.com');
  assert.equal(body.profile.cmdr_name, 'CMDR Admin');
});

maybe('без сервисного ключа маршрут отвечает сессией и не выдумывает права', async () => {
  const route = await buildRoute();
  setState({
    user: { id: 'user-1', email: 'pilot@example.com' },
    adminThrows: true,
    sessionReply: { data: { role: 'user', cmdr_name: 'CMDR Pilot' }, error: null },
    serviceReply: { data: null, error: null },
  });
  const { body } = await call(route);
  assert.equal(body.source, 'session');
  assert.equal(body.staff, false);
  assert.equal(body.role, 'user');
});

maybe('без сессии — guest, а не «нет прав», и без запросов к базе', async () => {
  const route = await buildRoute();
  setState({ user: null, adminThrows: true, serviceReply: { data: null, error: null }, sessionReply: { data: null, error: null } });
  const { status, body } = await call(route);
  assert.equal(status, 200);
  assert.equal(body.role, 'guest');
  assert.equal(body.reason, 'signed-out');
  assert.equal(body.staff, false);
});
