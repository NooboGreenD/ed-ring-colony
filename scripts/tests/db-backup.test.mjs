import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BACKUP_STAGES,
  UPDATE_STAGES,
  applyProgressEvent,
  emptyUpdateState,
  parseProgressLine,
  publicUpdateView,
  sanitizeUpdateState,
} from '../lib/update-state.mjs';
import { createUpdateManager, createUpdateServer, updateAgentConfig } from '../update-agent.mjs';
import {
  BACKUP_DUE_AFTER_MS,
  MAINTENANCE_MAX_MS,
  backupDue,
  formatBytes,
  isMaintenanceExemptPath,
  mergeBackupRecord,
  maintenanceValue,
  parseBackupRecord,
  parseMaintenanceState,
} from '../../src/lib/maintenanceFlag.ts';

/**
 * Контракт ручного резервного копирования (Админка → Бэкапы) и заглушки
 * «Ведутся технические работы».
 *
 * Слои проверяются раздельно, потому что ломаются по-разному:
 *  1. состояние агента — по полю `kind` панель выбирает словарь этапов, а по
 *     `backupFile`/`backupBytes` пишется отметка о последней копии;
 *  2. HTTP-агент — старт/повтор/отмена/401 и то, какие переменные уходят в
 *     скрипт (BACKUP_FULL решает, попадёт ли каталог систем в дамп);
 *  3. deploy/db-backup.sh — shell, который не типизируется: прогоняем его
 *     на подставном `docker` и смотрим на файлы, ротацию и коды возврата;
 *  4. признак техработ — чистая логика, от которой зависит, увидит ли
 *     посетитель сайт или заглушку (и не закроется ли сайт намертво).
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const TOKEN = 'backup-agent-test-token-not-a-real-secret';

const needsBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
  ? false
  : 'bash is not available in this image';

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

function testConfig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-backup-'));
  return updateAgentConfig({
    UPDATE_AGENT_HOST: '127.0.0.1',
    UPDATE_AGENT_TOKEN: TOKEN,
    PROJECT_DIR: dir,
    UPDATE_STATE_DIR: join(dir, 'state'),
    UPDATE_SCRIPT: join(dir, 'fake-update.sh'),
    BACKUP_SCRIPT: join(dir, 'fake-backup.sh'),
    UPDATE_BACKUP_DIR: join(dir, 'backups'),
    UPDATE_BACKUP_KEEP: '4',
    ...overrides,
  });
}

/** Скрипт-заглушка: пишет полученное окружение и рапортует прогресс. */
function writeFakeBackupScript(config, { fail = false, toc = 40, seconds = 0.6 } = {}) {
  mkdirSync(join(config.projectDir), { recursive: true });
  writeFileSync(config.backupScript, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    // PROJECT_DIR передаёт менеджер — по нему и находим, куда писать окружение.
    'ENV_DUMP="${PROJECT_DIR}/env.txt"',
    'printf "BACKUP_FULL=%s\\nUPDATE_BACKUP_DIR=%s\\nUPDATE_BACKUP_KEEP=%s\\n" "$BACKUP_FULL" "$UPDATE_BACKUP_DIR" "$UPDATE_BACKUP_KEEP" > "$ENV_DUMP"',
    // Пауза нужна, чтобы «второй запуск параллельно» проверялся детерминированно.
    `sleep ${seconds}`,
    'echo \'::edrc::{"stage":"prepare","percent":5,"message":"проверка"}\'',
    'echo \'::edrc::{"stage":"backup","percent":45,"message":"pg_dump"}\'',
    `echo '::edrc::{"stage":"verify","percent":95,"message":"объектов ${toc}"}'`,
    fail
      ? 'echo \'::edrc::{"message":"архив не читается"}\'; exit 1'
      : 'echo \'::edrc::{"stage":"done","percent":100,"backupFile":"/opt/backups/edrc-db-20260927T000000Z.dump","backupBytes":300000,"message":"готово"}\'',
    '',
  ].join('\n'), { mode: 0o755 });
}

/* ── 1. состояние агента: kind, backupFile, backupBytes ────────────── */

