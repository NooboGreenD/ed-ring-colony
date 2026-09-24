import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENV_STAGES,
  UPDATE_PROTOCOL,
  UPDATE_STAGES,
  applyProgressEvent,
  emptyUpdateState,
  parseProgressLine,
  publicUpdateView,
  sanitizeLogLine,
  sanitizeUpdateState,
} from '../lib/update-state.mjs';
import {
  createUpdateManager,
  createUpdateServer,
  tokenMatches,
  updateAgentConfig,
} from '../update-agent.mjs';

/**
 * Контракт ручного обновления проекта (Админка → Мониторинг → «Обновление
 * проекта») и всего, что из него видно: статуса в шапке сайта.
 *
 * Слои проверяются раздельно, потому что ломаются по-разному:
 *  1. парсер прогресса и публичное представление — утёкший в лог токен или
 *     «залипший» running превращаются в прод-инцидент;
 *  2. HTTP-агент (старт/повтор/отмена/401) — на него опираются и веб-роут,
 *     и опрос шапки посетителем;
 *  3. deploy/update-project.sh — shell, который не типизируется и не собирается,
 *     поэтому проверяем синтаксис и наличие обязательных стадий.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const TOKEN = 'update-agent-test-token-not-a-real-secret';

// Скрипты обновления рассчитаны на реальный сервер (Ubuntu/Debian всегда с
// bash), но `npm test` выполняется ещё и внутри node:22-alpine на шаге
// Docker build, где bash нет. Там shell-тесты пропускаются, а не валят сборку.
const needsBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
  ? false
  : 'bash is not available in this image';

function testConfig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-update-'));
  return updateAgentConfig({
    UPDATE_AGENT_HOST: '127.0.0.1',
    UPDATE_AGENT_TOKEN: TOKEN,
    PROJECT_DIR: dir,
    UPDATE_STATE_DIR: join(dir, 'state'),
    UPDATE_SCRIPT: join(dir, 'fake-update.sh'),
    PROJECT_REPOSITORY: 'NooboGreenD/ed-ring-colony',
    PROJECT_UPDATE_BRANCH: 'main',
    ...overrides,
  });
}

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
}

/* ── 1. протокол прогресса и публичное представление ─────────────── */

test('progress protocol: only tagged lines become events, noise never does', () => {
  const event = parseProgressLine(UPDATE_PROTOCOL + '{"stage":"build","percent":62,"message":"npm run build"}');
  assert.equal(event.stage, 'build');
  assert.equal(event.percent, 62);
  assert.equal(parseProgressLine('Step 4/12 : RUN npm ci'), null);
  assert.equal(parseProgressLine(''), null);
  assert.equal(parseProgressLine(UPDATE_PROTOCOL + '{broken json'), null);
  // Случайная строка «stage=build percent=99» не должна уметь двигать шкалу.
  assert.equal(parseProgressLine('stage=build percent=99'), null);
});

test('progress folding: известные стадии двигают шкалу только вперёд', () => {
  const base = emptyUpdateState('2026-09-22T10:00:00.000Z');
  const moved = applyProgressEvent(base, { stage: 'build', percent: 55, message: 'сборка' }, '2026-09-22T10:01:00.000Z');
  assert.equal(moved.stage, 'build');
  assert.equal(moved.percent, 55);
  assert.equal(moved.state, 'running');
  assert.equal(base.percent, 0, 'исходный объект не мутируется');

  const backwards = applyProgressEvent(moved, { stage: 'fetch', percent: 15 }, '2026-09-22T10:02:00.000Z');
  assert.equal(backwards.stage, 'fetch', 'стадия отражает текущий шаг');
  assert.equal(backwards.percent, 55, 'процент назад не откатывается');

  const unknown = applyProgressEvent(moved, { stage: 'nope', percent: 99 }, '2026-09-22T10:03:00.000Z');
  assert.equal(unknown.percent, 55, 'неизвестная стадия не имеет права перематывать шкалу');
});

test('log lines: секреты и управляющие коды не попадают в панель', () => {
  const token = TOKEN;
  assert.equal(sanitizeLogLine('UPDATE_AGENT_TOKEN=' + token + ' tail').includes(token), false);
  assert.equal(sanitizeLogLine('pg_dump "postgres://postgres:s3cr3t@db:5432/postgres"').includes('s3cr3t'), false);
  assert.equal(sanitizeLogLine('  лишние пробелы  ').trim(), 'лишние пробелы');
  assert.equal(sanitizeLogLine('   '), null);
  assert.equal(sanitizeLogLine(''), null);
  assert.equal(sanitizeLogLine(null), null);
  assert.ok(sanitizeLogLine('a'.repeat(500)).length <= 280);
});

