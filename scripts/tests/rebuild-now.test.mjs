import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Настоящий Dockerfile: в нём есть RUN --mount=type=cache, по которому
  // скрипт обязан среагировать, когда BuildKit недоступен.
  copyFileSync(join(ROOT, 'Dockerfile'), join(dir, 'Dockerfile'));
  for (const name of ['compose-lib.sh', 'compose.supabase-net.yml', 'compose.legacy-build.yml']) {
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
    // STUB_BUILDX_EXIT=1 — плагина buildx нет (как в Alpine-образе агента
    // до пакета docker-cli-buildx): compose уходит в legacy-билдер.
    '  *"buildx version"*) exit "${STUB_BUILDX_EXIT:-0}" ;;',
    // Страж диска спрашивает корень Docker через info --format.
    '  *info*) printf "/var/lib/docker\\n" ;;',
    // Освобождение места — сабстантивная уборка (container/image prune из
    // edrc_cleanup_docker_disk); бюджетная подрезка builder prune файл df
    // не переписывает. STUB_DF_AFTER_PRUNE — сколько КБ осталось после.
    '  *"container prune"*|*"image prune"*)',
    '    if [ -n "${STUB_DF_FILE:-}" ]; then',
    '      printf "%s" "${STUB_DF_AFTER_PRUNE:-52428800}" > "$STUB_DF_FILE"',
    '    fi',
    '    exit 0 ;;',
    '  *" build "*)',
    // STUB_BUILD_FAIL_ONCE=1 — кратковременный сбой: первая сборка умирает
    // дедлайном, повторная после уборки успешна (счётчик — STUB_COUNT).
    '    if [ "${STUB_BUILD_FAIL_ONCE:-0}" = "1" ]; then',
    '      count="$(cat "$STUB_COUNT" 2>/dev/null || echo 0)"',
    '      printf "%s" "$((count + 1))" > "$STUB_COUNT"',
    '      if [ "$count" = "0" ]; then',
    '        echo "ERROR: failed to solve: DeadlineExceeded: context deadline exceeded" >&2',
    '        exit 1',
    '      fi',
    '    fi',
    '    exit "${STUB_BUILD_EXIT:-0}" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  // Стаб df для стража диска: свободное место (КБ, 4-е поле -Pk) — из
  // файла STUB_DF_FILE (по умолчанию 51200 МБ — сборке хватает).
  stub('df', [
    'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n"',
    'free="$(cat "${STUB_DF_FILE:-/edrc-nonexistent}" 2>/dev/null || true)"',
    '[ -n "$free" ] || free=52428800',
    'printf "/dev/sda1 104857600 31457280 %s 30%% /var/lib/docker\\n" "$free"',
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
      STUB_COUNT: join(dir, 'build-attempts'),
      STUB_BUILD_EXIT: '0',
      ...overrides,
    },
  });
  return { ...result, dir, calls: readFileSync(log, 'utf8') };
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
  test(`rebuild-now: failed build never replaces containers, but cleans up and retries (USE_CACHE=${useCache})`, { skip }, (t) => {
    const run = runRebuild(t, { USE_CACHE: useCache, STUB_BUILD_EXIT: '17' });
    assert.equal(run.status, 17, run.stdout + run.stderr);
    // Постоянный сбой: один автоповтор (UPDATE_BUILD_RETRIES=1) — две попытки.
    const builds = run.calls.split('\n').filter((line) => line.includes(' build '));
    assert.equal(builds.length, 2, 'один автоповтор после уборки');
    assert.match(run.stdout, /пробую собрать ещё раз/);
    // Работающие контейнеры НЕ трогаем, health не опрашиваем.
    assert.doesNotMatch(run.calls, / up -d /);
    assert.doesNotMatch(run.calls, /\[curl\]/);
    // Остатки сорвавшейся сборки чистим СРАЗУ после каждой попытки — раньше
    // кэш failed-сборок жил до следующего успешного прогона и съедал диск,
    // превращая каждую следующую сборку в гонку на «DeadlineExceeded».
    assert.match(run.calls, /builder prune -f/, 'остатки упавшей сборки убираются немедленно');
    assert.match(run.calls, /container prune -f/);
  });
}