test('backup state: kind отличает копию от обновления во всех проекциях', () => {
  const base = emptyUpdateState('2026-09-27T10:00:00.000Z');
  assert.equal(base.kind, 'update', 'по умолчанию машина состояний обслуживает обновление');
  assert.equal(sanitizeUpdateState({ ...base, kind: 'backup' }).kind, 'backup');
  assert.equal(sanitizeUpdateState({ ...base, kind: 'что угодно' }).kind, 'update', 'неизвестный kind нормализуется');

  const running = sanitizeUpdateState({ ...base, kind: 'backup', state: 'running', stage: 'backup', percent: 45 });
  const publicView = publicUpdateView(running);
  assert.equal(publicView.kind, 'backup', 'публичный статус сообщает, что идёт именно копия');
  assert.equal(publicView.active, true);
  assert.equal(publicUpdateView(sanitizeUpdateState({ ...base, kind: 'backup', state: 'idle' })).kind, null);
});

test('backup state: файл и размер копии не уносят путь с хоста', () => {
  const event = parseProgressLine(
    '::edrc::{"stage":"done","percent":100,"backupFile":"/opt/ed-ring-colony/backups/edrc-db-20260927T010203Z.dump","backupBytes":1234567}',
  );
  const state = sanitizeUpdateState(applyProgressEvent(emptyUpdateState(), event, '2026-09-27T01:03:00.000Z'));
  assert.equal(state.backupFile, 'edrc-db-20260927T010203Z.dump');
  assert.equal(state.backupBytes, 1234567);
  assert.equal(state.percent, 100);

  const traversal = sanitizeUpdateState({ ...emptyUpdateState(), backupFile: '../../etc/passwd' });
  assert.equal(String(traversal.backupFile).includes('/'), false, 'остаётся только имя файла');
  assert.equal(sanitizeUpdateState({ ...emptyUpdateState(), backupBytes: -5 }).backupBytes, 0, 'отрицательный размер обрезается');
});

test('backup stages: словарь этапов копии — подмножество словаря обновления', () => {
  // applyProgressEvent двигает процент только по известным стадиям: если бы
  // копия рапортовала «dump», шкала встала бы намертво.
  const ids = UPDATE_STAGES.map((stage) => stage.id);
  for (const stage of BACKUP_STAGES) {
    assert.ok(ids.includes(stage.id), `стадия ${stage.id} есть в общем словаре`);
  }
  assert.equal(BACKUP_STAGES.at(-1).id, 'done');
});

/* ── 2. HTTP-агент: /backup ─────────────────────────────────────────── */

test('backup http: без токена копию не сделать', async (t) => {
  const config = testConfig();
  writeFakeBackupScript(config);
  const server = createUpdateServer({ config, manager: createUpdateManager(config) });
  const port = await listen(server);
  t.after(() => new Promise((done) => server.close(done)));

  const denied = await fetch(`http://127.0.0.1:${port}/backup`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
});

test('backup http: запуск, одиночность, окружение скрипта и отмена', async (t) => {
  const config = testConfig();
  const envFile = join(config.projectDir, 'env.txt');
  writeFakeBackupScript(config);
  const manager = createUpdateManager(config);
  const server = createUpdateServer({ config, manager });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  t.after(() => new Promise((done) => server.close(done)));

  const started = await fetch(`${origin}/backup`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(started.status, 202);
  const payload = await started.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.update.kind, 'backup', 'панель по этому полю рисует этапы копии');

  const busy = await fetch(`${origin}/backup`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(busy.status, 409, 'вторая копия параллельно не запускается');
  assert.equal((await busy.json()).reason, 'already-running');

  assert.equal(await waitFor(() => !manager.isBusy()), true, 'копия должна завершиться');
  const done = (await (await fetch(`${origin}/status?full=1`, { headers: auth })).json()).update;
  assert.equal(done.state, 'succeeded');
  assert.equal(done.kind, 'backup');
  assert.equal(done.backupFile, 'edrc-db-20260927T000000Z.dump');
  assert.equal(done.backupBytes, 300000);
  assert.equal(JSON.stringify(done).includes(TOKEN), false, 'токен не утекает в состояние');

  const env = readFileSync(envFile, 'utf8');
  assert.match(env, /BACKUP_FULL=0/, 'по умолчанию каталог систем в дамп не попадает');
  assert.match(env, /UPDATE_BACKUP_KEEP=4/, 'глубина ротации передаётся скрипту');

  const full = await fetch(`${origin}/backup`, { method: 'POST', headers: auth, body: JSON.stringify({ full: true }) });
  assert.equal(full.status, 202);
  assert.equal(await waitFor(() => !manager.isBusy()), true);
  assert.match(readFileSync(envFile, 'utf8'), /BACKUP_FULL=1/, 'full=true включает каталог систем');
});

test('backup http: ошибка скрипта видна админу, а отмена снимает задачу', async (t) => {
  const config = testConfig();
  writeFakeBackupScript(config, { fail: true });
  const manager = createUpdateManager(config);
  const server = createUpdateServer({ config, manager });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  t.after(() => new Promise((done) => server.close(done)));

  await fetch(`${origin}/backup`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(await waitFor(() => !manager.isBusy()), true);
  const failed = (await (await fetch(`${origin}/status?full=1`, { headers: auth })).json()).update;
  assert.equal(failed.state, 'failed');
  assert.match(failed.error || '', /не читается|кодом 1/, 'причина из скрипта доходит до панели');
});

/* ── 3. deploy/db-backup.sh на подставном docker ───────────────────── */

function writeFakeDocker(binDir, { toc = 40, excludeMarker, total = 50_000_000_000, catalog = 42_000_000_000 } = {}) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'docker'), [
    '#!/usr/bin/env bash',
    'case "$*" in',
    '  *"ps --format"*) echo "supabase-db"; exit 0 ;;',
    '  *"pg_dump --version"*) echo "pg_dump (PostgreSQL) 17.4"; exit 0 ;;',
    `  *"pg_total_relation_size('public.galaxy_systems')"*) echo "${catalog}"; exit 0 ;;`,
    `  *"pg_class"*) echo "${total}"; exit 0 ;;`,
    `  *"pg_restore --list"*) cat > /dev/null; for i in $(seq 1 ${toc}); do echo "; toc $i"; done; exit 0 ;;`,
    '  *"pg_dump -U postgres -d postgres"*)',
    excludeMarker ? '    case "$*" in *"--exclude-table=public.galaxy_systems"*) echo yes >> "$EXCLUDE_MARKER";; esac' : '    :',
    '    head -c 200000 /dev/urandom; exit 0 ;;',
    'esac',
    'echo "unhandled: $*" >&2; exit 3',
    '',
  ].join('\n'), { mode: 0o755 });
}