test('public view: посетитель видит стадию и процент, но не сервер', () => {
  const view = publicUpdateView({
    state: 'running',
    stage: 'build',
    percent: 70,
    startedAt: '2026-09-22T10:00:00.000Z',
    log: [{ at: null, line: 'npm run build' }],
    fromSha: 'a'.repeat(40),
    mode: 'compose',
    error: 'не должно попасть наружу',
  });
  assert.deepEqual(Object.keys(view).sort(), [
    'active', 'kind', 'percent', 'stage', 'stageLabel', 'startedAt', 'state', 'updatedAt',
  ]);
  // kind — единственное новое поле для витрины: по нему заглушка понимает,
  // что идёт именно копия базы. Ничего серверного в нём нет.
  assert.equal(view.kind, 'update');
  assert.equal(publicUpdateView({ state: 'running', kind: 'backup', stage: 'backup' }).kind, 'backup');
  assert.equal(view.active, true);
  assert.equal(view.percent, 70);
  assert.equal(view.stageLabel, 'Сборка новой версии');
  assert.equal(JSON.stringify(view).includes('npm run build'), false);
  assert.equal(JSON.stringify(view).includes('a'.repeat(40)), false);
  assert.equal(JSON.stringify(view).includes('compose'), false);

  // После завершения или падения — полный покой: «System Update» не залипает.
  const done = publicUpdateView({ state: 'succeeded', stage: 'done', percent: 100 });
  assert.equal(done.active, false);
  assert.equal(done.state, 'idle');
  assert.equal(done.percent, 0);
});

test('state sanitising: чужие ключи и битые значения отбрасываются', () => {
  const dirty = sanitizeUpdateState({
    state: 'running',
    percent: 1000,
    fromSha: '../etc/passwd',
    toSha: 'a'.repeat(40),
    branch: 'ma in;rm -rf /',
    extraHostKey: ' leaking ',
    log: [{ line: 'UPDATE_AGENT_TOKEN=' + TOKEN }, 'обычная строка'],
  });
  assert.equal(dirty.percent, 100);
  assert.equal(dirty.fromSha, null);
  assert.equal(dirty.toSha, ('a'.repeat(40)));
  assert.equal(dirty.branch, null);
  assert.equal('extraHostKey' in dirty, false);
  assert.equal(JSON.stringify(dirty).includes(TOKEN), false);
  assert.equal(dirty.log.length, 2);
});

/* ── 2. конфигурация и доступ ────────────────────────────────────── */

test('token check: только Bearer, никакой предпосылки «свой»', () => {
  assert.equal(tokenMatches('Bearer ' + TOKEN, TOKEN), true);
  assert.equal(tokenMatches('bearer ' + TOKEN, TOKEN), true);
  assert.equal(tokenMatches('Bearer ' + TOKEN + 'x', TOKEN), false);
  assert.equal(tokenMatches(TOKEN, TOKEN), false, 'без схемы Bearer — отказ');
  assert.equal(tokenMatches('Bearer nope', ''), false, 'пустой ожидающий токен — отказ');
});

test('config: агент, доступный не только с loopback, обязан иметь токен', () => {
  const loopback = updateAgentConfig({ UPDATE_AGENT_HOST: '127.0.0.1', UPDATE_AGENT_TOKEN: '' });
  assert.equal(loopback.requiresToken, false);
  assert.equal(loopback.port, 8092, 'порт по умолчанию');

  const open = updateAgentConfig({ UPDATE_AGENT_HOST: '0.0.0.0', UPDATE_AGENT_TOKEN: '' });
  assert.equal(open.requiresToken, true);

  const badPort = updateAgentConfig({ UPDATE_AGENT_PORT: 'not-a-port' });
  assert.equal(badPort.port, 8092, 'мусор в переменной не роняет апдейтер');

  const script = updateAgentConfig({ PROJECT_DIR: '/srv/app' });
  assert.equal(script.script, join('/srv/app', 'deploy', 'update-project.sh'));
  assert.equal(script.applyMigrations, true, 'миграции по умолчанию применяются');
  assert.equal(updateAgentConfig({ UPDATE_APPLY_MIGRATIONS: '0' }).applyMigrations, false);
});

test('http contract: здоровье открыто, остальное — под токеном', async (t) => {
  const config = testConfig();
  const server = createUpdateServer({ config, manager: createUpdateManager(config) });
  const port = await listen(server);
  const origin = 'http://127.0.0.1:' + port;
  t.after(() => new Promise((done) => server.close(done)));

  const health = await fetch(origin + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, active: false });

  for (const path of ['/status', '/status?full=1']) {
    const denied = await fetch(origin + path);
    assert.equal(denied.status, 401, path + ' без токена закрыт');
    assert.equal(JSON.stringify(await denied.json()).includes(TOKEN), false, 'тело ответа ничего не выдаёт');
  }
  const wrongToken = await fetch(origin + '/status', { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrongToken.status, 401);

  // Неизвестный путь под токеном — 404; без токена — всегда 401, чтобы
  // опросом нельзя было разведывать, какие эндпоинты существуют.
  assert.equal((await fetch(origin + '/nope', { headers: { Authorization: 'Bearer ' + TOKEN } })).status, 404);
  assert.equal((await fetch(origin + '/nope')).status, 401);
  assert.equal((await fetch(origin + '/update', { method: 'POST' })).status, 401, 'запуск без токена невозможен');
});

