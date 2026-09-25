#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — ручное обновление развёрнутой версии проекта.
#
# Скрипт выполняется НА ХОСТЕ (не внутри контейнера web): его поднимает
# приватный update-agent (`scripts/update-agent.mjs`), когда админ нажимает
# «Обновить сейчас» в Админка → Мониторинг → «Обновление проекта».
# Контейнер сайта намеренно не имеет доступа ни к git, ни к Docker-сокету.
#
# Прогресс сообщается машиночитаемой строкой в stdout:
#   ::edrc::{"stage":"build","percent":70,"message":"Пересобираю web"}
# Остальные строки — журнал; он показывается админу (сокрытием похожих на
# секрет значений). Формат описан в scripts/lib/update-state.mjs.
#
# Режим (PROJECT_DEPLOY_MODE):
#   auto     — определяется сам (по умолчанию)
#   compose  — git pull + docker compose up -d --build
#   systemd  — git pull + npm ci + npm run build + prepare-standalone + restart
#
# Переменные (обычно достаточно PROJECT_* из .env.production):
#   PROJECT_DIR              каталог с клоном репозитория
#   PROJECT_UPDATE_BRANCH    ветка-источник (default: main)
#   PROJECT_REPOSITORY       owner/repo — только для сообщений
#   PROJECT_DEPLOY_MODE      auto|compose|systemd
#   UPDATE_APPLY_MIGRATIONS  1 — применять недостающие supabase/migrations/*.sql
#                        (все неотмеченные в migrations.mark: и новые между
#                        ревизиями, и уцелевшие после сбоев прошлых прогонов)
#   UPDATE_BACKUP_BEFORE     1 (default) — pg_dump БД перед обновлением;
#                        0 — без резервной копии (флажок «с бэкапом БД»)
#   UPDATE_RUN_TESTS         1 (default) — гонять тесты при сборке (compose:
#                        RUN_TESTS в build-args, systemd: npm test перед
#                        сборкой); 0 — быстрый прогон без тестов
#   UPDATE_MIGRATIONS_ONLY   1 — кнопка «применить только миграции»:
#                        синхронизация исходников + миграции, БЕЗ сборки,
#                        переключения и проверки health (контейнеры не трогаем)
#   UPDATE_BACKUP_DIR        каталог для pg_dump перед миграциями
#   UPDATE_HEALTH_URL        что опрашивать после переключения
#   SYSTEMD_SERVICE / APP_DIR unit и standalone-выкладка для systemd-режима
#   UPDATE_STATE_DIR         lock, журнал, отметки о применённых миграциях
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
BRANCH="${PROJECT_UPDATE_BRANCH:-main}"
REPOSITORY="${PROJECT_REPOSITORY:-NooboGreenD/ed-ring-colony}"
MODE="${PROJECT_DEPLOY_MODE:-auto}"
APPLY_MIGRATIONS="${UPDATE_APPLY_MIGRATIONS:-1}"
# Флажки приходят из панели (Админка → Мониторинг → «Обновление проекта»):
# бэкап БД, тесты и режим «только миграции» переключаются на каждый запуск.
BACKUP_BEFORE="${UPDATE_BACKUP_BEFORE:-1}"
RUN_TESTS="${UPDATE_RUN_TESTS:-1}"
MIGRATIONS_ONLY="${UPDATE_MIGRATIONS_ONLY:-0}"
STATE_DIR="${UPDATE_STATE_DIR:-$PROJECT_DIR/../update-state}"
BACKUP_DIR="${UPDATE_BACKUP_DIR:-/opt/ed-ring-colony/backups}"
HEALTH_URL="${UPDATE_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
SYSTEMD_SERVICE="${SYSTEMD_SERVICE:-ed-ring-colony}"
APP_DIR="${APP_DIR:-/opt/ed-ring-colony/app}"
# update-agent сюда намеренно НЕ входит: пересоздать контейнер, который прямо
# сейчас выполняет этот скрипт, значит убить обновление на середине.
COMPOSE_SERVICES="${COMPOSE_SERVICES:-web jobs monitor-agent}"
ENV_FILE="${ENV_FILE:-.env.production}"
HEALTH_TRIES="${HEALTH_TRIES:-60}"

