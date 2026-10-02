import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Переключение контейнеров после сборки: гонка «Stopping ↔ Recreate».
 *
 * Прод-инцидент (журнал обновления, 02:42):
 *   Container src-web-1 Stopping
 *   Container 548bf7698162_src-web-1 Recreate
 *   Error when allocating new name: Conflict. The container name "/src-web-1"
 *   is already in use by container "548bf7698162…"
 *   ! ОШИБКА: переключение контейнеров — код 1
 *
 * Обновление обрывалось ПОСЛЕ успешной часовой сборки, а на хосте оставался
 * старый контейнер под именем «<id>_src-web-1». Он держал ссылку на прошлый
 * образ web, из-за чего `docker image prune` не мог его забрать: каждая
 * переборка прибавляла к диску целый образ (1.5–3 ГБ) при том, что ни один
 * каталог проекта не рос — всё лежало в /var/lib/docker/overlay2.
 *
 * Здесь проверяется лечение из deploy/compose-lib.sh: длинный стоп перед
 * переключением, снятие остатков, разбор конфликта имени и повтор.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const LIB = join(ROOT, 'deploy', 'compose-lib.sh');
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = hasBash ? false : 'нужен bash';

function setup() {
  const work = mkdtempSync(join(tmpdir(), 'edrc-switch-'));
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(work, 'calls.log');
  const names = join(work, 'names');
  const volumes = join(work, 'volumes');
  writeFileSync(log, '');
  writeFileSync(names, '');
  writeFileSync(volumes, '');

  const docker = [
    '#!/usr/bin/env bash',
    'echo "[docker] $*" >> "$STUB_LOG"',
    'case "$1 $2" in',
    '  "info "*|"info")',
    '    printf "/var/lib/docker\\n"; exit 0;;',
    'esac',
    'case "$*" in',
    '  "buildx version") exit 0;;',
    '  "ps -a --format {{.Names}}")',
    '    cat "$STUB_NAMES"; exit 0;;',
    '  "inspect --format {{.State.Running}} "*)',
    '    name="${*: -1}"',
    '    if grep -qx "$name" "$STUB_RUNNING" 2>/dev/null; then echo true; else echo false; fi',
    '    exit 0;;',
    '  "inspect "*)',
    '    name="${*: -1}"',
    '    grep -qx "$name" "$STUB_NAMES" && exit 0',
    '    exit 1;;',
    '  "rm -f "*)',
    '    name="${*: -1}"',
    '    grep -vx "$name" "$STUB_NAMES" > "$STUB_NAMES.tmp" 2>/dev/null || true',
    '    mv "$STUB_NAMES.tmp" "$STUB_NAMES"',
    '    exit 0;;',
    '  "volume ls -qf dangling=true") cat "$STUB_VOLUMES"; exit 0;;',
    '  "volume rm "*) exit 0;;',
    '  *" stop -t "*) exit 0;;',
    '  *" up -d --no-build "*)',
    '    attempt="$(cat "$STUB_ATTEMPT" 2>/dev/null || echo 0)"',
    '    printf "%s" "$((attempt + 1))" > "$STUB_ATTEMPT"',
    '    if [ "$attempt" -lt "${STUB_CONFLICTS:-0}" ]; then',
    '      echo " Container src-web-1 Stopping"',
    '      echo " Container 548bf7698162_src-web-1 Recreate"',
    '      echo \'Error response from daemon: Error when allocating new name: Conflict. The container name "/src-web-1" is already in use by container "548bf7698162af9667a96bc19ccbd4af2da8f44adecdc9e541dbf2424ad44850". You have to remove (or rename) that container to be able to reuse that name.\'',
    '      exit 1',
    '    fi',
    '    exit 0;;',
    'esac',
    'exit 0',
  ].join('\n');
  const file = join(bin, 'docker');
  writeFileSync(file, docker + '\n');
  chmodSync(file, 0o755);

  const run = (snippet, extraEnv = {}) => {
    const script = `set -uo pipefail\nsource "${LIB}"\n${snippet}\n`;
    return spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':/usr/bin:/bin',
        STUB_LOG: log,
        STUB_NAMES: names,
        STUB_RUNNING: join(work, 'running'),
        STUB_VOLUMES: volumes,
        STUB_ATTEMPT: join(work, 'attempt'),
        UPDATE_SWITCH_RETRY_DELAY: '0',
        ...extraEnv,
      },
    });
  };

  return {
    run,
    log: () => readFileSync(log, 'utf8'),
    setContainers: (list, running = []) => {
      writeFileSync(names, list.join('\n') + (list.length ? '\n' : ''));
      writeFileSync(join(work, 'running'), running.join('\n') + (running.length ? '\n' : ''));
    },
    setVolumes: (list) => writeFileSync(volumes, list.join('\n') + (list.length ? '\n' : '')),
  };
}

test('переключение сначала останавливает сервисы с длинным таймаутом', { skip }, () => {
  const ctx = setup();
  const res = ctx.run('edrc_compose_switch docker compose --env-file .env.production -- web jobs monitor-agent');
  assert.equal(res.status, 0, res.stderr);
  const log = ctx.log();
  // Десяти секунд по умолчанию не хватало: web не успевал завершиться, и
  // compose уходил в переименование на ещё живом контейнере.
  assert.match(log, /compose --env-file \.env\.production stop -t 120 web jobs monitor-agent/);
  // Сама команда переключения остаётся прежней — её форму проверяют и
  // сценарные тесты update-project.sh.
  assert.match(log, /up -d --no-build web jobs monitor-agent/);
  assert.ok(
    log.indexOf('stop -t 120') < log.indexOf('up -d --no-build'),
    'остановка идёт ДО пересоздания',
  );
});

