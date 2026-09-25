import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Сквозная проверка deploy/update-project.sh на настоящем git-репозитории.
 *
 * Скрипт меняет прод, поэтому сценарии проверяются целиком, а не «по строкам»:
 * Docker и сеть подменяются заглушками в PATH, а всё остальное — настоящий git.
 *
 * Контракт кнопки «Обновить сейчас»: прогон ВСЕГДА донашивает недостающие
 * миграции (неотмеченные в migrations.mark) и пересобирает стек, даже когда
 * git уже на последней ревизии. Раньше такой прогон отвечал «обновлять
 * нечего» и не трогал ни базу, ни сборку — сорвавшиеся сборки и пропущенные
 * миграции не могли поправиться кнопкой никогда.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy', 'update-project.sh');
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = hasGit && hasBash ? false : 'нужны git и bash';

function stub(bin, name, body) {
  const file = join(bin, name);
  writeFileSync(file, '#!/usr/bin/env bash\n' + body + '\n');
  chmodSync(file, 0o755);
}

function setup() {
  const work = mkdtempSync(join(tmpdir(), 'edrc-script-'));
  const origin = join(work, 'origin.git');
  const src = join(work, 'src');
  const other = join(work, 'other');
  const bin = join(work, 'bin');
  const state = join(work, 'state');
  const log = join(work, 'calls.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(log, '');
  // Клон уже работает на базе с базовой схемой: её миграция применена и
  // отмечена — как на сервере, где механизм отметок migrations.mark живёт.
  writeFileSync(join(state, 'migrations.mark'), '20260101000000_base.sql\n');

  // «Докер»: пишет вызовы в лог, на `docker ps` отвечает именем базы, а
  // проверка живости (curl) всегда успешна. Если существует файл fail-on,
  // psql падает на миграции, текст которой там помянут — так проверяется
  // реакция скрипта на сорвавшуюся миграцию. Текст ошибки задаётся через
  // STUB_FAIL_MSG (по умолчанию — синтаксическая ошибка, которую скрипт
  // обязан прервать; «already exists» — напротив, помечается применённой).
  stub(bin, 'docker', [
    'echo "[docker] $*" >> "$STUB_LOG"',
    'case "$*" in',
    '  *psql*)',
    '    input=$(cat)',
    '    if [ -f "$STUB_FAIL_ON" ] && printf "%s" "$input" | grep -qf "$STUB_FAIL_ON"; then',
    '      echo "${STUB_FAIL_MSG:-ERROR: syntax error at or near}" >&2; exit 3',
    '    fi',
    '    exit 0;;',
    '  ps) printf "supabase-db\\n" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  stub(bin, 'curl', 'echo "[curl] $*" >> "$STUB_LOG"\nexit 0');

  const git = (cwd, ...args) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    if (run.status !== 0) throw new Error('git ' + args.join(' ') + ' → ' + run.stderr);
    return run.stdout.trim();
  };
  const env = {
    ...process.env,
    PATH: bin + ':/usr/bin:/bin',
    STUB_LOG: log,
    PROJECT_DIR: src,
    PROJECT_DEPLOY_MODE: 'compose',
    PROJECT_UPDATE_BRANCH: 'main',
    PROJECT_REPOSITORY: 'test/repo',
    UPDATE_STATE_DIR: state,
    UPDATE_BACKUP_DIR: join(work, 'backups'),
    UPDATE_HEALTH_URL: 'http://127.0.0.1:9/api/health',
    ENV_FILE: join(src, '.env.production'),
    HEALTH_TRIES: '2',
    SUPABASE_CONTAINER: 'supabase-db',
    UPDATE_APPLY_MIGRATIONS: '1',
  };

  spawnSync('git', ['init', '-q', '--initial-branch=main', '--bare', origin], { encoding: 'utf8' });
  git(src, 'init', '-q', '--initial-branch=main', src);
  git(src, 'config', 'user.email', 't@t');
  git(src, 'config', 'user.name', 't');
  writeFileSync(join(src, 'docker-compose.yml'), 'services:\n  web:\n    image: busybox\n');
  writeFileSync(join(src, '.env.production'), 'PROJECT_REPOSITORY=test\n');
  mkdirSync(join(src, 'supabase', 'migrations'), { recursive: true });
  writeFileSync(join(src, 'supabase', 'migrations', '20260101000000_base.sql'), '-- base\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  git(src, 'remote', 'add', 'origin', origin);
  git(src, 'push', '-q', 'origin', 'main');

  // Вторая «рабочая копия» — из неё прилетает новый релиз.
  spawnSync('git', ['clone', '-q', origin, other], { encoding: 'utf8' });
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');

  const run = (extraEnv = {}) => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    cwd: src,
    env: { ...env, STUB_FAIL_ON: join(work, 'fail-on'), ...extraEnv },
  });
  const release = (files) => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(other, name), content);
    }
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'release');
    git(other, 'push', '-q', 'origin', 'main');
  };

  return {
    work, src, state, log, bin, env, run, release, git,
    failOn: join(work, 'fail-on'),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

function events(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.includes('::edrc::{'))
    .map((line) => {
      try { return JSON.parse(line.slice(line.indexOf('::edrc::') + 8)); } catch { return { unparsed: line }; }
    });
}

