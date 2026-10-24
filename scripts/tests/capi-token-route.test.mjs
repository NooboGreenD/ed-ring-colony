import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let esbuild = null;
try { esbuild = await import('esbuild'); } catch { /* optional dev dependency */ }
const maybe = esbuild ? test : test.skip;

maybe('legacy CAPI token bridge is retired and never returns Frontier credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capi-token-retired-'));
  try {
    const result = await esbuild.build({
      entryPoints: ['src/app/api/capi/token/route.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      plugins: [{
        name: 'next-server-test-stub',
        setup(build) {
          build.onResolve({ filter: /^next\/server$/ }, () => ({ path: 'next-server', namespace: 'test-stub' }));
          build.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({
            contents: `export const NextResponse = { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200, headers: init.headers }) };`,
            loader: 'js',
          }));
        },
      }],
    });
    const entry = join(dir, 'route.mjs');
    writeFileSync(entry, result.outputFiles[0].text);
    const route = await import(`${pathToFileURL(entry).href}?v=${Date.now()}`);
    for (const response of [
      await route.GET(new Request('https://colony.test/api/capi/token')),
      await route.POST(new Request('https://colony.test/api/capi/token', { method: 'POST' })),
    ]) {
      assert.equal(response.status, 410);
      const body = await response.json();
      assert.equal(body.code, 'capi_token_bridge_retired');
      assert.equal('tokens' in body, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