# ── прогресс и журнал ────────────────────────────────────────────────
json_safe() { printf '%s' "${1:-}" | tr -d '"\\' | tr '\n\r' '  ' | cut -c1-200; }
say()    { printf '%s\n' "$*"; }
# В разных образах по-разному: `docker compose` либо legacy `docker-compose`.
compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else return 127
  fi
}
report() { printf '::edrc::{"stage":"%s","percent":%s,"message":"%s"}\n' "$1" "$2" "$(json_safe "$3")"; }
# Ошибка пишется в stdout: менеджер разбирает именно этот поток, поэтому
# админ увидит причину в панели, а не только код возврата.
die()    { printf '::edrc::{"message":"%s"}\n' "$(json_safe "$*")"; say "ОШИБКА: $*" >&2; exit 1; }

fail() {
  local code="$1" line="$2"
  printf '::edrc::{"message":"%s"}\n' "$(json_safe "обновление прервано: строка $line, код $code")"
  exit "$code"
}
trap 'fail $? $LINENO' ERR

# ── 0. блокировка: два параллельных обновления испортят продов ───────
report prepare 5 "Проверяю блокировки и репозиторий"
mkdir -p "$STATE_DIR" 2>/dev/null || true
LOCK_FILE="$STATE_DIR/update.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "другое обновление ещё выполняется ($LOCK_FILE) — дождитесь его окончания"
fi

[ -d "$PROJECT_DIR" ] || die "PROJECT_DIR=$PROJECT_DIR не найден"
cd "$PROJECT_DIR" || die "не могу войти в $PROJECT_DIR"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$PROJECT_DIR не git-клон: обновление через git невозможно, обновляйте архивом"

CURRENT_SHA="$(git rev-parse HEAD)"

# ── 1. что именно пришло с GitHub ────────────────────────────────────
report fetch 15 "Синхронизация с GitHub"
REMOTE_NAME="$(git remote 2>/dev/null | head -n1 || true)"
REMOTE_NAME="${REMOTE_NAME:-origin}"
git fetch --quiet --prune "$REMOTE_NAME" "$BRANCH" 2>&1 | tail -n 3 \
  || die "git fetch $REMOTE_NAME/$BRANCH не удался (сеть, права, доступность $REPOSITORY)"
TARGET_SHA="$(git rev-parse "$REMOTE_NAME/$BRANCH")"
BEHIND="$(git rev-list --count "HEAD..$REMOTE_NAME/$BRANCH")"
AHEAD="$(git rev-list --count "$REMOTE_NAME/$BRANCH..HEAD")"

printf '::edrc::{"stage":"compare","percent":25,"branch":"%s","fromSha":"%s","toSha":"%s","message":"%s"}\n' \
  "$(json_safe "$BRANCH")" "$CURRENT_SHA" "$TARGET_SHA" \
  "$(json_safe "ревизия ${CURRENT_SHA:0:12}; доступно обновлений: $BEHIND")"

# Локальные коммиты сверх ветки — остановка в ЛЮБОМ случае, даже при нулевом
# отставании: кнопка пересобирает ровно то, что лежит в ветке, а незапушенные
# правки нельзя ни перемотать, ни молча разлить в прод.
if [ "$AHEAD" != "0" ]; then
  die "локальная ветка содержит $AHEAD собственных коммитов — перемотка невозможна, разлейте ветку вручную"
fi
# Отставание 0 — НЕ повод выходить. Клон бывает уже обновлён (правка руками,
# прошлый прогон упал ПОСЛЕ перемотки на сборке/таймауте), а развёрнутый образ
# и база отстают. «Обновить сейчас» обязан донашивать миграции и пересобирать
# в любом случае — иначе кнопка навсегда отвечает «уже актуально», не чиня
# ни сборку, ни миграции.
if [ "$BEHIND" = "0" ]; then
  say "git уже на последней ревизии ${TARGET_SHA:0:12} — выполняю недостающие миграции и пересборку"
fi

# ── 2. режим сборки ──────────────────────────────────────────────────
detect_mode() {
  if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
    echo compose
  elif command -v systemctl >/dev/null 2>&1 && systemctl cat "$SYSTEMD_SERVICE.service" >/dev/null 2>&1; then
    echo systemd
  elif [ -f docker-compose.yml ]; then
    echo compose
  else
    echo systemd
  fi
}
if [ -z "$MODE" ] || [ "$MODE" = "auto" ]; then MODE="$(detect_mode)"; fi
case "$MODE" in
  compose|systemd) ;;
  *) die "неизвестный PROJECT_DEPLOY_MODE=$MODE (ожидалось auto|compose|systemd)";;
