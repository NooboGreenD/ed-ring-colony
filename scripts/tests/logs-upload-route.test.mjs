/**
 * Тесты роута `/api/logs/upload` (загрузка журналов с десктопного помощника).
 *
 * Роут импортируется настоящим: он собирается esbuild'ом с подменой `next/server`
 * и `@supabase/supabase-js` на заглушки, так что проверяется именно тот код,
 * который отвечает на запрос, а не его пересказ.
 *
 * База в заглушке не находит токен и отвечает «пользователя нет», поэтому любой
 * запрос, прошедший валидацию тела, упирается в 401. Это и используется как
 * признак «прошёл проверку размера пачки»: если бы проверка не сработала,
 * огромный запрос дошёл бы до валидации токена и тоже получил 401.
 *
 * Без esbuild тест честно пропускается, а не падает.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем.
}

const maybe = esbuild ? test : test.skip;

// Роут создаёт сервисный клиент до разбора тела и бросает исключение без
// этих переменных, не доходя до валидации.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-role-key';

async function buildRoute(route = 'upload') {
  const dir = mkdtempSync(join(ROOT, '.tmp-upload-route-'));

  // NextResponse.json — единственное, что роут берёт из next/server.
  writeFileSync(
    join(dir, 'next-server.mjs'),
    `export const NextResponse = {
  json: (body, init) =>
    new Response(JSON.stringify(body), {
      status: (init && init.status) || 200,
      headers: { 'content-type': 'application/json' },
    }),
};
`,
  );

  // Заглушка Supabase: `api_tokens` не находит токен, значит запрос, дошедший
  // до валидации токена, завершится 401 и записи в базу не будет.
  writeFileSync(
    join(dir, 'supabase.mjs'),
    `export function createClient() {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  };
}
`,
  );

  const entry = join(dir, 'entry.ts');
  const bundle = join(dir, 'bundle.mjs');
  writeFileSync(entry, `export { POST } from '@/app/api/logs/${route}/route';\n`);

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: {
      'next/server': join(dir, 'next-server.mjs'),
      '@supabase/supabase-js': join(dir, 'supabase.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });

  const mod = await import(bundle);
  return { dir, POST: mod.POST };
}

const post = (POST, body) =>
  POST(new Request('http://localhost/api/logs/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

/** Минимальный snapshot стройки — роуту достаточно самого факта строки. */
const construction = () => ({
  timestamp: '2026-09-14T10:00:00Z',
  system_name: 'Delta Velorum',
  market_id: 9001,
  construction_id: 7,
  construction_name: 'Ditceford Hub',
  construction_progress: 0.5,
  resources_total: [],
});

const delivery = (index) => ({
  timestamp: '2026-09-14T10:00:00Z',
  system_name: 'Delta Velorum',
  event_type: 'ColonisationContribution',
  quantity: 10,
  source_hash: `hash-${index}`,
});

maybe('snapshots стройки сверх лимита отклоняются 413, а ровно лимит — нет', async () => {
  const { dir, POST } = await buildRoute();
  try {
    const over = await post(POST, { token: 'helper-token', construction_events: Array.from({ length: 501 }, construction) });
    assert.equal(over.status, 413);
    assert.match((await over.json()).error, /Too many construction events/);

    // 500 — ровно лимит: такой запрос обязан пройти проверку размера и дойти
    // до валидации токена, где заглушка ответит 401.
    const boundary = await post(POST, { token: 'helper-token', construction_events: Array.from({ length: 500 }, construction) });
    assert.notEqual(boundary.status, 413, '500 snapshots — это ровно лимит, отклонять нельзя');
    assert.equal(boundary.status, 401);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('лимит snapshots нельзя обойти, прислав поле в camelCase', async () => {
  const { dir, POST } = await buildRoute();
  try {
    // Помощник шлёт construction_events, но роут понимает и constructionEvents;
    // проверка обязана учитывать оба имени.
    const response = await post(POST, { token: 'helper-token', constructionEvents: Array.from({ length: 700 }, construction) });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /Too many construction events/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('доставки сверх лимита отклоняются 413', async () => {
  const { dir, POST } = await buildRoute();
  try {
    const response = await post(POST, { token: 'helper-token', deliveries: Array.from({ length: 501 }, delivery) });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /Too many deliveries/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('запрос без токена отклоняется 401 до обращения к базе', async () => {
  const { dir, POST } = await buildRoute();
  try {
    const response = await post(POST, { cmdr: 'Test Pilot', deliveries: [delivery(0)] });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'API token required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('не-JSON тело отклоняется 400, а не падает в 500', async () => {
  const { dir, POST } = await buildRoute();
  try {
    const response = await POST(new Request('http://localhost/api/logs/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'это не json',
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Invalid JSON');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ─────────── /api/logs/import (браузерный загрузчик) ───────────
   Тот же лимит, что и у десктопного роута: браузер теперь режет пачки
   snapshots по 500, и без проверки на сервере размер запроса не ограничен. */

const postImport = (POST, body) =>
  POST(new Request('http://localhost/api/logs/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

maybe('браузерный роут: snapshots сверх лимита отклоняются 413', async () => {
  const { dir, POST } = await buildRoute('import');
  try {
    const over = await postImport(POST, { constructionEvents: Array.from({ length: 501 }, construction) });
    assert.equal(over.status, 413);
    assert.match((await over.json()).error, /Too many construction events/);

    // Проверка обязана учитывать и snake_case: старый клиент мог слать так.
    const snake = await postImport(POST, { construction_events: Array.from({ length: 600 }, construction) });
    assert.equal(snake.status, 413);
    assert.match((await snake.json()).error, /Too many construction events/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('браузерный роут: ровно лимит snapshots проходит проверку размера', async () => {
  const { dir, POST } = await buildRoute('import');
  try {
    // Без авторизации такой запрос упирается в 401 — значит проверку размера
    // он прошёл. 413 здесь означал бы, что лимит задран слишком низко.
    const response = await postImport(POST, { constructionEvents: Array.from({ length: 500 }, construction) });
    assert.notEqual(response.status, 413, '500 snapshots — это ровно лимит, отклонять нельзя');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
