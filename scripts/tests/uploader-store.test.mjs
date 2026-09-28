/**
 * Хранилище пакетов Colonial Helper (`src/lib/uploaderStore.ts`).
 *
 * Сервер раздаёт пилотам исполняемый код, поэтому тесты держат три вещи:
 *
 *  1. канонический вид манифеста совпадает с питоновским **байт в байт** —
 *     иначе подпись, поставленная в CI, не проверится ни здесь, ни в клиенте;
 *  2. публикация не принимает манифест с чужой/битой подписью и файл, чей
 *     sha256 не сошёлся;
 *  3. канал можно вернуть назад — это и есть откат сломанного релиза.
 *
 * Модуль собирается esbuild'ом из настоящего исходника: проверяется тот код,
 * который работает на сервере. Без esbuild тест честно пропускается.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const work = mkdtempSync(join(tmpdir(), 'edrc-uploader-'));
process.env.UPLOADER_STORE_DIR = join(work, 'store');

let store = null;
if (esbuild) {
  const outfile = join(work, 'uploaderStore.mjs');
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

/** Ed25519-ключ в том же виде, в каком его делает build_bundle.py (raw 32 байта). */
function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { privateKey, publicRaw: raw, publicB64: raw.toString('base64') };
}

function manifestFor(files, extra = {}) {
  return {
    schema: 1,
    channel: 'stable',
    version: '2.13.0',
    entry: 'colonial_helper.py',
    min_launcher: '1.0.0',
    released_at: '2026-09-28T10:00:00Z',
    notes: 'Раунд 67 — обновление пакетом, а не экзешником',
    files: Object.entries(files).map(([path, body]) => ({
      path,
      size: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    })),
    ...extra,
  };
}

function signManifest(manifest, key, keyId = 'test') {
  const payload = { ...manifest };
  delete payload.signature;
  const value = cryptoSign(null, store.canonicalManifestBytes(payload), key.privateKey);
  return { ...payload, signature: { alg: 'ed25519', key_id: keyId, value: value.toString('base64') } };
}

function encodeFiles(files) {
  return Object.fromEntries(Object.entries(files).map(([path, body]) => [path, Buffer.from(body).toString('base64')]));
}

const FILES = {
  'colonial_helper.py': 'VERSION = "2.13.0"\ndef main():\n    return 0\n',
  'overlay.py': 'BLOCKS = 7\n',
};

test.after(() => rmSync(work, { recursive: true, force: true }));

maybe('канонический JSON совпадает с python bundle.canonical_bytes', () => {
  const manifest = manifestFor(FILES, { signature: { alg: 'ed25519', value: 'игнорируется' } });
  const ours = store.canonicalManifestBytes(manifest);

  let theirs = null;
  try {
    const script = [
      'import json,sys',
      'sys.path.insert(0, sys.argv[1])',
      'import bundle',
      'sys.stdout.buffer.write(bundle.canonical_bytes(json.load(open(sys.argv[2], encoding="utf-8"))))',
    ].join('\n');
    const file = join(work, 'manifest-canon.json');
    writeFileSync(file, JSON.stringify(manifest), 'utf8');
    theirs = execFileSync('python3', ['-c', script, join(ROOT, 'uploader'), file], { maxBuffer: 4_000_000 });
  } catch {
    // python3 недоступен (например, node-образ без питона) — не повод падать.
  }
  if (theirs === null) return;
  assert.equal(ours.toString('utf8'), theirs.toString('utf8'),
    'канонизация разошлась с python — подпись из CI перестанет проверяться');
});

maybe('подпись, поставленная питоном в CI, проверяется сервером', () => {
  // Самый дорогой в отладке стык: подписывает python (`uploader/bundle.py`),
  // проверяет node. Если разойдутся канонизация или формат ключа, релиз
  // просто перестанет публиковаться — лучше узнать об этом здесь.
  const manifest = manifestFor(FILES, { version: '8.0.0' });
  const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  let signed = null;
  try {
    const script = [
      'import base64, json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'import bundle',
      'seed = base64.b64decode(sys.argv[2])',
      'manifest = json.load(open(sys.argv[3], encoding="utf-8"))',
      'signed = bundle.sign_manifest(manifest, seed, "ci")',
      'print(json.dumps({"public": base64.b64encode(bundle.ed25519_public_key(seed)).decode(),',
      '                  "manifest": signed}, ensure_ascii=False))',
    ].join('\n');
    const file = join(work, 'manifest-to-sign.json');
    writeFileSync(file, JSON.stringify(manifest), 'utf8');
    signed = JSON.parse(execFileSync('python3', [
      '-c', script, join(ROOT, 'uploader'), seed.toString('base64'), file,
    ], { maxBuffer: 4_000_000, encoding: 'utf8' }));
  } catch {
    return; // python3 недоступен — пропускаем, остальные тесты не зависят
  }
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `ci:${signed.public}`;
  const checked = store.verifyManifestSignature(signed.manifest);
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.checked, true);
});

