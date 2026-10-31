/**
 * Supabase Storage: проверка и перезапуск из панели (Админка → Мониторинг).
 *
 * Storage — отдельный стек, который обновление проекта не трогает. Падение его
 * контейнера сайт не роняет: молча перестают приниматься аватары, логотипы
 * эскадрилий и документы. Поэтому проверяем три слоя, которые ломаются
 * по-разному:
 *   1. `deploy/storage-repair.sh` — shell: синтаксис, совпадение этапов с
 *      STORAGE_STAGES, вердикт по состоянию контейнера и ответу API (на
 *      подставном docker, без реального сервера);
 *   2. агент — GET /storage (только чтение) и POST /storage/restart (job
 *      kind=storage в общем слоте, 409 при занятом слоте);
 *   3. сторож — не трогает живой Storage, не лечит отказ ключа и не уходит в
 *      бесконечный цикл перезапусков.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STORAGE_STAGES,
  UPDATE_PROTOCOL,
  sanitizeUpdateState,
} from '../lib/update-state.mjs';
import {
  createStorageWatchdog,
  createUpdateManager,
  createUpdateServer,
  parseStorageReport,
  sanitizeStorageReport,
  storageWatchdogConfig,
  updateAgentConfig,
} from '../update-agent.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy', 'storage-repair.sh');
const TOKEN = 'storage-test-token-not-a-real-secret';

// `npm test` выполняется и внутри node:22-alpine на шаге Docker build, где bash
// нет. Там shell-часть пропускается, а не валит сборку.
const needsBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
  ? false
  : 'bash is not available in this image';

const proto = (obj) => UPDATE_PROTOCOL + JSON.stringify(obj);

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
}

/**
 * Подставной docker: отвечает ровно тем, что задаёт тест.
 * FAKE_STATE — строка inspect (`status|health|restarts|exit|oom|started`),
 * FAKE_API — код ответа API внутри контейнера, FAKE_RESTART_FAIL=1 — отказ.
 */