esac
say "режим обновления: $MODE · $REPOSITORY@$BRANCH → ${TARGET_SHA:0:12}"

# ── 3. доступ к базе: бэкап и миграции ───────────────────────────────
DB_PSQL=""   # container | url | ''
DB_URL="$(grep -E '^(DATABASE_URL|SUPABASE_DB_URL)=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
SUPA_CONTAINER="${SUPABASE_CONTAINER:-}"
if [ -z "$SUPA_CONTAINER" ] && [ "$MODE" = "compose" ] && command -v docker >/dev/null 2>&1; then
  SUPA_CONTAINER="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'supabase-db$' | head -n1 || true)"
fi
if [ -n "$SUPA_CONTAINER" ]; then
  DB_PSQL="container"
elif command -v psql >/dev/null 2>&1 && [ -n "$DB_URL" ]; then
  DB_PSQL="url"
fi

run_sql() { # SQL на stdin
  if [ "$DB_PSQL" = "container" ]; then
    docker exec -i "$SUPA_CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1
  elif [ "$DB_PSQL" = "url" ]; then
    psql "$DB_URL" -q -v ON_ERROR_STOP=1
  else
    return 1
  fi
}
MARK_FILE="$STATE_DIR/migrations.mark"
is_marked() { [ -f "$MARK_FILE" ] && grep -qxF "$1" "$MARK_FILE"; }
mark_done() { printf '%s\n' "$1" >> "$MARK_FILE"; }

NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$CURRENT_SHA".."$TARGET_SHA" -- supabase/migrations 2>/dev/null | grep -E '\.sql$' | sort || true)"
if [ -n "$NEW_MIGRATIONS" ]; then
  say "новые миграции между ревизиями:"
  for f in $NEW_MIGRATIONS; do say "  • $f"; done
fi

# ── 4. обновление исходников ─────────────────────────────────────────
report compare 35 "Обновляю исходники до $BRANCH"
NEW_SHA="$CURRENT_SHA"
if [ "$BEHIND" != "0" ]; then
  # Спрятать правки нужно ровно здесь, а не в начале: до проверок мы рабочим
  # деревом не распоряжаемся, и при сбое stash не должен оставаться занятым.
  STASHED=0
  if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
    say "⚠ в рабочем дереве есть незакоммиченные изменения — прячу их в stash и верну после обновления"
    report compare 37 "Сохраняю локальные изменения (git stash)"
    git stash push -u -m "edrc-update-$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null 2>&1 \
      || die "git stash не удался — разберите изменения вручную"
    STASHED=1
  fi
  git merge --ff-only "$REMOTE_NAME/$BRANCH" >/dev/null 2>&1 \
    || die "git merge --ff-only не удался — изменения спрятаны в stash, верните их: git stash pop"
  NEW_SHA="$(git rev-parse HEAD)"
  if [ "$STASHED" = "1" ]; then
    # Возвращаем сразу после перемотки: сборка и миграции должны видеть те же
    # файлы, что админ видел до обновления.
    git stash pop --index >/dev/null 2>&1 \
      || say "⚠ git stash pop требует ручного разбора — ваши изменения остались в stash (git stash list)"
  fi
  say "исходники: ${CURRENT_SHA:0:12} → ${NEW_SHA:0:12}"
else
  say "исходники: ${CURRENT_SHA:0:12} — перемотка не требуется (отставания от $BRANCH нет)"
fi

# ── 4c. Compose-файлы стека: та же сеть Supabase, что у start-monitoring.sh ──
# Без одинаковых -f у всех скриптов очередное up пересоздало бы web/monitor-agent
# без сети Supabase, и «getaddrinfo EAI_AGAIN db» вернулся бы после обновления.
# Частичное дерево без deploy/compose-lib.sh (например, минимальный тестовый
# клон) не должно ломать обновление — тогда просто без доп. файлов.
EDRC_EXTRA_COMPOSE_FILES=""
if [ "$MODE" = "compose" ] && [ -f "$PROJECT_DIR/deploy/compose-lib.sh" ]; then
  # shellcheck source=compose-lib.sh
  source "$PROJECT_DIR/deploy/compose-lib.sh"
  EDRC_EXTRA_COMPOSE_FILES="$(edrc_extra_compose_files "$PROJECT_DIR" "$ENV_FILE")"
  [ -n "$EDRC_EXTRA_COMPOSE_FILES" ] && say "сеть Supabase: подключаю web/monitor-agent ($(edrc_detect_supabase_network "$ENV_FILE"))"
