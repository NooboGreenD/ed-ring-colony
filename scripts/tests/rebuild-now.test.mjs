import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = join(ROOT, 'deploy/rebuild-now.sh');
const skip = spawnSync('bash', ['--version']).status === 0 ? false : 'requires bash';

// Exercise the real deploy script, but never contact Docker, GitHub or a site.
// The fixture is outside the checkout and all credentials are test-only.
function runRebuild(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-rebuild-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const deploy = join(dir, 'deploy');
  const log = join(dir, 'commands.log');
  mkdirSync(bin);
  mkdirSync(deploy);
  writeFileSync(log, '');
  writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  web:\n    image: example-web\n');
  writeFileSync(join(dir, '.env.production'), [
    'NEXT_PUBLIC_SUPABASE_URL=https://example.invalid',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY=test-only-anon-key',
    'NEXT_PUBLIC_SITE_URL=https://example.invalid',
    'CRON_SECRET=test-only-cron-secret',
    'SUPABASE_NETWORK=fixture_supabase',
    '',
  ].join('\n'));
  for (const name of ['compose-lib.sh', 'compose.supabase-net.yml']) {
    copyFileSync(join(ROOT, 'deploy', name), join(deploy, name));
  }

  const stub = (name, body) => {
    const file = join(bin, name);
    writeFileSync(file, '#!/usr/bin/env bash\n' + body + '\n');
    chmodSync(file, 0o755);
  };
  stub('docker', [
    'printf "[docker] %s\\n" "$*" >> "$STUB_LOG"',
    'case "$*" in',
    '  *" build "*) exit "${STUB_BUILD_EXIT:-0}" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  stub('curl', 'printf "[curl] %s\\n" "$*" >> "$STUB_LOG"\nexit 0');
  stub('git', 'exit 1'); // metadata safely falls back to "unknown" with NO_PULL=1

  const result = spawnSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      REPO_DIR: dir,
      ENV_FILE: join(dir, '.env.production'),
      NO_PULL: '1',
      USE_CACHE: '', // empty/unset keeps the existing full-rebuild default
      SKIP_TESTS: '0',
      COMPOSE_SERVICES: 'web jobs',
      HEALTH_TRIES: '1',
      WEB_URL: 'http://example.invalid/api/health',
      STUB_LOG: log,
      STUB_BUILD_EXIT: '0',
      ...overrides,
    },
  });
  return { ...result, calls: readFileSync(log, 'utf8') };
}

test('rebuild-now: full rebuild still uses --no-cache by default', { skip }, (t) => {
  const run = runRebuild(t);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.calls, /\[docker\].* build --no-cache web jobs\n/);
  assert.match(run.stdout, /ПОЛНАЯ ПЕРЕСБОРКА без кэша/);
  assert.match(run.calls, /\[docker\].* up -d web jobs\n/);
});

test('rebuild-now: USE_CACHE=1 reuses layers and preserves the Supabase Compose override', { skip }, (t) => {
  const run = runRebuild(t, { USE_CACHE: '1' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const build = run.calls.split('\n').find((line) => line.includes(' build '));
  assert.ok(build, 'the image is still built');
  assert.match(build, /-f deploy\/compose\.supabase-net\.yml --profile monitoring build web jobs$/);
  assert.doesNotMatch(build, /--no-cache/);
  assert.match(run.stdout, /ПЕРЕСБОРКА с кэшем/);
  assert.match(run.calls, /-f deploy\/compose\.supabase-net\.yml --profile monitoring up -d web jobs/);
  assert.ok(run.calls.indexOf(' build ') < run.calls.indexOf(' up -d '));
  assert.match(run.calls, /\[curl\].*api\/health/);
});

for (const useCache of ['0', '1']) {
  test(`rebuild-now: failed build never replaces containers (USE_CACHE=${useCache})`, { skip }, (t) => {
    const run = runRebuild(t, { USE_CACHE: useCache, STUB_BUILD_EXIT: '17' });
    assert.equal(run.status, 17, run.stdout + run.stderr);
    assert.match(run.calls, / build /);
    assert.doesNotMatch(run.calls, / up -d |image prune|\[curl\]/);
  });
}

test('rebuild-now: rejects a mistyped cache setting before building or deploying', { skip }, (t) => {
  const run = runRebuild(t, { USE_CACHE: 'yes' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /USE_CACHE должен быть 0/);
  assert.doesNotMatch(run.calls, / build | up -d /);
});

test('Docker builder inherits installed dependencies without a node_modules copy', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:22-alpine AS deps$/m);
  assert.match(dockerfile, /^RUN npm ci --no-audit --no-fund$/m);
  assert.match(dockerfile, /^FROM deps AS builder$/m);
  assert.doesNotMatch(dockerfile, /^COPY\s+--from=deps\s+\/app\/node_modules\b/m);
  assert.match(dockerfile, /^RUN npm run build$/m, 'Next.js still runs its TypeScript build gate');
  assert.match(dockerfile, /^FROM node:22-alpine AS runner$/m, 'runtime remains a separate minimal stage');
});
