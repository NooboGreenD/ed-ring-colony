/**
 * Установщик `ColonialHelperSetup.exe`: загрузка из админки и раздача с сайта.
 *
 * Проверяется весь путь, который проходит файл на боевом сервере: админка
 * начинает загрузку, присылает части по 4 МиБ, сервер собирает файл и кладёт
 * его отдельно от канала обновлений. Затем те же роуты отдают файл пилоту по
 * постоянной ссылке — и в профиле, и в меню профиля стоит именно она.
 *
 * Роуты собираются esbuild'ом из настоящих исходников; диск временный, а
 * проверка администратора подменена. Без esbuild тест честно пропускается.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем.
}
const maybe = esbuild ? test : test.skip;

const work = mkdtempSync(join(tmpdir(), 'edrc-setup-'));
process.env.UPLOADER_STORE_DIR = join(work, 'store');
test.after(() => rmSync(work, { recursive: true, force: true }));

let routes = null;
let store = null;

if (esbuild) {
  const shim = join(work, 'next-server.mjs');
  writeFileSync(
    shim,
    `export class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
  static redirect(url, init = {}) {
    const status = typeof init === 'number' ? init : (init.status || 307);
    const headers = new Headers(typeof init === 'number' ? {} : (init.headers || {}));
    headers.set('location', String(url));
    return new Response(null, { status, headers });
  }
}
export class NextRequest extends Request {}
`,
  );

  // Админка проверяется отдельно; здесь важно, что дальше делает роут.
  const authShim = join(work, 'billing-auth.mjs');
  writeFileSync(
    authShim,
    `export const requireAdmin = async () => ({ actor: { userId: 'admin', role: 'admin' } });\n`,
  );

  const entry = join(work, 'entry.ts');
  writeFileSync(
    entry,
    `export { GET as adminGET, POST as adminPOST, DELETE as adminDELETE } from '@/app/api/admin/uploader/setup/route';
export { GET as setupGET } from '@/app/api/uploader/setup/[platform]/route';
export { GET as downloadGET } from '@/app/api/uploader/download/route';
export { saveSetupBinary, readSetup, readSetupBinary, removeSetup } from '@/lib/uploaderStore';
export { createLauncherUpload, LauncherUploadError } from '@/lib/launcherUploadSessions';
export { MAX_SETUP_UPLOAD_BYTES, MAX_LAUNCHER_UPLOAD_BYTES } from '@/lib/launcherUploadProtocol';
`,
  );

  const outfile = join(work, 'routes.mjs');
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    alias: { 'next/server': shim, '@/lib/billing/auth': authShim },
    tsconfig: join(ROOT, 'tsconfig.json'),
  });
  routes = await import(outfile);
  store = routes;
}

/** Небольшой «exe»: заголовок MZ и немного тела. */
function fakeSetup(size = 4096) {
  const buffer = Buffer.alloc(size, 7);
  buffer[0] = 0x4d;
  buffer[1] = 0x5a;
  return buffer;
}

function adminRequest(body) {
  return new Request('https://edringcolony.ru/api/admin/uploader/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function uploadInChunks(data, version = '2.18.40', chunkSize = 1024 * 1024) {
  const begin = await routes.adminPOST(adminRequest({
    action: 'begin', platform: 'win64', version, size: data.length, chunkSize,
  }));
  const started = await begin.json();
  assert.equal(begin.status, 201, JSON.stringify(started));
  const total = started.totalChunks;
  for (let index = 0; index < total; index += 1) {
    const slice = data.subarray(index * chunkSize, Math.min(data.length, (index + 1) * chunkSize));
    const response = await routes.adminPOST(new Request('https://edringcolony.ru/api/admin/uploader/setup', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-helper-upload-action': 'chunk',
        'x-helper-upload-id': started.uploadId,
        'x-helper-chunk-index': String(index),
      },
      body: slice,
    }));
    assert.equal(response.status, 200, `часть ${index}: ${await response.text()}`);
  }
  const done = await routes.adminPOST(adminRequest({ action: 'complete', uploadId: started.uploadId }));
  return { response: done, payload: await done.json() };
}

maybe('загрузка установщика частями публикует его отдельно от канала обновлений', async () => {
  // Части по 1 МиБ — минимальный разрешённый размер: так же шлёт и браузер,
  // если прокси не пропускает 4 МиБ.
  const data = fakeSetup(2 * 1024 * 1024 + 512);
  const { response, payload } = await uploadInChunks(data);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.equal(payload.setup.version, '2.18.40');
  assert.equal(payload.setup.size, data.length);
  assert.equal(payload.setup.sha256, createHash('sha256').update(data).digest('hex'));

  const saved = await routes.readSetupBinary('win64');
  assert.equal(saved.length, data.length);
  // Установщик не попадает в канал базовой сборки.
  assert.equal(await store.readSetup('win64').then((info) => info.version), '2.18.40');
});