test('http contract: прогресс обновления доживает до панели и не пачкается секретами', { skip: needsBash }, async (t) => {
  const config = testConfig();
  const toSha = 'b'.repeat(40);
  writeFileSync(config.script, [
    '#!/usr/bin/env bash',
    'echo "шаг: docker compose build"',
    'printf ' + JSON.stringify(UPDATE_PROTOCOL + '{"stage":"fetch","percent":15,"message":"git fetch"}') + '; echo',
    'sleep 0.2',
    'printf ' + JSON.stringify(UPDATE_PROTOCOL + '{"stage":"build","percent":55,"migrationsApplied":2,"toSha":"' + toSha + '"}') + '; echo',
    'echo "UPDATE_AGENT_TOKEN=' + TOKEN + '"',
    'sleep 0.2',
    'printf ' + JSON.stringify(UPDATE_PROTOCOL + '{"stage":"done","percent":100}') + '; echo',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const manager = createUpdateManager(config);
  const server = createUpdateServer({ config, manager });
  const port = await listen(server);
  const origin = 'http://127.0.0.1:' + port;
  const auth = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  t.after(() => new Promise((done) => server.close(done)));

  const start = await fetch(origin + '/update', { method: 'POST', headers: auth, body: JSON.stringify({ applyMigrations: true }) });
  assert.equal(start.status, 202);
  assert.equal((await start.json()).ok, true);

  const busy = await fetch(origin + '/update', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(busy.status, 409, 'второе обновление не запускается параллельно');
  assert.equal((await busy.json()).reason, 'already-running');

  const full = await fetch(origin + '/status?full=1', { headers: auth });
  const payload = await full.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.update.active, true);
  // Гонка по своей природе: пока идёт HTTP-запрос, скрипт-заглушка успевает
  // уйти на следующую стадию. Проверяем не конкретное имя, а что стадия —
  // из известного словаря и процент ей соответствует.
  const stageIds = UPDATE_STAGES.map((item) => item.id);
  assert.ok(stageIds.includes(payload.update.stage), 'стадия из словаря: ' + payload.update.stage);
  const expected = UPDATE_STAGES.find((item) => item.id === payload.update.stage);
  assert.ok(payload.public.percent >= Math.min(15, expected.percent), 'процент не отстаёт от стадии');

  assert.equal(await waitFor(() => !manager.isBusy()), true, 'апдейт должен завершиться');

  const done = (await (await fetch(origin + '/status?full=1', { headers: auth })).json()).update;
  assert.equal(done.state, 'succeeded');
  assert.equal(done.percent, 100);
  assert.equal(done.migrationsApplied, 2);
  assert.equal(done.toSha, toSha);
  assert.equal(done.log.some((line) => line.line.includes('docker compose build')), true);
  assert.equal(JSON.stringify(done).includes(TOKEN), false, 'токен из вывода скрыт даже в полном состоянии');

  // Публичный ответ после завершения обязан «отлипнуть» — иначе вся витрина
  // вечно показывает System Update.
  const publicView = (await (await fetch(origin + '/status', { headers: auth })).json()).public;
  assert.equal(publicView.active, false);
  assert.equal(publicView.state, 'idle');

  // Состояние на диске — ради переживания рестарта контейнера сайта.
  const persisted = JSON.parse(readFileSync(config.stateFile, 'utf8'));
  assert.equal(persisted.state, 'succeeded');
  assert.equal(persisted.percent, 100);
  const logFile = readFileSync(config.logFile, 'utf8');
  assert.equal(logFile.includes(TOKEN), false);
  assert.match(logFile, /docker compose build/);
});

test('abort: остановка по-человечески помечает состояние и не оставляет running', { skip: needsBash }, async (t) => {
  const config = testConfig();
  writeFileSync(config.script, ['#!/usr/bin/env bash', 'printf ' + JSON.stringify(UPDATE_PROTOCOL + '{"stage":"build","percent":55}') + '; echo', 'sleep 30', ''].join('\n'), { mode: 0o755 });
  const manager = createUpdateManager(config);
  const server = createUpdateServer({ config, manager });
  const port = await listen(server);
  const auth = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  t.after(async () => {
    manager.stop();
    await new Promise((done) => server.close(done));
  });

  const start = await fetch('http://127.0.0.1:' + port + '/update', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(start.status, 202);
  assert.equal(manager.isBusy(), true);

  const abort = await fetch('http://127.0.0.1:' + port + '/abort', { method: 'POST', headers: auth });
  assert.equal(abort.status, 202);
  assert.equal((await abort.json()).update.state, 'aborted');

  assert.equal(await waitFor(() => !manager.isBusy()), true);
  assert.equal(manager.status().state, 'aborted');
  // Повторная остановка — не ошибка, а «нечего останавливать».
  assert.equal((await fetch('http://127.0.0.1:' + port + '/abort', { method: 'POST', headers: auth })).status, 409);
});

test('crashed updater does not stick the panel in running state', () => {
  // Таймаут задан явно: тест проверяет саму логику «running без процесса
  // старше лимита → failed» и не зависит от дефолта UPDATE_TIMEOUT_MINUTES.
  const config = testConfig({ UPDATE_TIMEOUT_MINUTES: '45' });
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(config.stateFile, JSON.stringify({
    version: 1,
    state: 'running',
    stage: 'build',
    percent: 60,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    log: [],
  }));
  const manager = createUpdateManager(config);
  const status = manager.status();
  assert.equal(status.state, 'failed', 'почасовой running без процесса — следствие рестарта хоста');
  assert.match(status.error, /перезагружался/);
  assert.equal(manager.isBusy(), false, 'кнопка снова активна');
  assert.equal(existsSync(config.stateFile), true);
});

/* ── 3. shell-скрипт обновления ──────────────────────────────────── */

test('deploy/update-project.sh: синтаксис и полный набор стадий', { skip: needsBash }, () => {
  const file = join(ROOT, 'deploy', 'update-project.sh');
  const check = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  assert.equal(check.status, 0, 'bash -n: ' + check.stderr);

  const source = readFileSync(file, 'utf8');
  // Обязательные стадии: панель рисует по ним чек-лист, шапка — прогресс.
  for (const stage of UPDATE_STAGES.map((item) => item.id)) {
    assert.match(source, new RegExp(UPDATE_PROTOCOL + '\\{"stage":"' + stage + '"|report ' + stage + ' '),
      'скрипт должен сообщать о стадии ' + stage);
  }
  assert.match(source, /set -euo pipefail/);
  assert.match(source, /trap 'fail/);
  // Ошибка пишется в stdout: менеджер читает прогресс именно оттуда.
  assert.match(source, /die\(\)\s*\{[^}]*::edrc::/s);
  assert.match(source, /git stash push/);
  assert.match(source, /git merge --ff-only/);
  assert.match(source, /UPDATE_APPLY_MIGRATIONS/);
  assert.match(source, /migrations\.mark/, 'применённые миграции запоминаются, а не применяются по кругу');
  assert.match(source, /pg_dump/, 'перед миграциями обязана быть резервная копия');
  assert.match(source, /--diff-filter=A .* -- supabase\/migrations/);
  assert.match(source, /PROJECT_DEPLOY_MODE/);
  assert.match(source, /detect_mode/, 'режим (compose или systemd) определяется сам');
});

test('deploy scripts: синтаксис всех скриптов обновления и мониторинга', { skip: needsBash }, () => {
  for (const file of [
    'deploy/update-project.sh',
    'deploy/apply-env.sh',
    'deploy/db-backup.sh',
    'deploy/start-update-agent.sh',
    'deploy/start-monitoring.sh',
    'deploy/monitoring-setup.sh',
    'deploy/prepare-standalone.sh',
    'deploy/rebuild-now.sh',
    'deploy/start-docker.sh',
  ]) {
    const check = spawnSync('bash', ['-n', join(ROOT, file)], { encoding: 'utf8' });
    assert.equal(check.status, 0, file + ': ' + check.stderr);
  }
});

test('apply-env.sh: стадии ENV_STAGES, режим определяется сам, секреты не светятся', { skip: needsBash }, () => {
  const source = readFileSync(join(ROOT, 'deploy', 'apply-env.sh'), 'utf8');
  assert.match(source, /set -euo pipefail/);
  // Панель рисует чек-лист по этим стадиям — скрипт обязан их сообщать
  // (финальная «done» — тем же raw-printf, как в update-project.sh).
  for (const stage of ENV_STAGES) {
    const pattern = stage.id === 'done' ? /"stage":"done"/ : new RegExp('report ' + stage.id + ' ');
    assert.match(source, pattern, 'сообщает о стадии ' + stage.id);
  }
  assert.match(source, /docker-compose\.yml/, 'режим compose определяется по compose-файлу');
  assert.match(source, /-f docker-compose\.yml/, 'пересоздание сервисов явно включает базовый docker-compose.yml');
  assert.match(source, /systemctl restart/, 'systemd-режим тоже поддерживается');
  assert.match(source, /force-recreate/, 'ключи применяются пересозданием сервисов, не пересборкой');
});

test('apply-env.sh: живое пересоздание сервисов передаёт базовый compose-файл и сеть Supabase без падения', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-apply-env-'));
  const deployDir = join(dir, 'deploy');
  const binDir = join(dir, 'bin');
  mkdirSync(deployDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  copyFileSync(join(ROOT, 'deploy', 'apply-env.sh'), join(deployDir, 'apply-env.sh'));
  copyFileSync(join(ROOT, 'deploy', 'compose-lib.sh'), join(deployDir, 'compose-lib.sh'));
  copyFileSync(join(ROOT, 'deploy', 'compose.supabase-net.yml'), join(deployDir, 'compose.supabase-net.yml'));
  writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  web:\n    image: test\n');
  const envFile = join(dir, '.env.production');
  writeFileSync(envFile, 'SUPABASE_NETWORK=test-supa-net\n');

  const logFile = join(dir, 'docker.log');
  writeFileSync(join(binDir, 'docker'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = "compose" ]; then',
    '  shift',
    `  echo "[docker-compose] $*" >> "${logFile}"`,
    '  exit 0',
    'fi',
    'if [ "$1" = "info" ]; then exit 0; fi',
    'if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then exit 0; fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  writeFileSync(join(binDir, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const run = spawnSync('bash', [join(deployDir, 'apply-env.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      PROJECT_DIR: dir,
      ENV_FILE: envFile,
      PROJECT_DEPLOY_MODE: 'compose',
    },
  });

  assert.equal(run.status, 0, `apply-env.sh failed: ${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /"stage":"done","percent":100/);
  assert.match(run.stdout, /ПРИМЕНЕНИЕ КЛЮЧЕЙ ЗАВЕРШЕНО/);

  const log = readFileSync(logFile, 'utf8');
  assert.match(log, /-f docker-compose\.yml -f deploy\/compose\.supabase-net\.yml/, 'оба файла переданы в правильном порядке');
  assert.match(log, /up -d --force-recreate web/);
});

test('docker-compose.yml: порты сервиса web параметризованы через PORT_BIND с безопасным дефолтом', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /\$\{PORT_BIND:-127\.0\.0\.1:\$\{PORT:-3000\}:3000\}/, 'порт web по умолчанию 127.0.0.1:3000:3000, настраивается через PORT_BIND');
});

test('ed-ring-colony-docker.service: systemd unit для Docker Compose существует и корректен', () => {
  const service = readFileSync(join(ROOT, 'deploy', 'ed-ring-colony-docker.service'), 'utf8');
  assert.match(service, /ExecStart=.*start-docker\.sh/, 'запускает start-docker.sh');
  assert.match(service, /ExecStop=.*start-docker\.sh --stop/, 'останавливает через --stop');
  assert.match(service, /ExecReload=.*start-docker\.sh --restart/, 'перезапускает через --restart');
});

test('start-docker.sh: запуск со стабом docker передаёт -f docker-compose.yml, сеть Supabase и проверяет health', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-start-docker-'));
  const deployDir = join(dir, 'deploy');
  const binDir = join(dir, 'bin');
  mkdirSync(deployDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  copyFileSync(join(ROOT, 'deploy', 'start-docker.sh'), join(deployDir, 'start-docker.sh'));
  copyFileSync(join(ROOT, 'deploy', 'compose-lib.sh'), join(deployDir, 'compose-lib.sh'));
  copyFileSync(join(ROOT, 'deploy', 'compose.supabase-net.yml'), join(deployDir, 'compose.supabase-net.yml'));
  writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  web:\n    image: test\n');
  const envFile = join(dir, '.env.production');
  writeFileSync(envFile, 'SUPABASE_NETWORK=test-supa-net\nPORT_BIND=127.0.0.1:3000:3000\n');

  const logFile = join(dir, 'docker.log');
  writeFileSync(join(binDir, 'docker'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = "compose" ]; then',
    '  shift',
    `  echo "[docker-compose] $*" >> "${logFile}"`,
    '  if [ "$1" = "config" ]; then exit 0; fi',
    '  if [ "$1" = "ps" ]; then echo "NAME   IMAGE   COMMAND   SERVICE   STATUS   PORTS"; exit 0; fi',
    '  exit 0',
    'fi',
    'if [ "$1" = "info" ]; then exit 0; fi',
    'if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then exit 0; fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  writeFileSync(join(binDir, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const run = spawnSync('bash', [join(deployDir, 'start-docker.sh'), '--restart'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      REPO_ROOT: dir,
      ENV_FILE: envFile,
    },
  });

  assert.equal(run.status, 0, `start-docker.sh failed: ${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Принудительное пересоздание сервисов \(восстановление портов\)/);
  assert.match(run.stdout, /Сайт успешно отвечает/);

  const log = readFileSync(logFile, 'utf8');
  assert.match(log, /-f .*docker-compose\.yml -f .*deploy\/compose\.supabase-net\.yml/, 'базовый compose и сеть переданы');
  assert.match(log, /up -d --force-recreate web jobs/, 'сервисы пересозданы с force-recreate');
});

test('обрамление: update-agent получил apply-env.sh, monitor-agent — pg, compose — MONITOR_DB_URL', () => {
  const updateDockerfile = readFileSync(join(ROOT, 'deploy', 'Dockerfile.update-agent'), 'utf8');
  assert.match(updateDockerfile, /COPY deploy\/apply-env\.sh/, 'скрипт применения ключей внутри образа апдейтера');
  const monitorDockerfile = readFileSync(join(ROOT, 'deploy', 'Dockerfile.monitor'), 'utf8');
  assert.match(monitorDockerfile, /npm i .*pg/, 'monitor-agent умеет мерить размер БД');
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /MONITOR_DB_URL/, 'compose передаёт агенту URL базы');
  const startMonitoring = readFileSync(join(ROOT, 'deploy', 'start-monitoring.sh'), 'utf8');
  assert.match(startMonitoring, /MONITOR_DB_URL/, 'скрипт запуска зеркалирует URL из DATABASE_URL/SUPABASE_DB_URL');
});

test('start-update-agent.sh: идемпотентная запись ключей и ничего лишнего в выводе', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-update-keys-'));
  const envFile = join(dir, '.env.production');
  writeFileSync(envFile, 'SUPABASE_SERVICE_ROLE_KEY=service-key-must-stay\n');

  const run = (args) => spawnSync('bash', [join(ROOT, 'deploy', 'start-update-agent.sh'), '--keys-only', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: process.env.PATH },
  });

  const first = run(['--env-file', envFile]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const env = readFileSync(envFile, 'utf8');
  assert.match(env, /^UPDATE_AGENT_TOKEN=[a-f0-9]{64}$/m, 'отдельный 256-битный ключ');
  assert.match(env, /^PROJECT_UPDATE_BRANCH=main$/m);
  assert.match(env, /^UPDATE_APPLY_MIGRATIONS=1$/m);
  assert.match(env, /^UPDATE_AGENT_URL=http:\/\/127\.0\.0\.1:8092$/m, 'keys-only без Docker-проекта = хостовый режим');
  assert.match(env, /SUPABASE_SERVICE_ROLE_KEY=service-key-must-stay/, 'существующие ключи не трогаются');

  const token = /^UPDATE_AGENT_TOKEN=(.*)$/m.exec(env)[1];
  assert.equal(first.stdout.includes(token), false, 'токен не попадает в вывод');

  // Повторный запуск ничего не меняет, явное значение оператора сохраняется.
  const second = run(['--env-file', envFile]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(envFile, 'utf8').match(/^UPDATE_AGENT_TOKEN=(.*)$/m)[1], token);
  assert.equal(run(['--env-file', envFile, '--no-migrations']).status, 0);
  assert.match(readFileSync(envFile, 'utf8'), /^UPDATE_APPLY_MIGRATIONS=0$/m);

  // Файл с секретами получает права 600.
  assert.equal(statSync(envFile).mode & 0o077, 0, 'окружение прод-сайта не должно быть общедоступным');
});

/* ── 4. публичный статус и панель ────────────────────────────────── */

test('шапка сайта: метка статуса вынесена в компонент и не зависит от правки вручную', () => {
  const layout = readFileSync(join(ROOT, 'src', 'app', 'layout.tsx'), 'utf8');
  const bar = readFileSync(join(ROOT, 'src', 'components', 'SiteStatusBar.tsx'), 'utf8');
  const api = readFileSync(join(ROOT, 'src', 'app', 'api', 'status', 'route.ts'), 'utf8');

  assert.match(layout, /<SiteStatusBar/);
  assert.equal(/System Online/.test(layout), false, 'жёсткая метка в layout больше не нужна');

  assert.match(bar, /'\/api\/status'/);
  assert.match(bar, /System Update/);
  assert.match(bar, /System Online/);
  assert.match(bar, /update-strip/, 'полоса прогресса под шапкой — часть того же контракта');
  assert.match(bar, /document\.visibilityState/, 'фоновые вкладки не должны долбить статус');
  assert.equal(bar.includes('admin'), false, 'публичный компонент не знает про админские данные');

  assert.match(api, /status\.public/, 'наружу уходит только публичная проекция');
  assert.equal(/\.log\b|full=1/.test(api), false, 'журнал апдейтера в публичном роуте появляться не должен');
  assert.match(api, /system: 'online'/, 'неизвестный статус = online, сайт не должен пугать');
});

test('панель мониторинга: диск, контент и обновление — всё в одном экране', () => {
  const tab = readFileSync(join(ROOT, 'src', 'components', 'Admin', 'ServerMonitorTab.tsx'), 'utf8');
  assert.match(tab, /pg_database_size|disk|Диск/i);
  assert.match(tab, /\/api\/admin\/monitor\/update/);
  assert.match(tab, /UPDATE_STAGES/);
  assert.match(tab, /applyMigrations/);
  assert.match(tab, /\/api\/admin\/content\?action=/, 'синхронизация Galnet и добивка переводов — кнопками');
  assert.match(tab, /runContent\('sync'\)/, 'кнопка «Синхронизировать Galnet сейчас»');
  assert.match(tab, /runContent\('translate'\)/, 'кнопка «Перевести недостающее»');
  assert.match(tab, /setInterval|setTimeout/, 'пока идёт сборка, панель опрашивает прогресс');
});

test('доступ: админские эндпоинты проверки и запуска требуют requireAdmin', () => {
  const updateRoute = readFileSync(join(ROOT, 'src', 'app', 'api', 'admin', 'monitor', 'update', 'route.ts'), 'utf8');
  const contentRoute = readFileSync(join(ROOT, 'src', 'app', 'api', 'admin', 'content', 'route.ts'), 'utf8');

  // Каждый экспортированный обработчик (GET/POST/DELETE) обязан быть под
  // проверкой прав — иначе хвост журнала сборки уходит анонимному посетителю.
  const handlers = [...updateRoute.matchAll(/export async function (GET|POST|DELETE)\(([^)]*)\)/g)];
  assert.ok(handlers.length >= 3, 'в роуте должны быть GET, POST и DELETE');
  for (const [, method, params] of handlers) {
    const start = updateRoute.indexOf('export async function ' + method);
    const body = updateRoute.slice(start, start + 900);
    assert.match(body, /requireAdmin\(/, method + ' обязан проверять права');
    assert.match(params, /request: Request/, method + ' должен получать запрос целиком, а не пустой аргумент');
  }
  assert.match(contentRoute, /requireAdmin\(/);
  assert.match(updateRoute, /confirm !== true/, 'запуск обновления — только с явным подтверждением');
});

test('контракт клиента: «Обновить сейчас» ходит в агента по POST /update, а не /start', () => {
  // История дефекта: клиент шёл в POST /start, такого пути в роутере
  // агента нет, и кнопка в панели отвечала «ошибка 404». Контракт агента —
  // POST /update (шапка scripts/update-agent.mjs и тесты выше зафиксированы).
  const client = readFileSync(join(ROOT, 'src', 'lib', 'updateAgent.ts'), 'utf8');
  const updateRoute = readFileSync(join(ROOT, 'src', 'app', 'api', 'admin', 'monitor', 'update', 'route.ts'), 'utf8');
  assert.match(updateRoute, /callUpdateAgent\(\s*'start'/, 'кнопка запуска идёт через тот же клиент');

  const mapping = /start:\s*'([^']+)'/m.exec(client);
  assert.ok(mapping, 'клиент обязан маппить действие на путь агента');
  assert.equal(mapping[1], 'update', 'запуск обновления = POST /update; /start агент отвечает 404');
});

test('контракт агента: POST /start — 404, а путь клиента запускает обновление', { skip: needsBash }, async (t) => {
  // Живая проверка обеих сторон: если кто-то снова «исправит» одну сторону
  // вразрез с другой, тест упадёт раньше прод-инцидента.
  const client = readFileSync(join(ROOT, 'src', 'lib', 'updateAgent.ts'), 'utf8');
  const path = /start:\s*'([^']+)'/m.exec(client)?.[1];
  assert.ok(path, 'путь клиента не найден — сначала прогоните тест контракта клиента');

  const config = testConfig();
  writeFileSync(config.script, ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'), { mode: 0o755 });
  const manager = createUpdateManager(config);
  const server = createUpdateServer({ config, manager });
  const port = await listen(server);
  const origin = 'http://127.0.0.1:' + port;
  const auth = { Authorization: 'Bearer ' + TOKEN };
  t.after(async () => {
    manager.stop();
    await new Promise((done) => server.close(done));
  });

  assert.equal((await fetch(origin + '/start', { method: 'POST', headers: auth, body: '{}' })).status, 404,
    'агент не знает /start — с таким путём кнопка отдаст посетителю 404');
  const started = await fetch(origin + '/' + path, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(started.status, 202, `POST /${path} (путь клиента) должен запускать обновление`);
  assert.equal(await waitFor(() => !manager.isBusy()), true);
});

test('compose: веб-контейнер не получает ни git, ни Docker-сокет', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const block = (name) => {
    const from = compose.indexOf('  ' + name + ':');
    const rest = compose.slice(from + 1);
    const end = rest.search(/\n {2}[a-z][a-z-]*:/);
    return end < 0 ? rest : rest.slice(0, end);
  };

  const web = block('web');
  assert.ok(web.length > 0);
  assert.equal(web.includes('/var/run/docker.sock'), false, 'веб-контейнер не видит Docker-сокет');
  assert.match(web, /UPDATE_AGENT_URL/);
  assert.match(web, /UPDATE_AGENT_TOKEN/);
  assert.match(web, /host\.docker\.internal:host-gateway/, 'нужно для хостового апдейтера в systemd-режиме');

  // Мониторингу сокет дан только на чтение, апдейтеру — на запись: он им
  // пересобирает стек. Оба — под профилем monitoring и без публичных портов.
  assert.match(block('monitor-agent'), /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
  const updater = block('update-agent');
  assert.match(updater, /profiles: \["monitoring"\]/, 'апдейтер поднимается опциональным профилем');
  assert.match(updater, /UPDATE_AGENT_TOKEN/);
  assert.match(updater, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.equal(/ports:/.test(updater), false, 'у апдейтера не должно быть проброшенного порта');
});

test('env keys: masking, create/update, delete, validation, permissions 600', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-update-env-'));
  const envFile = join(dir, '.env.production');
  writeFileSync(envFile, [
    '# production keys',
    'CRON_SECRET=existing-secret-123',
    'YANDEX_TRANSLATE_API_KEY=old-key-value-abc',
  ].join('\n'));
  const config = testConfig({
    PROJECT_DIR: dir,
    UPDATE_STATE_DIR: join(dir, 'state'),
    ENV_FILE: envFile,
    APPLY_ENV_SCRIPT: join(dir, 'deploy', 'apply-env.sh'),
  });
  const server = createUpdateServer({ config, manager: createUpdateManager(config) });
  const port = await listen(server);
  const origin = 'http://127.0.0.1:' + port;
  const auth = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal((await fetch(origin + '/env')).status, 401, 'no token, no keys');

  const listed = await (await fetch(origin + '/env', { headers: auth })).json();
  assert.equal(listed.ok, true);
  assert.equal(listed.configured, true);
  assert.deepEqual(listed.keys.map((k) => k.name).sort(), ['CRON_SECRET', 'YANDEX_TRANSLATE_API_KEY']);
  assert.equal(JSON.stringify(listed).includes('existing-secret-123'), false, 'raw values do not leak');
  assert.equal(JSON.stringify(listed).includes('old-key-value-abc'), false, 'raw values do not leak');

  const added = await fetch(origin + '/env', { method: 'POST', headers: auth, body: JSON.stringify({ key: 'NEW_KEY', value: 'brand-new-value-xyz' }) });
  assert.equal(added.status, 201);
  const addedBody = await added.json();
  assert.equal(addedBody.created, true);
  assert.equal(JSON.stringify(addedBody).includes('brand-new-value-xyz'), false, 'response has only the mask');

  const updated = await fetch(origin + '/env', { method: 'POST', headers: auth, body: JSON.stringify({ key: 'YANDEX_TRANSLATE_API_KEY', value: 'new-key-456' }) });
  assert.equal(updated.status, 200);

  const disk = readFileSync(envFile, 'utf8');
  assert.match(disk, /^YANDEX_TRANSLATE_API_KEY=new-key-456$/m);
  assert.match(disk, /^NEW_KEY=brand-new-value-xyz$/m);
  assert.match(disk, /^CRON_SECRET=existing-secret-123$/m, 'other keys are not touched');
  assert.equal((disk.match(/^YANDEX_TRANSLATE_API_KEY=/gm) || []).length, 1, 'no duplicate keys after update');
  assert.equal(statSync(envFile).mode & 0o077, 0, 'env file keeps 600 permissions');

  const badName = await fetch(origin + '/env', { method: 'POST', headers: auth, body: JSON.stringify({ key: 'bad-key', value: 'x' }) });
  assert.equal(badName.status, 400, 'lowercase names are not allowed');
  const badValue = await fetch(origin + '/env', { method: 'POST', headers: auth, body: JSON.stringify({ key: 'BAD_VALUE', value: 'line1\nline2' }) });
  assert.equal(badValue.status, 400, 'multi-line values are not allowed');

  const removed = await fetch(origin + '/env?key=NEW_KEY', { method: 'DELETE', headers: auth });
  assert.equal(removed.status, 200);
  assert.equal(readFileSync(envFile, 'utf8').includes('NEW_KEY'), false);
  assert.equal((await fetch(origin + '/env?key=NEW_KEY', { method: 'DELETE', headers: auth })).status, 404, 'double delete — 404');
});

test('env apply: job runs deploy/apply-env.sh in the same slot (kind=env)', { skip: needsBash }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-update-envapply-'));
  const scriptPath = join(dir, 'deploy', 'apply-env.sh');
  mkdirSync(dirname(scriptPath), { recursive: true });
  const proto = (obj) => UPDATE_PROTOCOL + JSON.stringify(obj);
  writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    `echo '${proto({ stage: 'env_prepare', percent: 10 })}'`,
    'sleep 0.2',
    `echo '${proto({ stage: 'env_switch', percent: 40, message: 'recreating services' })}'`,
    `echo '${proto({ stage: 'done', percent: 100 })}'`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const config = testConfig({
    PROJECT_DIR: dir,
    UPDATE_STATE_DIR: join(dir, 'state'),
    ENV_FILE: join(dir, '.env.production'),
    APPLY_ENV_SCRIPT: scriptPath,
  });
  const manager = createUpdateManager(config);
  const server = createUpdateServer({ config, manager });
  const port = await listen(server);
  const origin = 'http://127.0.0.1:' + port;
  const auth = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  t.after(async () => { manager.stop(); await new Promise((resolve) => server.close(resolve)); });

  const started = await fetch(origin + '/env/apply', { method: 'POST', headers: auth, body: JSON.stringify({ scope: 'web' }) });
  assert.equal(started.status, 202);
  const body = await started.json();
  assert.equal(body.update.kind, 'env', 'the panel needs to know that keys are being applied, not an update');
  assert.equal(body.update.mode, 'web');

  const busy = await fetch(origin + '/env/apply', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(busy.status, 409, 'the update slot is occupied — nothing else can be done in parallel');

  assert.equal(await waitFor(() => !manager.isBusy()), true);
  const done = manager.status();
  assert.equal(done.state, 'succeeded');
  assert.equal(done.kind, 'env');
  assert.equal(done.percent, 100);
  assert.equal(done.stage, 'done');
  assert.match(done.message, /recreating/, 'stages from the script make it into the protocol');
});

test('web routes: /api/admin/env requires requireAdmin, client goes through the agent', () => {
  const route = readFileSync(join(ROOT, 'src', 'app', 'api', 'admin', 'env', 'route.ts'), 'utf8');
  const applyRoute = readFileSync(join(ROOT, 'src', 'app', 'api', 'admin', 'env', 'apply', 'route.ts'), 'utf8');
  const tab = readFileSync(join(ROOT, 'src', 'components', 'Admin', 'ServerMonitorTab.tsx'), 'utf8');
  const client = readFileSync(join(ROOT, 'src', 'lib', 'updateAgent.ts'), 'utf8');

  for (const method of ['GET', 'POST', 'DELETE']) {
    const start = route.indexOf('export async function ' + method);
    assert.ok(start >= 0, 'route ' + method + ' exists');
    assert.match(route.slice(start, start + 400), /requireAdmin\(/, method + ' requires admin rights');
  }
  assert.match(applyRoute, /requireAdmin\(/, 'applying keys also requires admin rights');
  assert.match(client, /'GET', '\/env'/, 'client reads keys from the agent');
  assert.match(client, /'POST', '\/env\/apply'/, 'application goes through the agent, not from the web container');
  assert.match(tab, /\/api\/admin\/env/, 'panel goes through the admin route');
  assert.match(tab, /ENV_STAGES/, 'application of keys displays its own stage dictionary');
});