function fakeDocker() {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-fake-docker-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'docker');
  writeFileSync(file, `#!/usr/bin/env bash
log="\${FAKE_LOG:-/dev/null}"
printf '%s\\n' "$*" >> "$log"
case "$1" in
  info) exit 0 ;;
  ps)
    case "$*" in
      *"name=^/supabase-storage$"*) [ "\${FAKE_MISSING:-0}" = 1 ] || printf 'abc123\\n' ;;
      *"com.docker.compose.service=storage"*) [ "\${FAKE_MISSING:-0}" = 1 ] || printf 'abc123\\n' ;;
      *"name=^/supabase-db$"*) printf 'db999\\n' ;;
    esac
    exit 0 ;;
  inspect)
    case "$*" in
      *supabase-db*) printf 'supabase\\n' ;;
      *) printf '%s\\n' "\${FAKE_STATE:-running|healthy|0|0|false|2026-10-31T10:00:00Z}" ;;
    esac
    exit 0 ;;
  exec) printf '%s\\n' "\${FAKE_API:-200}"; exit 0 ;;
  restart) [ "\${FAKE_RESTART_FAIL:-0}" = 1 ] && exit 1; exit 0 ;;
  logs) printf 'storage-api listening on 5000\\nDATABASE_URL=postgres://storage_admin:secret@db:5432/postgres\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  return bin;
}

function runScript(args, env = {}) {
  const bin = fakeDocker();
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      // Сеть агента в тесте не участвует: проверка API идёт изнутри контейнера.
      STORAGE_INTERNAL_URL: '',
      STORAGE_WAIT_SECONDS: '6',
      ...env,
    },
  });
  const report = parseStorageReport(result.stdout ?? '');
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', report };
}

/* ── 1. скрипт ────────────────────────────────────────────────────── */

test('storage-repair.sh: синтаксис и справка', { skip: needsBash }, () => {
  const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  // Неизвестный режим не должен молча начинать перезапуск.
  const wrong = spawnSync('bash', [SCRIPT, '--restart-now'], { encoding: 'utf8' });
  assert.equal(wrong.status, 2);
});

test('storage-repair.sh: этапы совпадают со STORAGE_STAGES', { skip: needsBash }, () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const reported = [...source.matchAll(/^report ([a-z_]+) ([0-9]+) /gm)]
    .map((match) => ({ id: match[1], percent: Number(match[2]) }));
  assert.ok(reported.length > 0, 'скрипт не сообщает о стадиях');
  const known = new Map(STORAGE_STAGES.map((stage) => [stage.id, stage.percent]));
  for (const { id, percent } of reported) {
    assert.ok(known.has(id), `стадия ${id} отсутствует в STORAGE_STAGES`);
    assert.equal(percent, known.get(id), `процент стадии ${id} расходится с STORAGE_STAGES`);
  }
  // Готовность объявляется только в конце: иначе панель показала бы 100% раньше.
  assert.ok(source.includes('::edrc::{"result"'), 'нет итоговой строки для панели');
});

test('storage-repair.sh --check: здоровый Storage — проблема не выдумывается', { skip: needsBash }, () => {
  const { status, report } = runScript(['--check']);
  assert.equal(status, 0);
  assert.ok(report, 'нет отчёта для панели');
  assert.equal(report.problem, false);
  assert.equal(report.restartable, true);
  assert.equal(report.state, 'running');
  assert.equal(report.api, 'ok');
  assert.equal(report.apiVia, 'container', 'проверка идёт изнутри контейнера, а не из сети агента');
});

test('storage-repair.sh --check: упавший контейнер виден как проблема', { skip: needsBash }, () => {
  const oom = runScript(['--check'], { FAKE_STATE: 'exited|none|2|137|true|2026-10-31T10:00:00Z' });
  assert.equal(oom.status, 1);
  assert.equal(oom.report.problem, true);
  assert.equal(oom.report.state, 'exited');
  assert.equal(oom.report.oom, true);
  assert.match(oom.report.reason, /OOM/);

  const missing = runScript(['--check'], { FAKE_MISSING: '1' });
  assert.equal(missing.report.state, 'missing');
  assert.equal(missing.report.problem, true);
});

test('storage-repair.sh --check: отказ ключа — не повод перезапускать', { skip: needsBash }, () => {
  const { status, report } = runScript(['--check'], { FAKE_API: '401' });
  assert.equal(status, 1);
  assert.equal(report.api, 'auth');
  assert.equal(report.problem, true);
  assert.equal(report.restartable, false, 'рестарт не лечит ключ');
  assert.match(report.reason, /SERVICE_ROLE_KEY/);
});

test('storage-repair.sh --restart: лежащий Storage перезапускается, журнал без секретов', { skip: needsBash }, () => {
  const log = join(mkdtempSync(join(tmpdir(), 'edrc-docker-log-')), 'calls.log');
  const { status, stdout } = runScript(['--restart'], {
    FAKE_STATE: 'exited|none|1|137|true|2026-10-31T10:00:00Z',
    FAKE_LOG: log,
  });
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /^restart abc123$/m, 'лежащий сервис должен перезапускаться');
  // Подставной docker всегда возвращает exited, поэтому задача обязана
  // закончиться ошибкой с понятным следующим шагом, а не «готово».
  assert.equal(status, 1);
  assert.match(stdout, /::edrc::\{"error"/);
  assert.match(stdout, /storage-repair|Хранилище/i);
  assert.equal(/secret/.test(stdout), false, 'пароль из журнала Storage не должен попадать в панель');
});

test('storage-repair.sh --restart: живой Storage не трогается', { skip: needsBash }, () => {
  const log = join(mkdtempSync(join(tmpdir(), 'edrc-docker-log-')), 'calls.log');
  const { status, report } = runScript(['--restart'], { FAKE_LOG: log });
  assert.equal(status, 0);
  assert.equal(report.problem, false);
  const calls = readFileSync(log, 'utf8');
  assert.equal(/^restart /m.test(calls), false, 'работающий сервис нельзя перезапускать «на всякий случай»');
});

test('storage-repair.sh: недоступный Docker — честный отказ, а не «всё хорошо»', () => {
  // Docker CLI есть, демона нет (типичный случай: не тот пользователь) —
  // ни «всё работает», ни пустой отчёт.
  const dir = mkdtempSync(join(tmpdir(), 'edrc-no-daemon-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const result = spawnSync('bash', [SCRIPT, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STORAGE_INTERNAL_URL: '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /"problem":true/);
  assert.match(result.stdout, /Docker-демон/);
});

/* ── 2. отчёт и его проекция ──────────────────────────────────────── */

test('parseStorageReport: берётся последний итог, посторонние строки не мешают', () => {
  const stdout = [
    'мусор',
    proto({ stage: 'storage_check', percent: 20 }),
    proto({ result: { state: 'running', problem: false, api: 'ok' } }),
    proto({ result: { state: 'exited', problem: true, api: 'unknown' } }),
  ].join('\n');
  assert.equal(parseStorageReport(stdout).state, 'exited');
  assert.equal(parseStorageReport('только текст'), null);
});

test('sanitizeStorageReport: allowlist и никаких лишних полей', () => {
  const report = sanitizeStorageReport({
    ok: true,
    problem: true,
    restartable: false,
    state: 'что-то своё',
    health: 'healthy',
    restarts: '7',
    exitCode: 999,
    oom: true,
    api: 'ok',
    apiVia: 'agent',
    apiCode: '200',
    reason: 'DATABASE_URL=postgres://u:p@db:5432/postgres',
    secret: 'SERVICE_ROLE_KEY=...',
  });
  assert.deepEqual(Object.keys(report).sort(), [
    'api', 'apiCode', 'apiVia', 'exitCode', 'health', 'ok', 'oom', 'problem', 'reason', 'restartable', 'restarts', 'state',
  ]);
  assert.equal(report.state, 'unknown', 'неизвестное состояние не пробрасывается как есть');
  assert.equal(report.exitCode, 255, 'код выхода ограничен диапазоном');
  assert.equal(report.oom, true);
  assert.equal(sanitizeStorageReport({ oom: 'yes' }).oom, false, 'строка не считается признаком OOM');
  assert.equal(report.restartable, false);
  assert.equal(/p@db/.test(report.reason), false, 'пароль из строки причины скрыт');
  assert.equal(sanitizeStorageReport(null), null);
});

test('sanitizeUpdateState: kind=storage и этапы Storage_STAGES', () => {
  const state = sanitizeUpdateState({ state: 'running', kind: 'storage', stage: 'storage_check', percent: 20 });
  assert.equal(state.kind, 'storage');
  assert.equal(state.stageLabel, 'Проверка состояния Storage и ответа API');
  assert.equal(state.active, true);
  // Неизвестный kind не должен притворяться Storage.
  assert.equal(sanitizeUpdateState({ kind: 'evil', state: 'running' }).kind, 'update');
});

/* ── 3. агент ─────────────────────────────────────────────────────── */

function agentConfig(dir, overrides = {}) {
  return updateAgentConfig({
    UPDATE_AGENT_HOST: '127.0.0.1',
    UPDATE_AGENT_TOKEN: TOKEN,
    PROJECT_DIR: dir,
    UPDATE_STATE_DIR: join(dir, 'state'),
    UPDATE_SCRIPT: join(dir, 'no-update.sh'),
    ...overrides,
  });
}

test('GET /storage: отчёт скрипта уходит в панель очищенным', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-storage-get-'));
  const script = join(dir, 'storage-repair.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'echo "контейнер: supabase-storage"',
    `echo '${proto({ result: { ok: false, problem: true, restartable: true, state: 'exited', health: 'none', restarts: 2, exitCode: 137, oom: true, api: 'unknown', apiVia: 'none', apiCode: '000', reason: 'контейнер остановлен (код 137)' } })}'`,
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });

  const config = agentConfig(dir, { STORAGE_REPAIR_SCRIPT: script });
  const server = createUpdateServer({ config, manager: createUpdateManager(config) });
  const port = await listen(server);
  t.after(() => server.close());

  const auth = { Authorization: `Bearer ${TOKEN}` };
  assert.equal((await fetch(`http://127.0.0.1:${port}/storage`)).status, 401, 'без токена — 401');

  const response = await fetch(`http://127.0.0.1:${port}/storage`, { headers: auth });
  assert.equal(response.status, 200, 'проверка не меняет состояние и не может «упасть» из-за поломки Storage');
  const body = await response.json();
  assert.equal(body.available, true);
  assert.equal(body.report.state, 'exited');
  assert.equal(body.report.oom, true);
  assert.equal(body.busy, false);
  // Подсказка человеку остаётся, но без служебных строк протокола.
  assert.equal(body.detail.some((line) => line.includes('::edrc::')), false);
});