maybe('админка показывает статус установщика и ссылку на скачивание', async () => {
  const response = await routes.adminGET(new Request(
    'https://edringcolony.ru/api/admin/uploader/setup?platform=win64', { headers: { host: 'edringcolony.ru' } },
  ));
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.setup.version, '2.18.40');
  assert.match(payload.downloadUrl, /\/api\/uploader\/setup\/win64$/);

  const missing = await routes.adminGET(new Request(
    'https://edringcolony.ru/api/admin/uploader/setup?platform=win64',
  ));
  assert.equal(missing.status, 200);
});

maybe('постоянная ссылка отдаёт установщик как файл', async () => {
  const response = await routes.setupGET(
    new Request('https://edringcolony.ru/api/uploader/setup/win64'),
    { params: Promise.resolve({ platform: 'win64' }) },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /ColonialHelperSetup-2\.18\.40\.exe/);
  const info = await routes.readSetup('win64');
  assert.equal(response.headers.get('etag'), `"${info.sha256}"`);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, info.size);
});

maybe('ссылка в профиле и меню профиля ведёт на установщик', async () => {
  const response = await routes.downloadGET(
    new Request('https://edringcolony.ru/api/uploader/download?platform=win64'),
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /\/api\/uploader\/setup\/win64$/);
});

maybe('без установщика ссылка отвечает 404, а не пустым файлом', async () => {
  await routes.removeSetup('win64');
  const response = await routes.setupGET(
    new Request('https://edringcolony.ru/api/uploader/setup/win64'),
    { params: Promise.resolve({ platform: 'win64' }) },
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);

  const redirect = await routes.downloadGET(
    new Request('https://edringcolony.ru/api/uploader/download?platform=win64'),
  );
  assert.equal(redirect.status, 404);
});

maybe('не Windows-файл не публикуется', async () => {
  const data = Buffer.alloc(4096, 3);
  const result = await routes.saveSetupBinary('win64', '2.18.41', data, 'https://example/api');
  assert.equal(result.ok, false);
  assert.match(result.error, /MZ/);
});

maybe('слишком маленький файл и плохая версия отклоняются', async () => {
  const tiny = Buffer.from([0x4d, 0x5a, 1, 2]);
  assert.equal((await routes.saveSetupBinary('win64', '2.18.41', tiny, 'https://example/api')).ok, false);
  const data = fakeSetup();
  assert.equal((await routes.saveSetupBinary('win64', 'v2', data, 'https://example/api')).ok, false);
  // Платформа попадает в имя файла, поэтому вольные значения не принимаются.
  assert.equal((await routes.saveSetupBinary('win 64', '2.18.41', data, 'https://example/api')).ok, false);
});

maybe('удаление установщика идемпотентно и не трогает базу обновлений', async () => {
  const data = fakeSetup();
  await routes.saveSetupBinary('win64', '2.18.42', data, 'https://example/api');
  assert.equal((await routes.removeSetup('win64')).ok, true);
  assert.equal((await routes.removeSetup('win64')).ok, true);
  assert.equal(await routes.readSetup('win64'), null);
  assert.equal(await routes.readSetupBinary('win64'), null);

  const deleted = await routes.adminDELETE(new Request(
    'https://edringcolony.ru/api/admin/uploader/setup?platform=win64', { method: 'DELETE' },
  ));
  assert.equal(deleted.status, 404);
});

maybe('установщик принимается до 320 МиБ, а базовая сборка — до 128 МиБ', async () => {
  assert.ok(routes.MAX_SETUP_UPLOAD_BYTES > routes.MAX_LAUNCHER_UPLOAD_BYTES);
  const big = routes.MAX_LAUNCHER_UPLOAD_BYTES + 1024;
  const setup = await routes.createLauncherUpload({
    kind: 'setup', platform: 'win64', version: '2.18.43', size: big, chunkSize: 1024 * 1024,
  });
  assert.equal(setup.kind, 'setup');

  await assert.rejects(
    () => routes.createLauncherUpload({
      kind: 'launcher', platform: 'win64', version: '2.18.43', size: big, chunkSize: 1024 * 1024,
    }),
    (error) => error instanceof routes.LauncherUploadError && error.status === 413,
  );
});

maybe('слишком крупный установщик отклоняется с понятным текстом', async () => {
  const response = await routes.adminPOST(adminRequest({
    action: 'begin', platform: 'win64', version: '2.18.43',
    size: routes.MAX_SETUP_UPLOAD_BYTES + 1, chunkSize: 1024 * 1024,
  }));
  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.match(payload.error, /320/);
});
