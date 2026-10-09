/**
 * Комплект первой Windows-сборки (GET /api/admin/uploader/build-kit).
 *
 * Регрессия: актуальный uploader/bundle.py держит TRUSTED_KEYS многострочным
 * словарём с комментариями, а маршрут искал объявление одной строкой и отвечал
 * «Не удалось встроить ключи: в bundle.py не найден TRUSTED_KEYS».
 *
 * Роут собирается настоящий (esbuild, подмена `next/server` и проверки
 * администратора), исходники берутся из настоящего каталога uploader/
 * (cwd = корень репозитория, как в образе /app). Без esbuild тест пропускается.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = mkdtempSync(join(tmpdir(), 'edrc-build-kit-'));
const previousCwd = process.cwd();
process.env.UPLOADER_STORE_DIR = join(work, 'store');
process.chdir(ROOT);
test.after(() => {
  process.chdir(previousCwd);
  rmSync(work, { recursive: true, force: true });
});

let esbuild = null;
try { esbuild = await import('esbuild'); } catch { esbuild = null; }
const maybe = esbuild ? test : test.skip;

let kit = null;
if (esbuild) {
  const shim = join(work, 'next-server.mjs');
  writeFileSync(shim, `export class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
  const auth = join(work, 'auth.mjs');
  writeFileSync(auth, "export async function requireAdmin() { return { actor: { userId: 'admin-test', role: 'owner' } }; }\n");
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, `export { GET } from '@/app/api/admin/uploader/build-kit/route';
export * from '@/lib/uploaderStore';
`);
  const outfile = join(work, 'build-kit.mjs');
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    alias: { 'next/server': shim, '@/lib/billing/auth': auth },
    tsconfig: join(ROOT, 'tsconfig.json'),
  });
  kit = await import(outfile);
}

/** Разбор ZIP по центральному каталогу — независимо от писальщика, на чистом Node. */
function readZip(archive) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let at = archive.length - 22; at >= 0; at -= 1) {
    if (archive.readUInt32LE(at) === EOCD) { eocd = at; break; }
  }
  assert.ok(eocd >= 0, 'в архиве есть End of Central Directory');
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, `запись центрального каталога #${index}`);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const raw = archive.subarray(localStart, localStart + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Границы объявления TRUSTED_KEYS в исходнике bundle.py. */
function trustedKeysBounds(source) {
  const start = source.search(/^TRUSTED_KEYS\b/m);
  assert.ok(start >= 0, 'в исходнике есть объявление TRUSTED_KEYS');
  return { start, end: source.indexOf('}', start) + 1 };
}

/** Пары «id: base64» из словаря TRUSTED_KEYS. */
function embeddedKeys(source) {
  const { start, end } = trustedKeysBounds(source);
  const block = source.slice(start, end);
  return Object.fromEntries([...block.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map(([, id, key]) => [id, key]));
}

let serverKey = null;
/** Серверная пара подписи: её публичная часть должна попасть в комплект. */
async function buildKit(version) {
  if (!serverKey) {
    serverKey = kit.generateSignKey('kit-server');
    assert.equal((await kit.storeSignKey(serverKey)).ok, true);
  }
  return kit.GET(new Request(`http://admin.test/api/admin/uploader/build-kit?version=${version}`));
}

maybe('комплект первой сборки встраивает серверные ключи в настоящий многострочный bundle.py', async () => {
  const res = await buildKit('8.5.0');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200, body.toString('utf8'));
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /ColonialHelper-build-8\.5\.0\.zip/);

  const files = readZip(body);
  for (const name of ['bundle.py', 'launcher.py', 'build_exe.py', 'BUILD-WINDOWS.bat', 'КАК-СОБРАТЬ.md']) {
    assert.ok(files.has(`ColonialHelper-build/${name}`), `в комплекте есть ${name}`);
  }
  assert.ok([...files.keys()].every((name) => !name.includes('/tests/')), 'тесты в комплект не попадают');

  const expected = kit.trustedPublicKeys();
  assert.equal(expected['kit-server'], serverKey.publicKey);
  const original = readFileSync(join(ROOT, 'uploader', 'bundle.py'), 'utf8');
  const kitBundle = files.get('ColonialHelper-build/bundle.py').toString('utf8');
  assert.deepEqual(embeddedKeys(kitBundle), expected, 'в bundle.py комплекта ровно ключи сервера');

  // Меняется только словарь: остальной исходный bundle.py на месте.
  const before = trustedKeysBounds(original);
  const after = trustedKeysBounds(kitBundle);
  assert.equal(kitBundle.slice(0, after.start), original.slice(0, before.start));
  assert.equal(kitBundle.slice(after.end), original.slice(before.end));
  assert.match(files.get('ColonialHelper-build/launcher.py').toString('utf8'), /^LAUNCHER_VERSION = "8\.5\.0"$/m);

  // Сервер читает клиентские ключи своим разбором: комплект должен давать те же ключи.
  const srcDir = join(work, 'kit-src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'bundle.py'), kitBundle);
  process.env.UPLOADER_SOURCE_DIR = srcDir;
  try {
    assert.deepEqual(Object.fromEntries(kit.clientTrustedKeys()), expected);
  } finally {
    delete process.env.UPLOADER_SOURCE_DIR;
  }
});

const hasPython = spawnSync('python3', ['--version']).status === 0;
const maybePython = esbuild && hasPython ? test : test.skip;

maybePython('встроенный bundle.py исполняется Python и отдаёт те же TRUSTED_KEYS', async () => {
  const res = await buildKit('8.5.1');
  const files = readZip(Buffer.from(await res.arrayBuffer()));
  const dir = join(work, 'python-check');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'bundle.py');
  writeFileSync(path, files.get('ColonialHelper-build/bundle.py'));
  const script = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("kit_bundle", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(json.dumps(module.TRUSTED_KEYS, sort_keys=True))',
  ].join('\n');
  const run = spawnSync('python3', ['-c', script, path], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), kit.trustedPublicKeys());
});

maybe('embedTrustedKeys заменяет однострочный словарь и сохраняет остальной файл', () => {
  const source = 'import os\nTRUSTED_KEYS: Dict[str, str] = {"old": "AAAA"}\nSCHEMA = 1\n';
  assert.equal(
    kit.embedTrustedKeys(source, { k202610: 'QUJD' }),
    'import os\nTRUSTED_KEYS: Dict[str, str] = {\n  "k202610": "QUJD"\n}\nSCHEMA = 1\n',
  );
});

maybe('embedTrustedKeys не принимает упоминание TRUSTED_KEYS в тексте за объявление', () => {
  const source = 'Ключи — в `TRUSTED_KEYS` (см. build_bundle.py).\nSCHEMA = 1\n'
    + 'TRUSTED_KEYS: Dict[str, str] = {\n    "old": "AAAA",\n}\n';
  const out = kit.embedTrustedKeys(source, { k: 'QUJD' });
  assert.ok(out.startsWith('Ключи — в `TRUSTED_KEYS` (см. build_bundle.py).\nSCHEMA = 1\n'));
  assert.ok(out.endsWith('TRUSTED_KEYS: Dict[str, str] = {\n  "k": "QUJD"\n}\n'));
});

maybe('embedTrustedKeys без объявления TRUSTED_KEYS падает с понятной ошибкой', () => {
  assert.throws(() => kit.embedTrustedKeys('SCHEMA = 1\n', { k: 'QUJD' }), /в bundle\.py не найден TRUSTED_KEYS/);
});
