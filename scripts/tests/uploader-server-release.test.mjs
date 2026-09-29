import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const zipPath = join(work, 'release.zip');
  writeFileSync(zipPath, archive);
  const names = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', zipPath],
  { encoding: 'utf8' }));
  assert.deepEqual(names.sort(), ['colonial_helper.py', 'manifest.json', 'overlay.py']);

  const duplicate = await store.createServerRelease({ version: '8.1.0', channel: 'stable', files });
  assert.equal(duplicate.ok, false, 'опубликованную версию нельзя тихо перезаписать');
});
