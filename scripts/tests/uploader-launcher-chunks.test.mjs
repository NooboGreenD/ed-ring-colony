import test from 'node:test';
import assert from 'node:assert/strict';
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
const work = mkdtempSync(join(tmpdir(), 'edrc-launcher-chunks-'));
process.env.UPLOADER_STORE_DIR = join(work, 'store');
test.after(() => rmSync(work, { recursive: true, force: true }));

let routes = null;
let uploadLauncherInChunks = null;
let chunkSize = 0;
if (esbuild) {
  const nextShim = join(work, 'next-server.mjs');
  writeFileSync(nextShim, `export class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
  const authShim = join(work, 'auth.mjs');
  writeFileSync(authShim, `export async function requireAdmin() {
  return { actor: { userId: 'test-admin' } };
}
`);
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, `export { POST as releasePOST, GET as releaseGET } from '@/app/api/admin/uploader/release/route';
export { uploadLauncherInChunks } from '@/lib/launcherChunkUpload';
export { readLauncher, readLauncherBinary } from '@/lib/uploaderStore';
export { LAUNCHER_UPLOAD_CHUNK_BYTES as chunkSize } from '@/lib/launcherUploadProtocol';
`);
  const outfile = join(work, 'routes.mjs');
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    alias: {
      'next/server': nextShim,
      '@/lib/billing/auth': authShim,
    },
    tsconfig: join(ROOT, 'tsconfig.json'),
  });
  routes = await import(outfile);
  uploadLauncherInChunks = routes.uploadLauncherInChunks;
  chunkSize = routes.chunkSize;
}

const BASE = 'https://edringcolony.ru';
const endpoint = `${BASE}/api/admin/uploader/release`;

function requestFor(body, headers = {}) {
  return new Request(endpoint, {
    method: 'POST',
    headers,
    body,
  });
}

async function waitForStoredBinary(platform, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const binary = await routes.readLauncherBinary(platform);
    if (binary) return binary;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('фоновая задача не записала EXE');
}

async function waitForJobFinished(id, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const response = await routes.releaseGET(new Request(`${endpoint}?job=${encodeURIComponent(id)}`));
    const { job } = await response.json();
    if (job && !job.active) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('фоновая задача не завершилась');
}

maybe('крупный ColonialHelper.exe уходит мелкими частями и собирается без multipart', async () => {
  assert.equal(chunkSize, 4 * 1024 * 1024);
  // 25.2 MiB — intentionally beyond the old global nginx limit of 25m.
  const source = Buffer.alloc(25 * 1024 * 1024 + 200 * 1024 + 37, 0x5a);
  source[0] = 0x4d;
  source[1] = 0x5a;
  const file = new Blob([source], { type: 'application/octet-stream' });
  const requests = [];
  const progress = [];
  const fetcher = async (input, init = {}) => {
    const request = new Request(new URL(String(input), BASE), init);
    const action = request.headers.get('x-helper-upload-action') || 'control';
    const requestSize = init.body instanceof Blob ? init.body.size : Buffer.byteLength(String(init.body ?? ''));
    requests.push({ action, requestSize, contentType: request.headers.get('content-type') });
    return routes.releasePOST(request);
  };

  const job = await uploadLauncherInChunks({
    file,
    platform: 'win64',
    version: '1.2.3',
    fetcher,
    onProgress: (uploaded, total, completed, count) => progress.push({ uploaded, total, completed, count }),
  });

  const chunks = requests.filter((request) => request.action === 'chunk');
  const expectedChunkSizes = Array(Math.floor(source.length / chunkSize)).fill(chunkSize);
  if (source.length % chunkSize) expectedChunkSizes.push(source.length % chunkSize);
  assert.equal(chunks.length, expectedChunkSizes.length);
  assert.ok(chunks.every((request) => request.requestSize <= chunkSize));
  assert.ok(chunks.every((request) => request.contentType === 'application/octet-stream'));
  assert.deepEqual(chunks.map((request) => request.requestSize), expectedChunkSizes);
  assert.equal(requests[0].action, 'control');
  assert.equal(requests.at(-1).action, 'control');
  assert.equal(job.id.length, 36);
  assert.equal(job.kind, 'launcher');
  assert.equal(job.stats.totalBytes, source.length);
  assert.equal(progress.at(-1).uploaded, source.length);
  assert.equal(progress.at(-1).completed, expectedChunkSizes.length);
  assert.equal(progress.at(-1).count, expectedChunkSizes.length);

  const saved = await waitForStoredBinary('win64');
  assert.deepEqual(saved, source);
  const info = await routes.readLauncher('win64');
  assert.equal(info.version, '1.2.3');
  assert.equal(info.size, source.length);
  await waitForJobFinished(job.id);

  // Повтор complete после потерянного ответа возвращает прежнюю задачу.
  const retry = await routes.releasePOST(requestFor(JSON.stringify({
    kind: 'launcher', action: 'complete', uploadId: job.id,
  }), { 'content-type': 'application/json' }));
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).job.id, job.id);
});

maybe('сервер не принимает сборку, пока не получены все части', async () => {
  const source = Buffer.alloc(chunkSize + 11, 0x37);
  source[0] = 0x4d;
  source[1] = 0x5a;
  const begin = await routes.releasePOST(requestFor(JSON.stringify({
    kind: 'launcher', action: 'begin', platform: 'win64', version: '1.2.4', size: source.length,
  }), { 'content-type': 'application/json' }));
  assert.equal(begin.status, 201);
  const { uploadId } = await begin.json();

  const firstPart = source.subarray(0, chunkSize);
  const first = await routes.releasePOST(requestFor(firstPart, {
    'content-type': 'application/octet-stream',
    'x-helper-upload-action': 'chunk',
    'x-helper-upload-id': uploadId,
    'x-helper-chunk-index': '0',
  }));
  assert.equal(first.status, 200);

  const incomplete = await routes.releasePOST(requestFor(JSON.stringify({
    kind: 'launcher', action: 'complete', uploadId,
  }), { 'content-type': 'application/json' }));
  assert.equal(incomplete.status, 409);
  assert.match((await incomplete.json()).error, /часть 2/i);

  const cancelled = await routes.releasePOST(requestFor(JSON.stringify({
    kind: 'launcher', action: 'cancel', uploadId,
  }), { 'content-type': 'application/json' }));
  assert.equal(cancelled.status, 200);
});

maybe('413 от внешнего proxy автоматически уменьшает размер частей и повторяет загрузку', async () => {
  const ingressLimit = 1024 * 1024;
  const source = Buffer.alloc(2 * 1024 * 1024 + 37, 0x61);
  source[0] = 0x4d;
  source[1] = 0x5a;
  const rejectedSizes = [];
  const acceptedSizes = [];
  const retries = [];
  const fetcher = async (input, init = {}) => {
    const request = new Request(new URL(String(input), BASE), init);
    const action = request.headers.get('x-helper-upload-action') || 'control';
    const bodySize = init.body instanceof Blob ? init.body.size : Buffer.byteLength(String(init.body ?? ''));
    if (action === 'chunk' && bodySize > ingressLimit) {
      rejectedSizes.push(bodySize);
      return new Response('request entity too large', { status: 413 });
    }
    if (action === 'chunk') acceptedSizes.push(bodySize);
    return routes.releasePOST(request);
  };

  const job = await uploadLauncherInChunks({
    file: new Blob([source]),
    platform: 'win64-fallback',
    version: '1.2.5',
    fetcher,
    onRetry: (nextSize) => retries.push(nextSize),
  });
  assert.deepEqual(retries, [2 * 1024 * 1024, 1024 * 1024]);
  assert.ok(rejectedSizes.length >= 2, 'both larger request sizes should be rejected by the fake ingress');
  assert.ok(rejectedSizes.every((size) => size > ingressLimit));
  assert.deepEqual(acceptedSizes, [ingressLimit, ingressLimit, 37]);
  assert.equal(job.kind, 'launcher');
  assert.deepEqual(await waitForStoredBinary('win64-fallback'), source);
  await waitForJobFinished(job.id);
});