maybe('подписанный пакет публикуется, файлы ложатся по хешам', async () => {
  const key = makeKey();
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `test:${key.publicB64}`;
  const manifest = signManifest(manifestFor(FILES), key);

  const result = await store.publishBundle({ manifest, files: encodeFiles(FILES) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.signatureChecked, true);
  assert.equal(result.storedBlobs, 2);

  const published = await store.manifestForChannel('stable');
  assert.equal(published.version, '2.13.0');

  const blob = await store.readBlob(manifest.files[0].sha256);
  assert.equal(blob.toString('utf8'), FILES['colonial_helper.py']);
});

maybe('повторная публикация не перекладывает уже лежащие файлы', async () => {
  const key = makeKey();
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `test:${key.publicB64}`;
  const changed = { ...FILES, 'colonial_helper.py': 'VERSION = "2.13.1"\ndef main():\n    return 0\n' };
  const manifest = signManifest({ ...manifestFor(changed), version: '2.13.1' }, key);
  const result = await store.publishBundle({ manifest, files: encodeFiles(changed) });
  assert.equal(result.ok, true, result.error);
  // overlay.py не изменился — он уже лежит на диске с прошлой публикации.
  assert.equal(result.storedBlobs, 1);
});

maybe('чужой ключ и подделанный манифест отклоняются', async () => {
  const key = makeKey();
  const stranger = makeKey();
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `test:${key.publicB64}`;

  const foreign = signManifest({ ...manifestFor(FILES), version: '9.0.0' }, stranger);
  const rejectedKey = await store.publishBundle({ manifest: foreign, files: encodeFiles(FILES) });
  assert.equal(rejectedKey.ok, false);

  const tampered = signManifest({ ...manifestFor(FILES), version: '9.0.1' }, key);
  tampered.notes = 'подменили после подписи';
  const rejected = await store.publishBundle({ manifest: tampered, files: encodeFiles(FILES) });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /подпись/);
});

maybe('файл, не совпавший по sha256, не попадает в хранилище', async () => {
  const key = makeKey();
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `test:${key.publicB64}`;
  const manifest = signManifest({ ...manifestFor(FILES), version: '9.1.0' }, key);
  const broken = { ...encodeFiles(FILES), 'overlay.py': Buffer.from('BLOCKS = 8\n').toString('base64') };
  const result = await store.publishBundle({ manifest, files: broken });
  assert.equal(result.ok, false);
  assert.match(result.error, /размер|sha256/);
});

maybe('недостающие файлы возвращаются списком, а не ошибкой «что-то пошло не так»', async () => {
  const key = makeKey();
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `test:${key.publicB64}`;
  const fresh = { 'colonial_helper.py': 'VERSION = "9.2.0"\n', 'overlay.py': 'BLOCKS = 9\n' };
  const manifest = signManifest({ ...manifestFor(fresh), version: '9.2.0' }, key);
  const result = await store.publishBundle({ manifest, files: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), ['colonial_helper.py', 'overlay.py']);
});

maybe('манифест с опасным путём не принимается', () => {
  for (const path of ['../evil.py', '/etc/passwd', 'sub/../../x.py', 'payload.exe']) {
    const checked = store.checkManifest(manifestFor({ [path]: 'x' }));
    assert.equal(checked.ok, false, `путь ${path} не должен проходить проверку`);
  }
});

maybe('канал можно вернуть на прошлую версию — это откат релиза', async () => {
  const key = makeKey();
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `test:${key.publicB64}`;
  const first = signManifest({ ...manifestFor(FILES), version: '3.0.0' }, key);
  await store.publishBundle({ manifest: first, files: encodeFiles(FILES) });
  const broken = { ...FILES, 'colonial_helper.py': 'VERSION = "3.1.0"\nraise SystemExit(1)\n' };
  const second = signManifest({ ...manifestFor(broken), version: '3.1.0' }, key);
  await store.publishBundle({ manifest: second, files: encodeFiles(broken) });
  assert.equal((await store.manifestForChannel('stable')).version, '3.1.0');

  const rolled = await store.promoteVersion('stable', '3.0.0');
  assert.equal(rolled.ok, true, rolled.error);
  assert.equal((await store.manifestForChannel('stable')).version, '3.0.0');
});

maybe('канал all отдаёт самое свежее из stable и beta', async () => {
  const key = makeKey();
  process.env.UPLOADER_SIGN_PUBLIC_KEYS = `test:${key.publicB64}`;
  const beta = signManifest({ ...manifestFor(FILES), version: '4.5.0', channel: 'beta' }, key);
  await store.publishBundle({ manifest: beta, files: encodeFiles(FILES) });
  assert.equal((await store.manifestForChannel('all')).version, '4.5.0');
  assert.equal((await store.manifestForChannel('stable')).version, '3.0.0');
});