test('первое обновление: перемотка, применение новых миграций, сохранение правок', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({
      'supabase/migrations/20260925000000_new_one.sql': '-- one\n',
      'supabase/migrations/20260926000000_new_two.sql': '-- two\n',
      'CHANGELOG.md': '# release\n',
    });
    // Правка админа поверх прода — обязана пережить обновление.
    writeFileSync(join(ctx.src, '.env.production'), readFileSync(join(ctx.src, '.env.production'), 'utf8') + 'LOCAL=keep-me\n');

    const run = ctx.run();
    const list = events(run.stdout);
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const stages = list.map((event) => event.stage).filter(Boolean);
    for (const stage of ['prepare', 'fetch', 'compare', 'backup', 'migrate', 'build', 'verify', 'done']) {
      assert.ok(stages.includes(stage), 'стадия ' + stage + ' должна быть в потоке: ' + stages.join('>'));
    }
    // Миграции применяются ПОСЛЕ перемотки: иначе файлов ещё нет на диске.
    assert.ok(stages.indexOf('migrate') > stages.indexOf('compare'), 'сначала исходники, потом миграции');

    const done = list[list.length - 1];
    assert.equal(done.stage, 'done');
    assert.equal(done.percent, 100);
    assert.equal(done.migrationsApplied, 2, 'должны быть применены ровно две новые миграции');
    assert.ok(run.stdout.includes('применяю 20260925000000_new_one.sql'));

    const applied = readFileSync(join(ctx.state, 'migrations.mark'), 'utf8').trim().split('\n');
    assert.deepEqual(applied, ['20260101000000_base.sql', '20260925000000_new_one.sql', '20260926000000_new_two.sql']);

    // Реальные вызовы: бэкап, psql, пересборка, prune.
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /pg_dump/);
    assert.match(calls, /psql -U postgres -d postgres -q -v ON_ERROR_STOP=1/);
    assert.match(calls, /compose --env-file .* up -d --build web jobs monitor-agent/);
    assert.match(calls, /image prune -f/);
    // Сам апдейтер не пересоздаёт контейнер, из которого он запущен.
    assert.equal(/up -d --build [^\n]*update-agent/.test(calls), false);

    // Прода обновилась, локальная правка вернулась из stash, stash пуст.
    assert.equal(ctx.git(ctx.src, 'log', '--oneline').split('\n').length, 2);
    assert.ok(existsSync(join(ctx.src, 'CHANGELOG.md')));
    assert.match(readFileSync(join(ctx.src, '.env.production'), 'utf8'), /LOCAL=keep-me/);
    assert.equal(ctx.git(ctx.src, 'stash', 'list'), '', 'stash должен быть выгружен обратно');
  } finally {
    ctx.cleanup();
  }
});

test('повторный запуск: пересборка без перемотки, миграции второй раз не накатываются', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'supabase/migrations/20260927000000_third.sql': '-- third\n' });
    assert.equal(ctx.run().status, 0);

    writeFileSync(ctx.log, '');
    const second = ctx.run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    // Отсутствие отставания — не повод отвечать «обновлять нечего»: кнопка
    // обязана пересобрать стек (так чинится сорвавшийся прошлый билд).
    assert.match(second.stdout, /перемотка не требуется/);
    const done = events(second.stdout).pop();
    assert.equal(done.stage, 'done');
    assert.equal(done.percent, 100);
    assert.equal(done.migrationsApplied, 0, 'всё уже отмечено — накатывать нечего');
    assert.equal(done.fromSha, done.toSha, 'ревизия не менялась');
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /up -d --build web jobs monitor-agent/, 'повторный прогон всё равно пересобирает');
    assert.equal(calls.includes('psql'), false, 'отмеченная миграция не накатывается второй раз');
    assert.equal(calls.includes('pg_dump'), false, 'без неприменённых миграций дамп не нужен');
  } finally {
    ctx.cleanup();
  }
});