test('GET /storage: нет скрипта в клоне — честная причина, а не «всё плохо»', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-storage-missing-'));
  const config = agentConfig(dir, { STORAGE_REPAIR_SCRIPT: join(dir, 'nope.sh') });
  const server = createUpdateServer({ config, manager: createUpdateManager(config) });
  const port = await listen(server);
  t.after(() => server.close());

  const body = await (await fetch(`http://127.0.0.1:${port}/storage`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(body.available, false);
  assert.match(body.reason, /storage-repair\.sh/);
  assert.equal(body.report, null);
});

test('POST /storage/restart: job kind=storage в общем слоте, повтор — 409', { skip: needsBash }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-storage-restart-'));
  const script = join(dir, 'storage-repair.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    '[[ "${1:-}" == "--restart" ]] || { echo "не тот режим: $*"; exit 3; }',
    `echo '${proto({ stage: 'storage_prepare', percent: 5 })}'`,
    'sleep 0.3',
    `echo '${proto({ stage: 'storage_restart', percent: 45, message: 'restarting storage' })}'`,
    `echo '${proto({ result: { ok: true, problem: false, state: 'running', api: 'ok' } })}'`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  chmodSync(script, 0o755);

  const config = agentConfig(dir, { STORAGE_REPAIR_SCRIPT: script, STORAGE_TIMEOUT_MINUTES: '1' });
  const manager = createUpdateManager(config);
  const server = createUpdateServer({ config, manager });
  const port = await listen(server);
  t.after(() => server.close());

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const started = await fetch(`http://127.0.0.1:${port}/storage/restart`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(started.status, 202);
  const body = await started.json();
  assert.equal(body.update.kind, 'storage', 'панель по kind выбирает STORAGE_STAGES');
  assert.equal(body.update.mode, 'storage');

  const again = await fetch(`http://127.0.0.1:${port}/storage/restart`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(again.status, 409, 'общий слот не даёт перезапуску пересечься с обновлением');

  assert.equal(await waitFor(async () => {
    const status = await (await fetch(`http://127.0.0.1:${port}/status?full=1`, { headers: auth })).json();
    return status.update.active === false && status.update.stage === 'done';
  }), true);
  const status = await (await fetch(`http://127.0.0.1:${port}/status?full=1`, { headers: auth })).json();
  assert.equal(status.update.kind, 'storage');
  assert.equal(status.update.state, 'succeeded');
  assert.equal(status.update.stageLabel, 'Готово');
  // Журнал задачи доступен админу и содержит стадии Storage.
  assert.ok(status.update.log.some((entry) => /storage/i.test(entry.line)));
});

/* ── 4. сторож ────────────────────────────────────────────────────── */

test('watchdog: настройки по умолчанию и отключение нулём', () => {
  const defaults = storageWatchdogConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.intervalMs, 300_000);
  assert.equal(defaults.maxPerHour, 3);
  assert.equal(storageWatchdogConfig({ STORAGE_WATCH_SECONDS: '0' }).enabled, false);
  // Опечатка не должна превращать сторожа в busy-loop по Docker-сокету.
  assert.equal(storageWatchdogConfig({ STORAGE_WATCH_SECONDS: '1' }).intervalMs, 60_000);
});

test('watchdog: живой Storage не трогает, лежащий — перезапускает', async () => {
  const starts = [];
  let report = { problem: false, restartable: true, state: 'running', reason: '' };
  const watchdog = createStorageWatchdog({
    config: { enabled: true, intervalMs: 300_000, maxPerHour: 3 },
    check: async () => ({ available: true, report }),
    startJob: (options) => {
      starts.push(options);
      return { started: true };
    },
    log: () => {},
  });

  assert.equal((await watchdog.tick()).started, false, 'здоровый сервис перезапускать нельзя');
  assert.equal(starts.length, 0);

  report = { problem: true, restartable: true, state: 'exited', reason: 'контейнер остановлен (код 137)' };
  const result = await watchdog.tick();
  assert.equal(result.started, true);
  assert.equal(starts[0].kind, 'storage');
});

test('watchdog: отказ ключа и занятый агент — не повод запускать перезапуск', async () => {
  const starts = [];
  const watchdog = createStorageWatchdog({
    config: { enabled: true, intervalMs: 300_000, maxPerHour: 3 },
    check: async () => ({ available: true, report: { problem: true, restartable: false, state: 'running', reason: 'ключ' } }),
    startJob: (options) => { starts.push(options); return { started: true }; },
    log: () => {},
  });
  assert.equal((await watchdog.tick()).started, false);

  const busy = createStorageWatchdog({
    config: { enabled: true, intervalMs: 300_000, maxPerHour: 3 },
    check: async () => ({ available: true, report: { problem: true, restartable: true, state: 'exited' } }),
    startJob: (options) => { starts.push(options); return { started: true }; },
    isBusy: () => true,
    log: () => {},
  });
  assert.equal((await busy.tick()).skipped, true);
  assert.equal(starts.length, 0);
});

test('watchdog: не больше maxPerHour перезапусков и час тишины после них', async () => {
  let clock = Date.parse('2026-10-31T10:00:00Z');
  const starts = [];
  const lines = [];
  const watchdog = createStorageWatchdog({
    config: { enabled: true, intervalMs: 300_000, maxPerHour: 2 },
    check: async () => ({ available: true, report: { problem: true, restartable: true, state: 'exited', reason: 'лежит' } }),
    startJob: (options) => { starts.push(options); return { started: true }; },
    log: (line) => lines.push(line),
    now: () => clock,
  });

  assert.equal((await watchdog.tick()).started, true);
  clock += 60_000;
  assert.equal((await watchdog.tick()).started, true);
  clock += 60_000;
  assert.equal((await watchdog.tick()).started, false, 'третья попытка за час запрещена');
  assert.match(lines.at(-1), /приостанавливаю попытки на час/);

  // Через час тишина заканчивается — но не раньше.
  clock += 30 * 60_000;
  assert.equal((await watchdog.tick()).started, false);
  clock += 31 * 60_000;
  assert.equal((await watchdog.tick()).started, true);
  assert.equal(starts.length, 3);
});