function runBackupScript(env) {
  return spawnSync('bash', [join(ROOT, 'deploy', 'db-backup.sh')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

test('db-backup.sh: копия без каталога систем, проверка архива, отметка для панели', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-db-backup-'));
  const binDir = join(dir, 'bin');
  const backups = join(dir, 'backups');
  const marker = join(dir, 'exclude-marker');
  writeFakeDocker(binDir, { excludeMarker: true });
  mkdirSync(backups, { recursive: true });

  const result = runBackupScript({
    PATH: `${binDir}:${process.env.PATH}`,
    PROJECT_DIR: join(dir, 'proj'),
    UPDATE_STATE_DIR: join(dir, 'state'),
    UPDATE_BACKUP_DIR: backups,
    UPDATE_BACKUP_KEEP: '4',
    BACKUP_POLL_SECONDS: '1',
    EXCLUDE_MARKER: marker,
  });

  assert.equal(result.status, 0, `скрипт завершился успешно: ${result.stderr || result.stdout}`);
  const events = result.stdout.split('\n').map(parseProgressLine).filter(Boolean);
  const done = events.find((event) => event.stage === 'done');
  assert.ok(done, 'есть событие завершения');
  assert.match(done.backupFile, /^edrc-db-\d{8}T\d{6}Z\.dump$/, 'имя копии без суффикса -full');
  assert.ok(done.backupBytes > 0, 'размер копии передан панели');
  assert.equal(readFileSync(marker, 'utf8').trim(), 'yes', 'каталог систем исключён из дампа');
  assert.match(result.stdout, /объектов в оглавлении — 40/, 'архив проверен через pg_restore --list');
});

test('db-backup.sh: полный дамп помечен в имени и не исключает каталог', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-db-backup-full-'));
  const binDir = join(dir, 'bin');
  const backups = join(dir, 'backups');
  const marker = join(dir, 'exclude-marker');
  // 400 МБ «данных» — проверка места на диске проходит на любом стенде.
  writeFakeDocker(binDir, { excludeMarker: true, total: 400_000_000, catalog: 300_000_000 });
  mkdirSync(backups, { recursive: true });

  const result = runBackupScript({
    PATH: `${binDir}:${process.env.PATH}`,
    PROJECT_DIR: join(dir, 'proj'),
    UPDATE_STATE_DIR: join(dir, 'state'),
    UPDATE_BACKUP_DIR: backups,
    UPDATE_BACKUP_KEEP: '4',
    BACKUP_FULL: '1',
    BACKUP_POLL_SECONDS: '1',
    EXCLUDE_MARKER: marker,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /режим FULL/, 'админ предупреждён о долгом окне техработ');
  const done = result.stdout.split('\n').map(parseProgressLine).filter(Boolean).find((e) => e.stage === 'done');
  assert.match(done.backupFile, /-full\.dump$/, 'полная копия отличается именем');
  assert.ok(!existsSync(marker), 'в полном режиме --exclude-table не передаётся');
});

test('db-backup.sh: ротация хранит UPDATE_BACKUP_KEEP свежих копий', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-db-backup-rot-'));
  const binDir = join(dir, 'bin');
  const backups = join(dir, 'backups');
  writeFakeDocker(binDir);
  mkdirSync(backups, { recursive: true });
  for (const stamp of ['20260801T000000Z', '20260808T000000Z', '20260815T000000Z', '20260822T000000Z']) {
    writeFileSync(join(backups, `edrc-db-${stamp}.dump`), 'old');
  }

  const result = runBackupScript({
    PATH: `${binDir}:${process.env.PATH}`,
    PROJECT_DIR: join(dir, 'proj'),
    UPDATE_STATE_DIR: join(dir, 'state'),
    UPDATE_BACKUP_DIR: backups,
    UPDATE_BACKUP_KEEP: '2',
    BACKUP_POLL_SECONDS: '1',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ротация: удалена старая копия/, 'старые копии удалены');
  assert.match(result.stdout, /хранится копий: 2 из 2/, 'глубина хранения соблюдена');
});

test('db-backup.sh: нечитаемый архив не засчитывается копией', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-db-backup-bad-'));
  const binDir = join(dir, 'bin');
  const backups = join(dir, 'backups');
  writeFakeDocker(binDir, { toc: 0 });
  mkdirSync(backups, { recursive: true });

  const result = runBackupScript({
    PATH: `${binDir}:${process.env.PATH}`,
    PROJECT_DIR: join(dir, 'proj'),
    UPDATE_STATE_DIR: join(dir, 'state'),
    UPDATE_BACKUP_DIR: backups,
    UPDATE_BACKUP_KEEP: '2',
    BACKUP_POLL_SECONDS: '1',
  });

  assert.notEqual(result.status, 0, 'битый архив — это ошибка, а не готовая копия');
  assert.match(`${result.stdout}${result.stderr}`, /не читается/, 'причина видна в журнале панели');
});

/* ── 4. признак технических работ ──────────────────────────────────── */

test('maintenance flag: активен до expires_at и ни секундой дольше', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const value = maintenanceValue('Резервное копирование базы данных', now, 60_000);
  assert.equal(value.active, true);
  assert.equal(Date.parse(value.expiresAt) - now, 60_000);

  assert.equal(parseMaintenanceState(value, now)?.active, true);
  assert.equal(parseMaintenanceState(value, now + 59_000)?.active, true);
  assert.equal(parseMaintenanceState(value, now + 61_000)?.active, false, 'просроченный флаг сайт не держит');
  assert.equal(parseMaintenanceState(null, now), null);
  assert.equal(parseMaintenanceState('мусор', now), null);
  assert.equal(parseMaintenanceState(JSON.stringify(value), now)?.active, true, 'jsonb строкой тоже разбирается');
  assert.equal(parseMaintenanceState({ active: true }, now)?.active, false, 'без срока признак не активен');
});

