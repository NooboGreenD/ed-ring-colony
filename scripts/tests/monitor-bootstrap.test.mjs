import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const startScript = join(repoRoot, 'deploy', 'start-monitoring.sh');
const installScript = join(repoRoot, 'deploy', 'selfhost', 'install.sh');
const envExamplePath = join(repoRoot, '.env.example');
const HEX64 = /^[a-f0-9]{64}$/;

// The bootstrap script targets real servers (Ubuntu/Debian always ship bash),
// but `npm test` also runs inside node:*-alpine during the Docker build where
// bash may be absent — skip the shell-executing tests there instead of failing.
const needsBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
  ? false
  : 'bash is not available in this image';

function runStart(args, env = {}) {
  const result = spawnSync('bash', [startScript, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function tempEnvFile(initial = null) {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-monitor-'));
  const file = join(dir, '.env.production');
  if (initial == null) copyFileSync(envExamplePath, file);
  else writeFileSync(file, initial);
  return { dir, file };
}

function envValue(file, key) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith(`${key}=`));
  return lines.length ? lines[lines.length - 1].slice(key.length + 1) : null;
}

test('monitoring bootstrap and installer scripts are syntactically valid bash', { skip: needsBash }, () => {
  const scripts = [
    startScript,
    installScript,
    join(repoRoot, 'deploy', 'compose-lib.sh'),
    join(repoRoot, 'deploy', 'update-project.sh'),
    join(repoRoot, 'deploy', 'apply-env.sh'),
  ];
  for (const script of scripts) {
    const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, `bash -n ${script}: ${result.stderr}`);
  }
});

test('supabase network attach: override file and all compose entrypoints stay in sync', () => {
  const libPath = join(repoRoot, 'deploy', 'compose-lib.sh');
  const overridePath = join(repoRoot, 'deploy', 'compose.supabase-net.yml');
  const lib = readFileSync(libPath, 'utf8');
  const override = readFileSync(overridePath, 'utf8');

  // Переопределение подключает ровно те сервисы, которым нужен хост `db`.
  assert.match(override, /external: true/, 'сеть Supabase — внешняя, compose её не создаёт');
  assert.match(override, /name: \$\{SUPABASE_NETWORK:-supabase_default\}/);
  assert.match(override, /web:/);
  assert.match(override, /monitor-agent:/);
  assert.doesNotMatch(override, /jobs:/, 'планировщику Postgres напрямую не нужен');
  assert.doesNotMatch(override, /update-agent:/, 'привилегированный апдейтер в сеть БД не подключается');

  // Все, кто делает `docker compose up` для этого стека, обязаны использовать
  // один и тот же список -f, иначе очередное up молча уберёт сеть Supabase.
  for (const script of [startScript, join(repoRoot, 'deploy', 'update-project.sh'), join(repoRoot, 'deploy', 'apply-env.sh')]) {
    const text = readFileSync(script, 'utf8');
    assert.match(text, /compose-lib\.sh|edrc_extra_compose_files/, `${script} использует общий хелпер`);
  }
  for (const fn of ['edrc_detect_supabase_network', 'edrc_extra_compose_files', 'edrc_persist_env']) {
    assert.match(lib, new RegExp(`^${fn}\\(\\)`, 'm'), `${fn} определён в compose-lib.sh`);
  }
  // Скрипты работают с `set -u`: первое чтение переменной — только с дефолтом.
  assert.match(lib, /\[ -n "\$\{SUPABASE_NETWORK:-\}" \]/, 'первое чтение переменной защищено :-');
});

