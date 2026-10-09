import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * Подменный каталог исходников с TRUSTED_KEYS, как в настоящем
 * `uploader/bundle.py`: именно этот файл зашит в установленные программы,
 * и сервер обязан подписывать релизы одним из этих ключей.
 */
function writeClientSource(name, trusted) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const pairs = Object.entries(trusted)
    .map(([id, key]) => `    "${id}": "${key}",`)
    .join('\n');
  writeFileSync(join(dir, 'bundle.py'), `TRUSTED_KEYS: Dict[str, str] = {\n${pairs}\n}\n`);
  return dir;
}

/** Имена записей ZIP по центральному каталогу — независимая от писальщика проверка структуры архива. */
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

const filesFor = (version) => new Map([
  ['uploader/colonial_helper.py', Buffer.from(`VERSION = "${version}"\ndef main(): pass\n`)],
  ['uploader/overlay.py', Buffer.from('BLOCKS = 8\n')],
  // Сборочный файл не должен попасть пилоту.
  ['uploader/build_exe.py', Buffer.from('raise SystemExit()\n')],
]);

maybe('сервер подписывает релиз ключом, доверенным установленным программам', async () => {
  const key = store.generateSignKey('server-test');
  assert.equal((await store.storeSignKey(key)).ok, true);
  // Клиенты (bundle.py из этого исходника) знают ровно этот ключ — релиз
  // подписывается им без дополнительных подтверждений.
  process.env.UPLOADER_SOURCE_DIR = writeClientSource('src-trusted', { 'server-test': key.publicKey });
  const result = await store.createServerRelease({
    version: '8.1.0',
    channel: 'stable',
    notes: 'автономный выпуск',
    files: filesFor('8.1.0'),
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

  const duplicate = await store.createServerRelease({ version: '8.1.0', channel: 'stable', files: filesFor('8.1.0') });
  assert.equal(duplicate.ok, false, 'опубликованную версию нельзя тихо перезаписать');
});

maybe('если пара из настроек клиентам неизвестна, релиз подписывается каноническим ключом канала', async () => {
  process.env.UPLOADER_SOURCE_DIR = writeClientSource('src-k202609', { k202609: Buffer.alloc(32, 3).toString('base64') });
  const published = await store.createServerRelease({
    version: '8.2.0',
    channel: 'stable',
    files: filesFor('8.2.0'),
  });
  assert.equal(published.ok, true, published.error);
  assert.equal((await store.readManifest('8.2.0')).signature.key_id, store.CANONICAL_SIGN_KEY_ID);
  assert.equal(await store.readChannelVersion('stable'), '8.2.0');
});

maybe('переподпись канала чинит релиз, подписанный неизвестным клиентам ключом', async () => {
  // Пока сервер владеет только чужим клиентам ключом, переподпись честно
  // требует импортировать доверенный seed.
  const refused = await store.resignChannelManifests();
  assert.equal(refused.ok, false);
  assert.match(refused.error, /k202609/);

  // Администратор импортирует приватный seed доверенного ключа k202609.
  const trustedKey = store.generateSignKey('k202609');
  assert.equal((await store.storeSignKey(trustedKey)).ok, true);
  process.env.UPLOADER_SOURCE_DIR = writeClientSource('src-k202609-real', { k202609: trustedKey.publicKey });

  const resign = await store.resignChannelManifests();
  assert.equal(resign.ok, true, resign.error);
  const stable = resign.outcomes.find((item) => item.channel === 'stable');
  assert.ok(stable.action === 'signed' || stable.action === 'kept');
  assert.equal(stable.keyId, 'k202609');
  assert.ok(resign.outcomes.some((item) => item.channel === 'beta' && item.action === 'missing'));

  const manifest = await store.readManifest('8.2.0');
  assert.equal(manifest.signature.key_id, 'k202609', 'манифест переподписан доверенным ключом');
  assert.deepEqual(manifest.files.map((item) => item.path), ['colonial_helper.py', 'overlay.py'], 'состав версии не менялся');

  // Повторный вызов не трогает уже верную подпись.
  const again = await store.resignChannelManifests();
  assert.equal(again.ok, true);
  assert.equal(again.outcomes.find((item) => item.channel === 'stable').action, 'kept');

  // И серверная подпись новым релизом теперь сразу доверенная.
  const next = await store.createServerRelease({ version: '8.3.0', channel: 'stable', files: filesFor('8.3.0') });
  assert.equal(next.ok, true, next.error);
  assert.equal((await store.readManifest('8.3.0')).signature.key_id, 'k202609');
});

maybe('clientTrustedKeys читает TRUSTED_KEYS из настоящего uploader/bundle.py', async () => {
  process.env.UPLOADER_SOURCE_DIR = join(ROOT, 'uploader');
  const keys = store.clientTrustedKeys();
  assert.ok([...keys.keys()].includes('k202609'), 'в репозитарном bundle.py зашит k202609');
  assert.ok([...keys.keys()].includes('k202610'), 'канонический ключ канала зашит в клиент');
  assert.equal(keys.get('k202610'), store.CANONICAL_SIGN_PUBLIC_B64);
  assert.equal(Buffer.from(keys.get('k202609'), 'base64').length, 32);
});

maybe('удаление версии снимает манифест, но не трогает активный канал', async () => {
  process.env.UPLOADER_SOURCE_DIR = join(ROOT, 'uploader');
  const made = await store.createServerRelease({
    version: '8.4.0',
    channel: 'beta',
    files: filesFor('8.4.0'),
    promote: false,
  });
  assert.equal(made.ok, true, made.error);
  const blocked = await store.deleteVersion(await store.readChannelVersion('stable'));
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /канале/);
  const removed = await store.deleteVersion('8.4.0');
  assert.equal(removed.ok, true, removed.error);
  assert.equal(await store.readManifest('8.4.0'), null);
});