test('maintenance flag: потолок окна техработ ограничен', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const huge = maintenanceValue('копия', now, 30 * 24 * 60 * 60 * 1000);
  assert.equal(Date.parse(huge.expiresAt) - now, MAINTENANCE_MAX_MS, 'месяц под заглушкой невозможен');
  // Бессмысленный срок откатывается к потолку, а не превращается в «истекло».
  assert.equal(Date.parse(maintenanceValue('копия', now, -5).expiresAt) - now, MAINTENANCE_MAX_MS);
});

test('maintenance routing: админка, API и вход остаются под заглушкой доступными', () => {
  for (const path of ['/admin', '/admin?tab=backup', '/api/admin/backup', '/api/status', '/api/maintenance',
    '/login', '/auth/callback', '/maintenance', '/_next/static/chunk.js', '/favicon.ico']) {
    assert.equal(isMaintenanceExemptPath(path), true, `${path} доступен во время техработ`);
  }
  for (const path of ['/', '/atlas', '/cmdrs', '/squadrons', '/map', '/wiki', '/system/123']) {
    assert.equal(isMaintenanceExemptPath(path), false, `${path} закрывается заглушкой`);
  }
  // Префикс не должен «съедать» похожие маршруты.
  assert.equal(isMaintenanceExemptPath('/administrator'), false);
  assert.equal(isMaintenanceExemptPath('/apiary'), false);
});