test('пропущенная миграция донашивается следующим прогоном без новых коммитов', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'supabase/migrations/20260930000000_third.sql': '-- third\n' });
    // Первый прогон пропустил миграции (админ выключил флажок / база была
    // недоступна) — исходники при этом уже перемотаны.
    const skipped = ctx.run({ UPDATE_APPLY_MIGRATIONS: '0' });
    assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
    assert.match(skipped.stdout, /НЕ применены/);
    assert.equal(readFileSync(join(ctx.state, 'migrations.mark'), 'utf8').includes('third'), false);

    writeFileSync(ctx.log, '');
    // Второй прогон: отставания от ветки нет, но миграция осталась
    // неприменённой — именно этот случай кнопка раньше объявляла «актуально».
    const second = ctx.run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /перемотка не требуется/);
    assert.ok(second.stdout.includes('применяю 20260930000000_third.sql'), 'неприменённая миграция обязана доехать: ' + second.stdout);
    assert.ok(second.stdout.includes('не была применена раньше'));
    const done = events(second.stdout).pop();
    assert.equal(done.stage, 'done');
    assert.equal(done.migrationsApplied, 1);
    assert.match(readFileSync(join(ctx.state, 'migrations.mark'), 'utf8'), /20260930000000_third\.sql/);
    assert.match(readFileSync(ctx.log, 'utf8'), /psql -U postgres -d postgres/);
  } finally {
    ctx.cleanup();
  }
});

test('миграция с «already exists» помечается применённой и не блокирует обновление', { skip }, () => {
  const ctx = setup();
  try {
    // База, залитая снимком full_schema.sql, уже содержит объекты старых
    // миграций: повторный накат получает «already exists» — это не ошибка.
    ctx.release({ 'supabase/migrations/20260930000001_legacy.sql': '-- legacy\nCREATE TABLE legacy (id int);\n' });
    writeFileSync(ctx.failOn, 'legacy');
    const run = ctx.run({ STUB_FAIL_MSG: 'ERROR: relation "legacy" already exists' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /применялась ранее/);
    const done = events(run.stdout).pop();
    assert.equal(done.stage, 'done');
    assert.equal(done.migrationsApplied, 0, 'уже существующая миграция не считается свеженакатанной');
    assert.match(readFileSync(join(ctx.state, 'migrations.mark'), 'utf8'), /20260930000001_legacy\.sql/);
  } finally {
    ctx.cleanup();
  }
});

test('ошибка миграции останавливает обновление до переключения сборки', { skip }, () => {
  const ctx = setup();
  try {
    writeFileSync(ctx.failOn, 'two');
    ctx.release({
      'supabase/migrations/20260928000000_one.sql': '-- one\n',
      'supabase/migrations/20260929000000_two.sql': '-- two\n',
    });
    const run = ctx.run();
    assert.notEqual(run.status, 0, 'падение миграции — ненулевой код возврата');
    const list = events(run.stdout);
    const withMessage = list.filter((event) => event.message);
    assert.match(JSON.stringify(withMessage), /миграция 20260929000000_two\.sql завершилась с ошибкой/);
    assert.equal(run.stdout.includes('"stage":"done"'), false, 'успешным такой прогон считаться не должен');
    // Первая миграция осталась отмеченной — повторный прогон не применит её дважды.
    const applied = readFileSync(join(ctx.state, 'migrations.mark'), 'utf8');
    assert.match(applied, /20260928000000_one\.sql/);
    assert.equal(applied.includes('20260929000000_two.sql'), false);
  } finally {
    ctx.cleanup();
  }
});

test('база с недоступным /api/health — обновление помечается ошибкой, а не успехом', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'NEW.md': '# release\n' });
    stub(ctx.bin, 'curl', 'echo "[curl] $*" >> "$STUB_LOG"\nexit 22');
    const run = ctx.run();
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /сайт не ответил/);
    assert.match(run.stdout, /"stage":"verify"/);
  } finally {
    ctx.cleanup();
  }
});

test('локальные коммиты сверх ветки — остановка, а не force push', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'A.md': '# a\n' });
    writeFileSync(join(ctx.src, 'mine.md'), 'my own commit\n');
    ctx.git(ctx.src, 'add', 'mine.md');
    ctx.git(ctx.src, 'commit', '-qm', 'моя локальная правка');
    const run = ctx.run();
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /собственных коммитов/);
    assert.ok(existsSync(join(ctx.src, 'mine.md')), 'локальный коммит обязан остаться на месте');
  } finally {
    ctx.cleanup();
  }
});
