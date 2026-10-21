import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const configUrl = pathToFileURL(resolve(root, 'next.config.mjs')).href;

function loadConfig(internalUrl = '', publicUrl = '') {
  const code = `import config from ${JSON.stringify(configUrl)};
const value = await config.rewrites();
console.log(JSON.stringify(value));`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SUPABASE_INTERNAL_URL: internalUrl,
      NEXT_PUBLIC_SUPABASE_URL: publicUrl,
    },
  });
}

function rewrites(internalUrl = '', publicUrl = '') {
  const result = loadConfig(internalUrl, publicUrl);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('same-origin Supabase gateway is compiled only with an explicit private Kong URL', () => {
  assert.deepEqual(rewrites(), []);

  const result = rewrites('http://kong:8000');
  assert.deepEqual(result, {
    beforeFiles: [{
      source: '/api/supabase/:path*',
      destination: 'http://kong:8000/:path*',
    }],
    afterFiles: [],
    fallback: [],
  });
});

test('same-origin Supabase URL fails the build when its private Kong rewrite is missing', () => {
  const result = loadConfig('', 'https://edringcolony.ru/api/supabase/');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEXT_PUBLIC_SUPABASE_URL uses \/api\/supabase but SUPABASE_INTERNAL_URL is empty/);

  // The private rewrite stays optional when the browser talks to a public
  // Supabase host directly.
  assert.deepEqual(rewrites('', 'https://supabase.edringcolony.ru'), []);
});

test('gateway remains a Next rewrite, excludes auth middleware and gets its private URL at build time', () => {
  const config = readFileSync(resolve(root, 'next.config.mjs'), 'utf8');
  const middleware = readFileSync(resolve(root, 'src/proxy.ts'), 'utf8');
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');

  assert.match(config, /proxyTimeout: 3_600_000/);
  assert.match(config, /proxyClientMaxBodySize: '50mb'/);
  assert.match(middleware, /path\.startsWith\('\/api\/supabase\/'\)/);
  assert.match(compose, /SUPABASE_INTERNAL_URL: \$\{SUPABASE_INTERNAL_URL:-\}/);
  assert.match(dockerfile, /ARG SUPABASE_INTERNAL_URL/);
});