test('backup cadence: неделя с последней успешной копии', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  assert.equal(BACKUP_DUE_AFTER_MS, 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(backupDue(null, now).due, true, 'копии не было — пора');

  const fresh = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(backupDue(fresh, now).due, false);
  assert.equal(backupDue(fresh, now).daysSince, 2);

  const stale = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
  const overdue = backupDue(stale, now);
  assert.equal(overdue.due, true);
  assert.equal(overdue.overdueMs, 24 * 60 * 60 * 1000);
});

test('backup record: отметка о копии переживает неудачу и мусор', () => {
  const record = parseBackupRecord({
    lastAt: '2026-09-27T03:00:00.000Z',
    file: 'edrc-db-20260927T030000Z.dump',
    bytes: 1_500_000,
    full: false,
    lastResult: 'succeeded',
    error: null,
  });
  assert.equal(record?.lastAt, '2026-09-27T03:00:00.000Z');
  assert.equal(record?.full, false);
  assert.equal(formatBytes(record?.bytes), '1.4 МБ');

  assert.equal(parseBackupRecord(null), null);
  assert.equal(parseBackupRecord({ lastResult: 'взлом' })?.lastResult, null);
  assert.equal(parseBackupRecord({ bytes: -1 })?.bytes, null);
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(2_500_000_000), '2.3 ГБ');
});

test('backup record: неудачная попытка не сдвигает дату последней копии', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  // Успешная копия восемь дней назад: недельный срок уже вышел.
  const staleAt = now - 8 * 24 * 60 * 60 * 1000;
  const previous = mergeBackupRecord(null, { result: 'succeeded', file: 'edrc-db-a.dump', bytes: 1000, full: false }, staleAt);
  assert.equal(previous.lastAt, new Date(staleAt).toISOString());

  const failed = mergeBackupRecord(previous, { result: 'failed', error: 'нет места' }, now);
  assert.equal(failed.lastAt, previous.lastAt, 'дата последней копии не меняется');
  assert.equal(failed.lastResult, 'failed');
  assert.equal(failed.error, 'нет места');
  assert.equal(failed.file, 'edrc-db-a.dump', 'сведения о прошлой копии сохраняются');
  assert.equal(backupDue(failed.lastAt, now).due, true, 'просроченное напоминание неудача не гасит');

  const aborted = mergeBackupRecord(previous, { result: 'aborted' }, now);
  assert.equal(aborted.lastAt, previous.lastAt);
  assert.equal(aborted.error, null);

  const next = mergeBackupRecord(previous, { result: 'succeeded', file: 'edrc-db-b.dump', bytes: 2000, full: true }, now);
  assert.equal(next.lastAt, new Date(now).toISOString());
  assert.equal(next.full, true);
  assert.equal(backupDue(next.lastAt, now).due, false);
});

/* ── 5. связка: прокси, страница, отсутствие cron ──────────────────── */

test('заглушка wired: прокси закрывает сайт до проверки сессии', () => {
  const proxy = readFileSync(join(ROOT, 'src', 'proxy.ts'), 'utf8');
  const gate = proxy.indexOf('isMaintenanceExemptPath');
  const auth = proxy.indexOf('createServerClient(');
  assert.ok(gate > 0, 'прокси проверяет признак техработ');
  assert.ok(gate < auth, 'заглушка отдаётся раньше, чем создаётся клиент Supabase');
  assert.match(proxy, /NextResponse\.rewrite\(new URL\('\/maintenance'/, 'прокси переписывает запрос на заглушку');
  assert.match(proxy, /status: 503/, 'заглушка отдаётся с 503');
  assert.match(proxy, /Retry-After/, 'браузеру сказано, когда повторить');

  assert.ok(existsSync(join(ROOT, 'src', 'app', 'maintenance', 'page.tsx')), 'страница заглушки существует');
  const screen = readFileSync(join(ROOT, 'src', 'components', 'MaintenanceScreen.tsx'), 'utf8');
  assert.match(screen, /Ведутся технические работы/);
  assert.match(screen, /\/api\/maintenance/, 'заглушка сама узнаёт, когда работы закончились');
  assert.match(screen, /prefers-reduced-motion/, 'анимация отключается при reduced motion');
});

test('cron-бэкапов на сервере больше нет', () => {
  for (const file of ['deploy/selfhost/install.sh', 'deploy/crontab.example']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!/^\s*[^#\n]*pg_dump/m.test(text), `${file}: автоматический pg_dump по расписанию удалён`);
  }
});
