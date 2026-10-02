import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let esbuild;
try { esbuild = await import('esbuild'); } catch { esbuild = null; }
const maybe = esbuild ? test : test.skip;
const work = mkdtempSync(join(tmpdir(), 'edrc-server-release-'));
process.env.UPLOADER_STORE_DIR = join(work, 'store');

let store;
if (esbuild) {
  const outfile = join(work, 'store.mjs');
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/lib/uploaderStore.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  store = await import(outfile);
}

test.after(() => rmSync(work, { recursive: true, force: true }));

/**
 * Имена записей ZIP по центральному каталогу — независимая от писальщика
 * проверка структуры архива (EOCD → записи PK\x01\x02), без python3.
 */
function zipEntryNames(archive) {
  const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = archive.lastIndexOf(EOCD);
  assert.ok(eocd >= 0, 'в архиве есть End of Central Directory');
  const count = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const names = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, `central directory entry #${index} подписан PK\x01\x02`);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    names.push(archive.toString('utf8', cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

maybe('сервер сам подписывает и собирает рабочий ZIP без CI/GitHub', async () => {
  const key = store.generateSignKey('server-test');
  assert.equal((await store.storeSignKey(key)).ok, true);
  const files = new Map([
    ['uploader/colonial_helper.py', Buffer.from('VERSION = "8.1.0"\ndef main(): pass\n')],
    ['uploader/overlay.py', Buffer.from('BLOCKS = 8\n')],
    // Сборочный файл не должен попасть пилоту.
    ['uploader/build_exe.py', Buffer.from('raise SystemExit()\n')],
  ]);
  const result = await store.createServerRelease({
    version: '8.1.0',
    channel: 'stable',
    notes: 'автономный выпуск',
    files,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.signatureChecked, true);
  assert.equal(await store.readChannelVersion('stable'), '8.1.0');
  const manifest = await store.readManifest('8.1.0');
  assert.equal(manifest.signature.key_id, 'server-test');
  assert.deepEqual(manifest.files.map((item) => item.path), ['colonial_helper.py', 'overlay.py']);

  const archive = await store.readBundleArchive('8.1.0');
  // Состав архива проверяем по центральному каталогу ZIP на чистом Node:
  // раньше здесь звали python3-модуль zipfile, но в web-образе на шаге
  // `npm test` (node:22-alpine) python3 нет — тест валил docker build.
  const names = zipEntryNames(archive);
  assert.deepEqual(names.sort(), ['colonial_helper.py', 'manifest.json', 'overlay.py']);

  const duplicate = await store.createServerRelease({ version: '8.1.0', channel: 'stable', files });
  assert.equal(duplicate.ok, false, 'опубликованную версию нельзя тихо перезаписать');
});
