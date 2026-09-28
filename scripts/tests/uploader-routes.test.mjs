/**
 * Канал обновлений Colonial Helper целиком: публикация из CI → манифест →
 * файлы по хешу → архив пакета.
 *
 * Роуты импортируются настоящими (esbuild с подменой `next/server`), а диск
 * подставляется временный, поэтому проверяется именно тот код, который
 * отвечает пилоту. Сценарий повторяет боевой: CI публикует версию, программа
 * читает манифест, качает только изменившийся файл, потом канал откатывают.
 *
 * Без esbuild тест честно пропускается, а не падает.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'ci-publish-token';

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем.
}
const maybe = esbuild ? test : test.skip;

const work = mkdtempSync(join(tmpdir(), 'edrc-uploader-routes-'));
process.env.UPLOADER_STORE_DIR = join(work, 'store');
process.env.UPLOADER_PUBLISH_TOKEN = TOKEN;
test.after(() => rmSync(work, { recursive: true, force: true }));

let routes = null;
let canonicalManifestBytes = null;

if (esbuild) {
  // Заглушка next/server: роуты используют и NextResponse.json, и конструктор
  // (файлы отдаются как поток байт, а не JSON).
  const shim = join(work, 'next-server.mjs');
  writeFileSync(
    shim,
    `export class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
export class NextRequest extends Request {}
`,
  );

  const entry = join(work, 'entry.ts');
  writeFileSync(
    entry,
    `export { GET as manifestGET } from '@/app/api/uploader/manifest/route';
export { GET as blobGET } from '@/app/api/uploader/blob/[hash]/route';
export { GET as archiveGET } from '@/app/api/uploader/bundle/[file]/route';
export { GET as launcherGET } from '@/app/api/uploader/launcher/route';
export { POST as publishPOST } from '@/app/api/admin/uploader/publish/route';
export { canonicalManifestBytes } from '@/lib/uploaderStore';
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
    alias: { 'next/server': shim },
    tsconfig: join(ROOT, 'tsconfig.json'),
  });
  routes = await import(outfile);
  canonicalManifestBytes = routes.canonicalManifestBytes;
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
if (esbuild) {
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `ci:${raw.toString('base64')}`;
}

const V1 = {
  'colonial_helper.py': 'VERSION = "2.13.0"\ndef main():\n    return 0\n',
  'overlay.py': 'BLOCKS = 7\n',
  'api_client.py': 'TIMEOUT = 15\n',
};
const V2 = { ...V1, 'colonial_helper.py': 'VERSION = "2.13.1"\ndef main():\n    return 0\n' };

function manifestFor(files, version, channel = 'stable') {
  const manifest = {
    schema: 1,
    channel,
    version,
    entry: 'colonial_helper.py',
    min_launcher: '1.0.0',
    released_at: new Date().toISOString(),
    notes: `Сборка ${version}: правки только в коде`,
    files: Object.entries(files).map(([path, body]) => ({
      path,
      size: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    })),
  };
  const value = cryptoSign(null, canonicalManifestBytes(manifest), privateKey);
  return { ...manifest, signature: { alg: 'ed25519', key_id: 'ci', value: value.toString('base64') } };
}

const encode = (files) =>
  Object.fromEntries(Object.entries(files).map(([path, body]) => [path, Buffer.from(body).toString('base64')]));

const publish = (body, token = TOKEN) =>
  routes.publishPOST(
    new Request('https://edringcolony.ru/api/admin/uploader/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );

const getManifest = (query = '') =>
  routes.manifestGET(new Request(`https://edringcolony.ru/api/uploader/manifest${query}`));

maybe('пустой канал отвечает 404 с понятным текстом, а не пятисоткой', async () => {
  const response = await getManifest('?channel=stable');
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /не опубликован|нет/i);
});

maybe('без токена CI опубликовать нельзя', async () => {
  const response = await publish({ manifest: manifestFor(V1, '2.13.0'), files: encode(V1) }, null);
  assert.equal(response.status, 401);
  // Чужой токен той же длины тоже не подходит.
  const wrong = await publish({ manifest: manifestFor(V1, '2.13.0'), files: encode(V1) }, 'ci-publish-tokeN');
  assert.equal(wrong.status, 401);
});

maybe('CI публикует версию, программа сразу видит её в канале', async () => {
  const manifest = manifestFor(V1, '2.13.0');
  const response = await publish({ manifest, files: encode(V1) });
  assert.equal(response.status, 200);
  const published = await response.json();
  assert.equal(published.ok, true);
  assert.equal(published.version, '2.13.0');
  assert.equal(published.signature_checked, true);
  assert.equal(published.stored_blobs, 3);

  const channel = await getManifest('?channel=stable');
  assert.equal(channel.status, 200);
  const body = await channel.json();
  assert.equal(body.manifest.version, '2.13.0');
  assert.ok(body.manifest.signature.value, 'подпись должна доехать до клиента');
  // Манифест меняется при каждом релизе — вечного кэша тут быть не может.
  assert.match(channel.headers.get('cache-control') ?? '', /max-age=(\d+)/);
  assert.ok(!/immutable/.test(channel.headers.get('cache-control') ?? ''));
});

maybe('файл отдаётся по sha256 и кэшируется навсегда', async () => {
  const body = await (await getManifest('?channel=stable')).json();
  const item = body.manifest.files.find((f) => f.path === 'overlay.py');
  const response = await routes.blobGET(new Request('https://edringcolony.ru/x'), {
    params: Promise.resolve({ hash: item.sha256 }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), V1['overlay.py']);
  assert.match(response.headers.get('cache-control') ?? '', /immutable/);
  assert.equal(response.headers.get('etag'), `"${item.sha256}"`);
});

maybe('файл едет сжатым, если клиент это умеет, и проверяется по распакованному', async () => {
  // Настоящий модуль — это сотни килобайт текста на Python; берём такой же.
  const big = { ...V1, 'overlay.py': `BLOCKS = 7\n${'# строка комментария про оверлей\n'.repeat(4000)}` };
  const manifest = manifestFor(big, '2.13.0-big');
  await publish({ manifest, files: encode(big) });
  const item = manifest.files.find((f) => f.path === 'overlay.py');
  const response = await routes.blobGET(
    new Request('https://edringcolony.ru/x', { headers: { 'accept-encoding': 'gzip, deflate' } }),
    { params: Promise.resolve({ hash: item.sha256 }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(response.headers.get('vary'), 'Accept-Encoding');
  // Сжатое и несжатое представление не должны делить ETag.
  assert.equal(response.headers.get('etag'), `"${item.sha256}-gz"`);

  const packed = Buffer.from(await response.arrayBuffer());
  const raw = gunzipSync(packed);
  assert.equal(createHash('sha256').update(raw).digest('hex'), item.sha256,
    'клиент считает хеш от распакованных байт — он обязан сойтись с манифестом');
  assert.ok(packed.length * 4 < raw.length, 'текст на Python обязан ужиматься в разы');
});

maybe('мелкий файл не раздувается gzip-заголовком', async () => {
  const body = await (await getManifest('?channel=stable')).json();
  const item = body.manifest.files.find((f) => f.path === 'api_client.py');
  const response = await routes.blobGET(
    new Request('https://edringcolony.ru/x', { headers: { 'accept-encoding': 'gzip' } }),
    { params: Promise.resolve({ hash: item.sha256 }) },
  );
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(await response.text(), V1['api_client.py']);
});

maybe('мусор вместо хеша не уводит чтение за пределы хранилища', async () => {
  for (const hash of ['../../etc/passwd', 'not-a-hash', '', 'a'.repeat(63), `${'a'.repeat(64)}/../x`]) {
    const response = await routes.blobGET(new Request('https://edringcolony.ru/x'), {
      params: Promise.resolve({ hash }),
    });
    assert.equal(response.status, 404, `хеш ${hash} не должен ничего отдавать`);
  }
});

maybe('обновление версии дозагружает только изменившийся файл', async () => {
  const manifest = manifestFor(V2, '2.13.1');
  // CI знает, что сервер уже видел два файла из трёх, и шлёт только третий.
  const changed = { 'colonial_helper.py': encode(V2)['colonial_helper.py'] };
  const response = await publish({ manifest, files: changed });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stored_blobs, 1, 'неизменившиеся файлы не должны перекладываться');

  const channel = await (await getManifest('?channel=stable')).json();
  assert.equal(channel.manifest.version, '2.13.1');
});

maybe('нехватка файлов — это 409 со списком, а не «ошибка сервера»', async () => {
  const fresh = { ...V2, 'overlay.py': 'BLOCKS = 9\n', 'api_client.py': 'TIMEOUT = 30\n' };
  const response = await publish({ manifest: manifestFor(fresh, '2.14.0'), files: {} });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.missing.sort(), ['api_client.py', 'overlay.py']);

  // Канал остался на прошлой версии: недоделанная публикация никого не задела.
  const channel = await (await getManifest('?channel=stable')).json();
  assert.equal(channel.manifest.version, '2.13.1');
});

maybe('манифест конкретной версии доступен по номеру — это и есть откат', async () => {
  const response = await getManifest('?version=2.13.0');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.manifest.version, '2.13.0');

  const missing = await getManifest('?version=99.0.0');
  assert.equal(missing.status, 404);
});

maybe('архив версии отдаётся, а чужой путь — нет', async () => {
  const withArchive = manifestFor(V1, '2.15.0');
  const zip = Buffer.from('PK\u0003\u0004фейковый архив');
  await publish({ manifest: withArchive, files: encode(V1), bundle_base64: zip.toString('base64') });

  const ok = await routes.archiveGET(new Request('https://edringcolony.ru/x'), {
    params: Promise.resolve({ file: '2.15.0.zip' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/zip');
  assert.match(ok.headers.get('cache-control') ?? '', /immutable/);

  for (const file of ['../manifests/2.15.0.json', 'colonial_helper.py', '2.15.0.zip.exe']) {
    const bad = await routes.archiveGET(new Request('https://edringcolony.ru/x'), {
      params: Promise.resolve({ file }),
    });
    assert.equal(bad.status, 404, `путь ${file} не должен отдаваться`);
  }
});

maybe('базовая сборка: пока её нет — 404 со ссылкой на релизы, потом данные', async () => {
  const empty = await routes.launcherGET(new Request('https://edringcolony.ru/api/uploader/launcher?platform=win64'));
  assert.equal(empty.status, 404);
  const fallback = await empty.json();
  assert.match(fallback.url, /github\.com/, 'пилот не должен остаться без ссылки на файл');

  const saved = await publish({
    launcher: {
      platform: 'win64',
      version: '1.1.0',
      url: 'https://github.com/NooboGreenD/ed-ring-colony/releases/download/v2.13.0/ColonialHelper.exe',
      sha256: createHash('sha256').update('exe').digest('hex'),
      size: 23_159_225,
    },
  });
  assert.equal(saved.status, 200);

  const response = await routes.launcherGET(new Request('https://edringcolony.ru/api/uploader/launcher?platform=win64'));
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.version, '1.1.0');
  assert.equal(info.size, 23_159_225);
});

maybe('битая подпись не публикуется даже с правильным токеном', async () => {
  const manifest = manifestFor(V1, '2.16.0');
  manifest.notes = 'подменили заметки после подписи';
  const response = await publish({ manifest, files: encode(V1) });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /подпись/);

  const channel = await (await getManifest('?channel=stable')).json();
  assert.notEqual(channel.manifest.version, '2.16.0');
});
