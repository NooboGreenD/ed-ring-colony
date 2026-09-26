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
    // STUB_BUILD_FAIL=1 — сборка образа падает так же, как на живом сервере:
    // текст причины уходит в stderr, код возврата 1.
    '  *" build "*)',
    '    if [ "${STUB_BUILD_FAIL:-0}" = "1" ]; then',
    '      echo "#12 42.5 npm ERR! code ENOSPC" >&2',
    '      echo "ERROR: failed to solve: process \\"/bin/sh -c npm ci\\" did not complete successfully: no space left on device" >&2',
    '      exit 1',
    '    fi',
    '    exit 0;;',
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
    // Сборка и переключение — два отдельных шага: упавший build не трогает
    // работающие контейнеры, а RUN_TESTS уезжает явным --build-arg.
    assert.match(calls, /compose --env-file .* build --build-arg RUN_TESTS=1 web jobs monitor-agent update-agent/);
    assert.match(calls, /compose --env-file .* up -d --no-build web jobs monitor-agent/);
    assert.match(calls, /image prune -f/);
    // Образ апдейтера пересобирается вместе со всеми (иначе агент навсегда
    // остаётся старым), но контейнер, из которого запущен скрипт, не
    // пересоздаётся: это убило бы обновление на середине.
    assert.equal(/up -d [^\n]*update-agent/.test(calls), false);

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
    assert.match(calls, /build --build-arg RUN_TESTS=1 web jobs monitor-agent/, 'повторный прогон всё равно пересобирает');
    assert.match(calls, /up -d --no-build web jobs monitor-agent/, 'и переключает контейнеры на новый образ');
    assert.equal(calls.includes('psql'), false, 'отмеченная миграция не накатывается второй раз');
    // Дамп больше не привязан к наличию миграций: его решает флажок
    // «с бэкапом БД» (UPDATE_BACKUP_BEFORE), включённый по умолчанию.
    assert.match(calls, /pg_dump/, 'бэкап по умолчанию включён, даже когда миграций нет');

    // Флажок «без бэкапа»: UPDATE_BACKUP_BEFORE=0 — дампа в прогоне нет.
    writeFileSync(ctx.log, '');
    const noBackup = ctx.run({ UPDATE_BACKUP_BEFORE: '0' });
    assert.equal(noBackup.status, 0, noBackup.stdout + noBackup.stderr);
    assert.equal(readFileSync(ctx.log, 'utf8').includes('pg_dump'), false, 'UPDATE_BACKUP_BEFORE=0 — без дампа');
  } finally {
    ctx.cleanup();
  }
});

test('флажок тестов: RUN_TESTS попадает в сборку, по умолчанию тесты включены', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });

    const withTests = ctx.run();
    assert.equal(withTests.status, 0, withTests.stdout + withTests.stderr);
    assert.match(withTests.stdout, /флажки прогона: тесты=1/, 'по умолчанию тесты идут');
    assert.match(readFileSync(ctx.log, 'utf8'), /build --build-arg RUN_TESTS=1 /, 'RUN_TESTS уходит явным build-arg');

    const withoutTests = ctx.run({ UPDATE_RUN_TESTS: '0' });
    assert.equal(withoutTests.status, 0, withoutTests.stdout + withoutTests.stderr);
    assert.match(withoutTests.stdout, /флажки прогона: тесты=0/, 'флажок «без тестов» дошёл до сборки');
    // Значение не зависит от того, что написано в .env.production: оно
    // передаётся аргументом сборки, а не интерполяцией env-файла.
    assert.match(readFileSync(ctx.log, 'utf8'), /build --build-arg RUN_TESTS=0 /, 'без тестов — тоже явным build-arg');
    assert.match(readFileSync(ctx.log, 'utf8'), /up -d --no-build web jobs monitor-agent/);
  } finally {
    ctx.cleanup();
  }
});

test('упавшая сборка: в панель уходит причина, а контейнеры не переключаются', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });

    const run = ctx.run({ STUB_BUILD_FAIL: '1' });
    assert.notEqual(run.status, 0, 'сбой сборки обязан завершать скрипт ошибкой');

    // Причина приезжает отдельным полем `error`. Раньше её не было вовсе:
    // ловушка ERR не наследовалась функцией compose(), и панель показывала
    // последнюю подпись стадии — «Пересобираю docker-образы… (код 1)».
    const failures = events(run.stdout).filter((event) => typeof event.error === 'string');
    assert.ok(failures.length > 0, 'должно быть событие с полем error: ' + run.stdout);
    const reason = failures[failures.length - 1].error;
    assert.match(reason, /сборка образов/, 'в ошибке названа стадия');
    assert.match(reason, /no space left on device/, 'в ошибке настоящая причина из вывода сборки');
    assert.equal(/Пересобираю docker-образы/.test(reason), false, 'подпись стадии — не причина сбоя');

    // Живой сайт не трогали: переключения контейнеров не было.
    const calls = readFileSync(ctx.log, 'utf8');
    assert.equal(calls.includes('up -d'), false, 'после падения сборки контейнеры остаются прежними');
  } finally {
    ctx.cleanup();
  }
});

test('режим «только миграции»: накатывает базу и завершается до сборки', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'supabase/migrations/20261001000000_only.sql': '-- only\n' });

    const run = ctx.run({ UPDATE_MIGRATIONS_ONLY: '1' });
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const list = events(run.stdout);
    const stages = list.map((event) => event.stage).filter(Boolean);
    for (const stage of ['prepare', 'fetch', 'compare', 'backup', 'migrate', 'done']) {
      assert.ok(stages.includes(stage), 'стадия ' + stage + ' должна быть в потоке: ' + stages.join('>'));
    }
    assert.equal(stages.includes('build'), false, 'сборка в режиме «только миграции» не запускается');
    assert.equal(stages.includes('switch'), false, 'контейнеры не переключаются');
    assert.equal(stages.includes('verify'), false, 'живой сайт не перезапускался — health не опрашивается');

    const done = list[list.length - 1];
    assert.equal(done.stage, 'done');
    assert.equal(done.percent, 100);
    assert.equal(done.mode, 'migrations', 'панель по mode=migrations показывает свой чек-лист');
    assert.equal(done.migrationsApplied, 1);

    // База накатана (psql был), пересборки не было.
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /psql -U postgres -d postgres/);
    assert.match(calls, /pg_dump/, 'бэкап перед миграциями остаётся под флажком');
    assert.equal(calls.includes('up -d'), false, 'compose up не вызывается');
    assert.equal(calls.includes('compose --env-file') && calls.includes(' build --build-arg'), false, 'образы не собираются');
    assert.match(run.stdout, /МИГРАЦИИ ПРИМЕНЕНЫ \(без пересборки\)/);
    assert.match(readFileSync(join(ctx.state, 'migrations.mark'), 'utf8'), /20261001000000_only\.sql/);
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