test('rebuild-now: кратковременный сбой сборки переживается автоповтором без ручного клика', { skip }, (t) => {
  const run = runRebuild(t, { STUB_BUILD_FAIL_ONCE: '1' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const builds = run.calls.split('\n').filter((line) => line.includes(' build '));
  assert.equal(builds.length, 2, 'первая попытка умерла дедлайном — вторая доехала');
  assert.match(run.stdout, /пробую собрать ещё раз \(попытка 2 из 2\) после уборки/);
  assert.match(run.calls, / up -d /, 'успех доходит до переключения контейнеров');
  assert.match(run.calls, /\[curl\]/);
});

test('rebuild-now: UPDATE_BUILD_RETRIES=0 — без автоповтора, уборка после срыва остаётся', { skip }, (t) => {
  const run = runRebuild(t, { STUB_BUILD_EXIT: '17', UPDATE_BUILD_RETRIES: '0' });
  assert.equal(run.status, 17, run.stdout + run.stderr);
  const builds = run.calls.split('\n').filter((line) => line.includes(' build '));
  assert.equal(builds.length, 1, 'оператор явно отключил повторы');
  assert.doesNotMatch(run.calls, / up -d /);
  assert.match(run.calls, /builder prune -f/, 'кэш сорвавшейся сборки чистится и без ретрая');
});

test('rebuild-now: rejects a mistyped cache setting before building or deploying', { skip }, (t) => {
  const run = runRebuild(t, { USE_CACHE: 'yes' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /USE_CACHE должен быть 0/);
  assert.doesNotMatch(run.calls, / build | up -d /);
});

test('rebuild-now: без BuildKit web собирается по запасному Dockerfile без кэш-маунтов', { skip }, (t) => {
  // Ровно сбой с прод-сервера: «the --mount option requires BuildKit».
  // Плагина buildx нет → legacy-билдер → RUN --mount для него синтаксическая
  // ошибка. Скрипт обязан подставить сгенерированный Dockerfile и дойти
  // до конца, а не упасть на Step 5.
  const run = runRebuild(t, { STUB_BUILDX_EXIT: '1' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const build = run.calls.split('\n').find((line) => line.includes(' build '));
  assert.match(build, /-f deploy\/compose\.supabase-net\.yml -f deploy\/compose\.legacy-build\.yml --profile monitoring build --no-cache web jobs$/);
  assert.match(run.stdout, /BuildKit недоступен/);
  // Запасной Dockerfile сгенерирован из основного: убраны только --mount,
  // сами команды (npm ci, next build) не тронуты.
  const legacy = readFileSync(join(run.dir, '.edrc-legacy-Dockerfile'), 'utf8');
  assert.doesNotMatch(legacy, /^RUN --mount/m);
  assert.match(legacy, /^RUN npm ci --no-audit --no-fund$/m);
  assert.match(legacy, /^RUN npm run build$/m, 'сборка Next.js идёт, просто без кэш-маунта');
  // up — с тем же списком -f: контейнеры переключаются на собранный образ.
  assert.match(run.calls, /-f deploy\/compose\.legacy-build\.yml --profile monitoring up -d web jobs/);
  assert.match(run.calls, /\[curl\].*api\/health/);
});

test('rebuild-now: с плагином buildx кэш-маунты BuildKit остаются', { skip }, (t) => {
  const run = runRebuild(t, { STUB_BUILDX_EXIT: '0' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const build = run.calls.split('\n').find((line) => line.includes(' build '));
  assert.doesNotMatch(build, /legacy-build/, 'override не подключается: кэш-маунты работают');
  assert.equal(existsSync(join(run.dir, '.edrc-legacy-Dockerfile')), false, 'запасной Dockerfile не генерируется');
});

test('rebuild-now: EDRC_FORCE_LEGACY_BUILD=1 собирает без кэш-маунтов даже при buildx', { skip }, (t) => {
  // Аварийный выключатель: демон хоста может не тянуть BuildKit-сборки,
  // хотя плагин buildx формально установлен.
  const run = runRebuild(t, { EDRC_FORCE_LEGACY_BUILD: '1' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const build = run.calls.split('\n').find((line) => line.includes(' build '));
  assert.match(build, /-f deploy\/compose\.legacy-build\.yml --profile monitoring build --no-cache web jobs$/);
});

test('Docker builder inherits installed dependencies without a node_modules copy', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:22-alpine AS deps$/m);
  // Кэш-маунт закачек npm: пакеты переживают даже --no-cache пересборку.
  assert.match(dockerfile, /^RUN --mount=type=cache,target=\/root\/\.npm npm ci --no-audit --no-fund$/m);
  assert.match(dockerfile, /^FROM deps AS builder$/m);
  assert.doesNotMatch(dockerfile, /^COPY\s+--from=deps\s+\/app\/node_modules\b/m);
  // Инкрементальный кэш Next.js монтируется на время сборки (в образ не попадает).
  assert.match(dockerfile, /^RUN --mount=type=cache,target=\/app\/\.next\/cache npm run build$/m, 'Next.js still runs its TypeScript build gate');
  assert.match(dockerfile, /^FROM node:22-alpine AS runner$/m, 'runtime remains a separate minimal stage');
});