test('конфликт имени контейнера разбирается и переключение повторяется', { skip }, () => {
  const ctx = setup();
  ctx.setContainers(['src-web-1', '548bf7698162af9667a96bc19ccbd4af2da8f44adecdc9e541dbf2424ad44850']);
  const res = ctx.run('edrc_compose_switch docker compose -- web', { STUB_CONFLICTS: '1' });
  assert.equal(res.status, 0, 'обновление больше не падает на занятом имени');
  const log = ctx.log();
  // Снимается и имя из ошибки, и id занявшего контейнера: разные версии
  // демона оставляют то одно, то другое.
  assert.match(log, /rm -f src-web-1/);
  assert.match(log, /rm -f 548bf7698162af/);
  assert.equal((log.match(/up -d --no-build web/g) || []).length, 2, 'переключение повторено один раз');
  assert.match(res.stdout, /конфликт имени контейнера/);
});

test('постоянная ошибка переключения по-прежнему возвращает код 1', { skip }, () => {
  const ctx = setup();
  const res = ctx.run('edrc_compose_switch docker compose -- web', { STUB_CONFLICTS: '9', UPDATE_SWITCH_RETRIES: '1' });
  assert.equal(res.status, 1, 'неустранимый конфликт не выдаётся за успех');
  assert.equal((ctx.log().match(/up -d --no-build web/g) || []).length, 2, 'ровно один повтор при UPDATE_SWITCH_RETRIES=1');
});

test('остаток прошлого переключения снимается, живой сайт — нет', { skip }, () => {
  const ctx = setup();
  // «<id>_src-web-1» — переименованный compose'ом старый контейнер. Пока он
  // существует, предыдущий образ web считается используемым, и image prune
  // не возвращает его гигабайты.
  ctx.setContainers(['src-web-1', '548bf7698162_src-web-1'], []);
  let res = ctx.run('edrc_remove_stale_containers');
  assert.equal(res.status, 0);
  assert.match(ctx.log(), /rm -f 548bf7698162_src-web-1/);
  assert.doesNotMatch(ctx.log(), /rm -f src-web-1\n/, 'рабочий контейнер не трогаем');

  const ctx2 = setup();
  ctx2.setContainers(['548bf7698162_src-web-1'], ['548bf7698162_src-web-1']);
  res = ctx2.run('edrc_remove_stale_containers');
  assert.equal(res.status, 0);
  assert.doesNotMatch(ctx2.log(), /rm -f/, 'работающий остаток обслуживает сайт — фоновая уборка его не снимает');
  assert.match(res.stdout, /ещё работает/);

  res = ctx2.run('edrc_remove_stale_containers --force');
  assert.match(ctx2.log(), /rm -f 548bf7698162_src-web-1/, '--force (перед переключением) снимает и работающий остаток');
});

test('удаляются только анонимные тома, именованные остаются', { skip }, () => {
  const ctx = setup();
  const anon = 'a'.repeat(64);
  ctx.setVolumes([anon, 'src_galaxy-dump', 'src_uploader-store']);
  const res = ctx.run('edrc_prune_anonymous_volumes');
  assert.equal(res.status, 0);
  const log = ctx.log();
  assert.match(log, new RegExp(`volume rm ${anon}`));
  assert.doesNotMatch(log, /volume rm src_galaxy-dump/, 'именованные тома проекта беречь (migrate-galaxy-dump.sh)');
  assert.doesNotMatch(log, /volume rm src_uploader-store/);
});

test('уборка диска снимает остатки переключений до image prune', { skip }, () => {
  const ctx = setup();
  ctx.setContainers(['548bf7698162_src-web-1']);
  const res = ctx.run('edrc_cleanup_docker_disk');
  assert.equal(res.status, 0, res.stderr);
  const log = ctx.log();
  assert.ok(
    log.indexOf('rm -f 548bf7698162_src-web-1') < log.indexOf('image prune'),
    'сначала снять контейнер-остаток, иначе старый образ считается используемым и не удаляется',
  );
});

test('update-project.sh переключает контейнеры через хелпер', { skip }, () => {
  const script = readFileSync(join(ROOT, 'deploy', 'update-project.sh'), 'utf8');
  assert.match(script, /edrc_compose_switch compose \$COMPOSE_ARGS -- \$COMPOSE_SERVICES/);
  // Запасной путь для частичного дерева без compose-lib.sh сохранён.
  assert.match(script, /compose \$COMPOSE_ARGS up -d --no-build \$COMPOSE_SERVICES/);
});

test('отчёт о диске ищет место, которого «нет ни в одной папке»', { skip }, () => {
  const report = readFileSync(join(ROOT, 'deploy', 'docker-disk-report.sh'), 'utf8');
  assert.match(report, /остатки переключений контейнеров/);
  assert.match(report, /удалённые, но ещё открытые файлы/);
  assert.match(report, /СПРЯТАННЫЕ под точками монтирования/);
  // Функция-заголовок не должна называться head: она перекрыла бы системный
  // head, и каждый `| head -n N` печатал бы заголовок вместо усечения.
  assert.doesNotMatch(report, /^head\(\)/m);
  assert.match(report, /^section\(\)/m);
});