test('--keys-only inserts fresh distinct secrets and monitoring defaults without docker', { skip: needsBash }, () => {
  const { file } = tempEnvFile();
  const run = runStart(['--keys-only', '--env-file', file]);
  assert.equal(run.code, 0, run.output);

  const monitorToken = envValue(file, 'MONITOR_AGENT_TOKEN');
  const cronSecret = envValue(file, 'CRON_SECRET');
  assert.match(monitorToken, HEX64);
  assert.match(cronSecret, HEX64);
  assert.notEqual(monitorToken, cronSecret, 'MONITOR_AGENT_TOKEN must not reuse CRON_SECRET');
  assert.equal(envValue(file, 'PROJECT_REPOSITORY'), 'NooboGreenD/ed-ring-colony');
  assert.equal(envValue(file, 'PROJECT_UPDATE_BRANCH'), 'main');
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // Generated secrets never appear in the script output.
  assert.equal(run.output.includes(monitorToken), false);
  assert.equal(run.output.includes(cronSecret), false);
});

test('--keys-only is idempotent and never rewrites existing key values', { skip: needsBash }, () => {
  const { file } = tempEnvFile();
  assert.equal(runStart(['--keys-only', '--env-file', file]).code, 0);
  const firstToken = envValue(file, 'MONITOR_AGENT_TOKEN');
  const firstCron = envValue(file, 'CRON_SECRET');

  assert.equal(runStart(['--keys-only', '--env-file', file]).code, 0);
  assert.equal(envValue(file, 'MONITOR_AGENT_TOKEN'), firstToken);
  assert.equal(envValue(file, 'CRON_SECRET'), firstCron);

  // An operator-set token survives re-runs untouched.
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n`.replace(
    `MONITOR_AGENT_TOKEN=${firstToken}`,
    'MONITOR_AGENT_TOKEN=operator-provided-value',
  ));
  assert.equal(runStart(['--keys-only', '--env-file', file]).code, 0);
  assert.equal(envValue(file, 'MONITOR_AGENT_TOKEN'), 'operator-provided-value');
  assert.equal(envValue(file, 'CRON_SECRET'), firstCron);
});

test('--keys-only creates a missing env file from .env.example and warns about an empty database key', { skip: needsBash }, () => {
  const { file } = tempEnvFile('');
  writeFileSync(file, 'NEXT_PUBLIC_SUPABASE_URL=https://db.example\n');
  const run = runStart(['--keys-only', '--env-file', file]);
  assert.equal(run.code, 0, run.output);
  assert.match(envValue(file, 'MONITOR_AGENT_TOKEN'), HEX64);
  assert.match(run.output, /SUPABASE_SERVICE_ROLE_KEY/);

  const dir = mkdtempSync(join(tmpdir(), 'edrc-monitor-missing-'));
  const missing = join(dir, '.env.production');
  const created = runStart(['--keys-only', '--env-file', missing]);
  assert.equal(created.code, 0, created.output);
  assert.match(envValue(missing, 'MONITOR_AGENT_TOKEN'), HEX64);
});

test('unknown flags and --help behave predictably without touching docker', { skip: needsBash }, () => {
  const { file } = tempEnvFile();
  const help = runStart(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.output, /start-monitoring/);

  const bad = runStart(['--nope', '--env-file', file]);
  assert.equal(bad.code, 1);
  assert.match(bad.output, /Неизвестный флаг/);
});

test('installer wires the monitoring profile, dedicated token and revision metadata', () => {
  const installer = readFileSync(installScript, 'utf8');
  assert.match(installer, /MONITOR_AGENT_TOKEN=\$\(openssl rand -hex 32\)/);
  assert.match(installer, /set_env "\$SE" MONITOR_AGENT_TOKEN\s+"\$MONITOR_AGENT_TOKEN"/);
  assert.match(installer, /--profile monitoring up -d --build web jobs monitor-agent/);
  assert.match(installer, /APP_GIT_SHA/);
  assert.match(installer, /APP_BUILD_TIME/);
  assert.match(installer, /--no-monitor\)\s+DO_MONITOR=0/);
  // The dedicated token is stored in the protected credentials file.
  assert.match(installer, /^MONITOR_AGENT_TOKEN=\$MONITOR_AGENT_TOKEN$/m);
});