fi
# Persist метаданных ревизии не должен зависеть от наличия compose-lib.sh.
if ! declare -F edrc_persist_env >/dev/null 2>&1; then
  edrc_persist_env() {
    local f="$1" k="$2" v="$3"
    [ -f "$f" ] || return 0
    if grep -qE "^${k}=" "$f"; then sed -i "s|^${k}=.*|${k}=${v}|" "$f"; else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
  }
fi

# ── 4a. недостающие миграции и резервная копия ──────────────────────
# Список считается ПОСЛЕ перемотки по реальному дереву: применяем всё, чего
# нет в migrations.mark. Сюда попадают и новые файлы между ревизиями, и те,
# что остались неприменёнными после сбоя либо пропуска прошлых прогонов
# (раньше такие файлы не перепроверялись никогда — см. GALNET-TRANSLATIONS-FIX.md).
PENDING_MIGRATIONS=""
if [ -d supabase/migrations ]; then
  for f in supabase/migrations/*.sql; do
    [ -f "$f" ] || continue
    is_marked "$(basename "$f")" && continue
    PENDING_MIGRATIONS="$PENDING_MIGRATIONS $f"
  done
fi
PENDING_MIGRATIONS="${PENDING_MIGRATIONS# }"
# Проба базы — только когда есть что накатывать: пустой прогон не трогает
# Postgres вообще (и не пугает «не отвечает», когда миграции выключены).
if [ "$APPLY_MIGRATIONS" = "1" ] && [ -n "$PENDING_MIGRATIONS" ] && [ -n "$DB_PSQL" ] \
  && ! printf 'SELECT 1' | run_sql >/dev/null 2>&1; then
  say "⚠ прямой доступ к Postgres не отвечает — миграции будут пропущены"
  DB_PSQL=""
fi
if [ -n "$PENDING_MIGRATIONS" ]; then
  say "неприменённые миграции:"
  for f in $PENDING_MIGRATIONS; do say "  • $(basename "$f")"; done
else
  say "неприменённых миграций нет"
fi

DUMP=""
# Дамп делается по флажку «с бэкапом БД» (UPDATE_BACKUP_BEFORE), а не только
# перед миграциями: админ выбирает, нужна ли копия именно в этом прогоне.
if [ "$BACKUP_BEFORE" = "1" ] && [ -n "$DB_PSQL" ]; then
  report backup 45 "Резервная копия базы данных"
  # Каталог может оказаться недоступен (апдейтер в контейнере с read-only
  # rootfs) — тогда пишем в каталог состояния, а не бросаем обновление.
  if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || [ ! -w "$BACKUP_DIR" ]; then
    BACKUP_DIR="$STATE_DIR/backups"
    mkdir -p "$BACKUP_DIR" 2>/dev/null || BACKUP_DIR=""
  fi
  if [ -z "$BACKUP_DIR" ]; then
    say "⚠ некуда писать pg_dump ($STATE_DIR тоже только для чтения) — продолжаю без копии"
  fi
  DUMP=""; [ -n "$BACKUP_DIR" ] && DUMP="$BACKUP_DIR/edrc-before-update-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if [ "$DB_PSQL" = "container" ] && [ -n "$DUMP" ]; then
    docker exec "$SUPA_CONTAINER" pg_dump -U postgres -d postgres -Fc > "$DUMP" 2>/dev/null || DUMP=""
  elif [ -n "$DUMP" ] && command -v pg_dump >/dev/null 2>&1; then
    pg_dump "$DB_URL" -Fc -f "$DUMP" 2>/dev/null || DUMP=""
  else
    DUMP=""
  fi
  if [ -n "$DUMP" ] && [ -s "$DUMP" ]; then
    say "резервная копия: $DUMP ($(wc -c < "$DUMP") байт)"
    ls -1t "$BACKUP_DIR"/edrc-before-update-*.dump 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old"; done
  else
    DUMP=""
    say "⚠ pg_dump недоступен — продолжаю без резервной копии (откат только через git)"
  fi
fi

# ── 4b. применяю миграции ────────────────────────────────────────────
MIGRATIONS_APPLIED=0
if [ -n "$PENDING_MIGRATIONS" ]; then
  if [ "$APPLY_MIGRATIONS" != "1" ]; then
    say "⚠ UPDATE_APPLY_MIGRATIONS=0 — миграции НЕ применены; примените их вручную до перезапуска"
  elif [ -z "$DB_PSQL" ]; then
    say "⚠ нет прямого доступа к Postgres (ни контейнера supabase-db, ни DATABASE_URL + psql)"
    say "  примените миграции вручную: docker exec -i supabase-db psql -U postgres -d postgres < ФАЙЛ"
  else
    report migrate 55 "Применяю недостающие миграции базы данных"
    for f in $PENDING_MIGRATIONS; do
      base="$(basename "$f")"
      if [ ! -f "$f" ]; then say "  ⚠ $base нет в дереве — пропуск"; continue; fi
      if printf '%s\n' "$NEW_MIGRATIONS" | grep -qxF "$f"; then
        say "  ▶ применяю $base (новая между ревизиями)"
      else
        say "  ▶ применяю $base (не была применена раньше)"
      fi
      if psql_out="$(run_sql < "$f" 2>&1)"; then
        mark_done "$base"
        MIGRATIONS_APPLIED=$((MIGRATIONS_APPLIED + 1))
      elif printf '%s' "$psql_out" | grep -qiE 'already exists|уже существует'; then
        # База, залитая снимком supabase/full_schema.sql или чинённая руками,
        # уже содержит объекты миграции: повторный накат получает «already
        # exists» на первом же таком объекте. Это НЕ ошибка — отмечаем файл
        # применённым и идём дальше. Любой другой сбой по-прежнему валит
        # обновление ДО переключения кода.
        say "  ⚠ $base — объекты уже существуют (миграция применялась ранее) — отмечаю как применённую"
        mark_done "$base"
      else
        printf '%s\n' "$psql_out" | tail -n 20 >&2
        die "миграция $base завершилась с ошибкой — код сайта ещё не переключался"
      fi
    done
    say "применено миграций: $MIGRATIONS_APPLIED"
  fi
fi

# ── 4d. режим «только миграции»: база трогается, сборка — нет ───────
# Кнопка «Применить только миграции» в панели: исходники синхронизированы,
# миграции накатаны — дальше пересборка НЕ идёт (контейнеры не перезапускаются,
# health не опрашивается: живой сайт мы не меняли). Финальный «done» сообщает
# mode=migrations — панель по нему показывает свои стадии и подписи.
if [ "$MIGRATIONS_ONLY" = "1" ]; then
  printf '::edrc::{"stage":"done","percent":100,"mode":"migrations","branch":"%s","fromSha":"%s","toSha":"%s","migrationsApplied":%s,"message":"%s"}\n' \
    "$(json_safe "$BRANCH")" "$CURRENT_SHA" "$NEW_SHA" "$MIGRATIONS_APPLIED" \
    "$(json_safe "миграции применены: $MIGRATIONS_APPLIED; сборка и переключение не выполнялись")"
  say "МИГРАЦИИ ПРИМЕНЕНЫ (без пересборки)"
  exit 0
fi


# ── 5. сборка и переключение ─────────────────────────────────────────
# Метаданные ревизии нужны ОБЕИМ режимам: их читает docker-compose.yml
# (build args web) и окружение systemd-сборки. Значения также пишутся в
# env-файл: тогда «ручная» пересборка без этого скрипта тоже передаст
# APP_GIT_SHA/APP_GIT_REF/APP_BUILD_TIME в образ, и блок «Версия проекта»
# панели сможет выполнить очную сверку.
export APP_GIT_SHA="$NEW_SHA"
export APP_GIT_REF="$BRANCH"
export APP_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -f "$ENV_FILE" ]; then
  edrc_persist_env "$ENV_FILE" APP_GIT_SHA    "$APP_GIT_SHA"
  edrc_persist_env "$ENV_FILE" APP_GIT_REF    "$APP_GIT_REF"
  edrc_persist_env "$ENV_FILE" APP_BUILD_TIME "$APP_BUILD_TIME"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi

if [ "$MODE" = "compose" ]; then
  # docker compose читает build-args из .env — держим symlink актуальным.
  [ -e ".env" ] || ln -sf "$ENV_FILE" .env
  # На малом VPS эта стадия — 30–60 минут (npm ci при смене lock-файла,
  # тесты, next build): это норма, а не зависание. Таймаута на сборку по
  # умолчанию нет (см. UPDATE_TIMEOUT_MINUTES в update-agent); флажок
  # «с тестами» из панели задаёт RUN_TESTS для build-args — переменная
  # окружения перекрывает значение из --env-file (приоритет окружения над
  # env-файлом закреплён документацией Compose).
  export RUN_TESTS
  say "тесты в сборке образа: RUN_TESTS=$RUN_TESTS"
  report build 70 "Пересобираю docker-образы — самая долгая часть (до ~60 мин на малом сервере, это не зависание)"
  if [ -f "$ENV_FILE" ]; then
    compose --env-file "$ENV_FILE" -f docker-compose.yml $EDRC_EXTRA_COMPOSE_FILES --profile monitoring up -d --build $COMPOSE_SERVICES
  else
    say "⚠ $ENV_FILE не найден — пересобираю без --env-file"
    compose -f docker-compose.yml $EDRC_EXTRA_COMPOSE_FILES --profile monitoring up -d --build $COMPOSE_SERVICES
  fi
  report switch 85 "Убираю висячие образы, чтобы не съедать диск"
  docker image prune -f >/dev/null 2>&1 || true
  # jobs входит в COMPOSE_SERVICES: планировщик получает тот же новый образ,
  # что и web. Сам update-agent намеренно не пересоздаётся — иначе обновление
  # убило бы собственный процесс; его образ обновится следующим прогоном с
  # --build или `docker compose --profile monitoring build update-agent`.
else
  report build 62 "npm ci"
  npm ci --no-audit --no-fund
  # Флажок «с тестами» и в systemd-режиме: тесты идут после npm ci и до
  # сборки — упавший тест останавливает обновление ДО перезапуска сервиса.
  if [ "$RUN_TESTS" = "1" ]; then
    report build 68 "Тесты (npm test)"
    npm test
  else
    say "тесты пропущены (UPDATE_RUN_TESTS=0)"
  fi
  report build 75 "npm run build"
  npm run build
  report switch 85 "Выкладываю standalone и перезапускаю $SYSTEMD_SERVICE"
  bash deploy/prepare-standalone.sh "$APP_DIR"
  systemctl restart "$SYSTEMD_SERVICE"
fi

# ── 6. проверка живости ──────────────────────────────────────────────
report verify 95 "Жду, пока сайт ответит"
checked=0
for _ in $(seq 1 "$HEALTH_TRIES"); do
  if command -v curl >/dev/null 2>&1; then
    if curl -sf -o /dev/null --max-time 5 "$HEALTH_URL"; then checked=1; break; fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -T 5 -O /dev/null "$HEALTH_URL"; then checked=1; break; fi
  else
    say "⚠ нет ни curl, ни wget — пропускаю проверку доступности"; checked=2; break
  fi
  sleep 4
done
if [ "$checked" = "1" ]; then say "сайт отвечает: $HEALTH_URL"; fi
if [ "$checked" = "0" ]; then
  die "сайт не ответил по $HEALTH_URL за $((HEALTH_TRIES * 4))с; docker logs src-web-1 или journalctl -u $SYSTEMD_SERVICE"
fi

printf '::edrc::{"stage":"done","percent":100,"mode":"%s","branch":"%s","fromSha":"%s","toSha":"%s","migrationsApplied":%s,"message":"%s"}\n' \
  "$(json_safe "$MODE")" "$(json_safe "$BRANCH")" "$CURRENT_SHA" "$NEW_SHA" "$MIGRATIONS_APPLIED" \
  "$(json_safe "готово: развёрнута ревизия ${NEW_SHA:0:12}, миграций применено: $MIGRATIONS_APPLIED")"
say "ОБНОВЛЕНИЕ ЗАВЕРШЕНО"
