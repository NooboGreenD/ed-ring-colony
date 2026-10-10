import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const dir = mkdtempSync(join(process.cwd(), '.tmp-outfitting-cache-'));
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
await build({ entryPoints: ['src/lib/outfitting/useOutfittingData.ts'], outfile: join(dir, 'cache.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['react'], logLevel: 'silent' });
const { loadOutfittingData, publishOutfittingData } = await import(join(dir, 'cache.mjs'));
const base = JSON.parse(readFileSync('public/data/outfitting.json', 'utf8'));
const reply = data => ({ ok: true, status: 200, json: async () => data });

test('public effective-catalogue fetch uses no-store and shares its cache', async () => {
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return reply(base); };
  const first = await loadOutfittingData(true);
  assert.equal(first, base);
  assert.equal(await loadOutfittingData(), first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/outfitting/catalog');
  assert.equal(calls[0].options.cache, 'no-store');
});

test('an admin save supersedes an earlier slow read rather than losing its changes', async () => {
  let finish;
  global.fetch = () => new Promise(resolve => { finish = resolve; });
  const read = loadOutfittingData(true);
  const edited = { ...structuredClone(base), catalogRevision: 10 };
  publishOutfittingData(edited);
  finish(reply({ ...base, catalogRevision: 9 }));
  assert.equal((await read).catalogRevision, 10);
  assert.equal(await loadOutfittingData(), edited);
});

test('failed and malformed refreshes keep the last successful catalogue and allow retries', async () => {
  global.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(loadOutfittingData(true), /503/);
  assert.equal((await loadOutfittingData()).catalogRevision, 10);
  global.fetch = async () => reply({});
  await assert.rejects(loadOutfittingData(true), /Некорректный справочник/);
  assert.equal((await loadOutfittingData()).catalogRevision, 10);
  global.fetch = async () => reply({ ...base, catalogRevision: 11 });
  assert.equal((await loadOutfittingData(true)).catalogRevision, 11);
});