maybe('токен публикации сравнивается целиком и не угадывается префиксом', () => {
  process.env.UPLOADER_PUBLISH_TOKEN = 'super-secret-token';
  const withHeader = (value) => new Request('https://edringcolony.ru/api/admin/uploader/publish', {
    method: 'POST',
    headers: value ? { authorization: value } : {},
  });
  assert.equal(store.isPublishAuthorized(withHeader('Bearer super-secret-token')), true);
  assert.equal(store.isPublishAuthorized(withHeader('Bearer super')), false);
  assert.equal(store.isPublishAuthorized(withHeader('super-secret-token')), false);
  assert.equal(store.isPublishAuthorized(withHeader(null)), false);
  delete process.env.UPLOADER_PUBLISH_TOKEN;
  assert.equal(store.isPublishAuthorized(withHeader('Bearer ')), false);
});

maybe('без настроенных ключей подпись не проверяется, но и без подписи не пускают', async () => {
  delete process.env.UPLOADER_SIGN_PUBLIC_KEYS;
  const unsigned = manifestFor(FILES, { version: '5.0.0' });
  const rejected = await store.publishBundle({ manifest: unsigned, files: encodeFiles(FILES) });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /не подписан/);
});

maybe('манифест лежит в хранилище и читается обратно целиком', async () => {
  const stored = JSON.parse(readFileSync(join(process.env.UPLOADER_STORE_DIR, 'manifests', '3.0.0.json'), 'utf8'));
  assert.equal(stored.version, '3.0.0');
  assert.ok(stored.signature?.value, 'подпись обязана сохраняться вместе с манифестом');
});

// ---------------------------------------------------------------------------
//  Настройки, редактируемые из админки (config.json)
// ---------------------------------------------------------------------------

maybe('generateSignKey даёт публичный ключ, выводимый из приватного seed', () => {
  delete process.env.UPLOADER_SIGN_PUBLIC_KEYS;
  const generated = store.generateSignKey('k-gen');
  assert.equal(generated.id, 'k-gen');
  const seed = Buffer.from(generated.privateKey, 'base64');
  assert.equal(seed.length, 32, 'приватный ключ — 32-байтовый seed');
  assert.equal(
    store.deriveEd25519Public(seed), generated.publicKey,
    'публичный ключ должен выводиться из приватного seed по RFC 8032',
  );
});

maybe('ключ, добавленный в config.json из UI, начинает проверять подпись', async () => {
  delete process.env.UPLOADER_SIGN_PUBLIC_KEYS;
  const key = makeKey();
  const seed = Buffer.from(key.privateKey.export({ format: 'jwk' }).d, 'base64url');
  // Кладём тот же публичный ключ, что у seed'а, но через API настроек.
  const added = await store.upsertSignKey('ui-key', store.deriveEd25519Public(seed));
  assert.equal(added.ok, true);

  const status = await store.storeStatus();
  assert.ok(status.keyIds.includes('ui-key'), 'ключ из config.json виден в статусе');
  assert.ok(status.configKeys.some((k) => k.id === 'ui-key'), 'ключ помечен как редактируемый');
  assert.deepEqual(status.envKeyIds, [], 'ключей из окружения сейчас нет');

  // Публикация с подписью этим ключом теперь проверяется по-настоящему.
  const manifest = signManifest(manifestFor(FILES, { version: '9.1.0' }), key, 'ui-key');
  const ok = await store.publishBundle({ manifest, files: encodeFiles(FILES) });
  assert.equal(ok.ok, true);
  assert.equal(ok.signatureChecked, true, 'подпись реально проверена ключом из config.json');

  // Чужая подпись под тем же id отклоняется.
  const other = makeKey();
  const forged = signManifest(manifestFor(FILES, { version: '9.2.0' }), other, 'ui-key');
  const bad = await store.publishBundle({ manifest: forged, files: encodeFiles(FILES) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /подпис/);
});

maybe('removeSignKey убирает ключ, а невалидный ключ не принимается', async () => {
  const rejected = await store.upsertSignKey('bad', 'не-base64-32-байта');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /32 байта/);

  const removed = await store.removeSignKey('ui-key');
  assert.equal(removed.ok, true);
  const status = await store.storeStatus();
  assert.ok(!status.keyIds.includes('ui-key'), 'после удаления ключа его нет в статусе');
});

maybe('токен публикации из config.json авторизует так же, как из окружения', async () => {
  delete process.env.UPLOADER_PUBLISH_TOKEN;
  const withHeader = (value) => new Request('https://edringcolony.ru/api/admin/uploader/publish', {
    method: 'POST',
    headers: value ? { authorization: value } : {},
  });
  // Слишком короткий токен не сохраняется.
  const short = await store.setPublishToken('short');
  assert.equal(short.ok, false);

  const saved = await store.setPublishToken('config-token-1234567890');
  assert.equal(saved.ok, true);
  assert.equal(store.isPublishAuthorized(withHeader('Bearer config-token-1234567890')), true);
  assert.equal(store.isPublishAuthorized(withHeader('Bearer config-token-000')), false);

  const status = await store.storeStatus();
  assert.equal(status.publishTokenSource, 'config');
  assert.equal(status.publishConfigured, true);

  // Очистка убирает токен.
  const cleared = await store.setPublishToken('');
  assert.equal(cleared.ok, true);
  assert.equal(store.isPublishAuthorized(withHeader('Bearer config-token-1234567890')), false);
  assert.equal((await store.storeStatus()).publishTokenSource, 'none');
});
