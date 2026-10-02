#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — автоматический запуск мониторинга (Админка → Мониторинг).
#
# Один скрипт делает всё, что раньше требовалось руками:
#   1. создаёт .env.production из .env.example, если файла ещё нет;
#   2. вставляет недостающие ключи (существующие значения НЕ трогает):
#        MONITOR_AGENT_TOKEN   — генерируется (openssl rand -hex 32),
#                                отдельный ключ web → monitor-agent;
#        CRON_SECRET           — генерируется, обязателен для сервиса jobs;
#        PROJECT_REPOSITORY    — NooboGreenD/ed-ring-colony (по умолчанию);
#        PROJECT_UPDATE_BRANCH — main (по умолчанию);
#   3. передаёт метаданные ревизии (APP_GIT_SHA/APP_GIT_REF/APP_BUILD_TIME)
#      в сборку web — для блока «Версия проекта» на панели;
#   4. поднимает web, jobs и monitor-agent с Compose-профилем `monitoring`;
#   5. проверяет цепочку web → monitor-agent (/health и /status с токеном),
#      не раскрывая токен ни в логах, ни в выводе.
#
# Скрипт идемпотентен: повторный запуск переиспользует существующие ключи
# и просто пересоздаёт контейнеры.
#
# Использование (из любой директории, на сервере с Docker):
#   bash deploy/start-monitoring.sh              # ключи + запуск + проверка
#   bash deploy/start-monitoring.sh --keys-only  # только вставить ключи
#   bash deploy/start-monitoring.sh --check      # проверить агент и прямой Postgres
#   bash deploy/start-monitoring.sh --no-build   # запуск без пересборки
#   bash deploy/start-monitoring.sh --stop       # остановить monitor-agent
#   bash deploy/start-monitoring.sh --env-file /path/to/.env.production
#
# После запуска откройте Админка → Мониторинг под ролью admin.
# Порт monitor-agent не публикуется: агент доступен только изнутри
# Docker-сети и только с Bearer-токеном. Не передавайте MONITOR_AGENT_TOKEN
# в браузер и не монтируйте docker.sock в сервис web.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.production"

# Общий хелпер Compose-файлов: подключает web и monitor-agent к сети
# Supabase, когда стек Supabase найден на этой машине (см. compose-lib.sh).
# shellcheck source=compose-lib.sh
source "$SCRIPT_DIR/compose-lib.sh"

MODE="up"          # up | keys-only | check | stop
DO_BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --keys-only) MODE="keys-only"; shift;;
    --check)     MODE="check"; shift;;
    --stop)      MODE="stop"; shift;;
    --no-build)  DO_BUILD=0; shift;;
    --env-file)  ENV_FILE="${2:?}"; shift 2;;
    -h|--help)   head -34 "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Неизвестный флаг: $1 (см. --help)" >&2; exit 1;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n── %s ──\n' "$*"; }
die()  { echo "Ошибка: $*" >&2; exit 1; }

# 64 hex-символа: openssl → node → /dev/urandom (для минимальных систем).
random_hex32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v node >/dev/null 2>&1; then
    node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  else
    printf '%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
}

env_value() { # FILE KEY — последнее вхождение, пусто если ключа нет
  grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

set_env() { # FILE KEY VALUE — заменить или дописать (как в install.sh)
  local f="$1" k="$2" v="$3"
  if grep -qE "^${k}=" "$f"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

ensure_secret() { # FILE KEY — заполнить пустой/отсутствующий, существующее не трогать
  local f="$1" k="$2"
  if [ -n "$(env_value "$f" "$k")" ]; then
    say "  ✓ $k — уже задан, оставляю"
    return 0
  fi
  set_env "$f" "$k" "$(random_hex32)"
  say "  ✓ $k — сгенерирован и вставлен"
}

ensure_default() { # FILE KEY DEFAULT — то же, но с не-секретным значением
  local f="$1" k="$2" d="$3" current
  current="$(env_value "$f" "$k")"
  if [ -n "$current" ]; then
    say "  ✓ $k=$current"
    return 0
  fi
  set_env "$f" "$k" "$d"
  say "  ✓ $k=$d (по умолчанию)"
}

ensure_keys() {
  step "Ключи мониторинга → $ENV_FILE"
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "$REPO_ROOT/.env.example" ] \
      || die "нет ни $ENV_FILE, ни $REPO_ROOT/.env.example — не из чего создать env-файл"
    cp "$REPO_ROOT/.env.example" "$ENV_FILE"
    say "создан $ENV_FILE из .env.example"
  fi
  ensure_secret  "$ENV_FILE" MONITOR_AGENT_TOKEN
  ensure_secret  "$ENV_FILE" CRON_SECRET
  ensure_default "$ENV_FILE" PROJECT_REPOSITORY    "NooboGreenD/ed-ring-colony"
  ensure_default "$ENV_FILE" PROJECT_UPDATE_BRANCH "main"
  # Сеть Supabase: имя нужно compose-интерполяции в deploy/compose.supabase-net.yml
  # (external network). Определяем по контейнеру supabase-db и фиксируем в
  # env-файле — ДО генерации SUPABASE_DB_URL и зеркалирования MONITOR_DB_URL.
  local supa_net
  supa_net="$(edrc_detect_supabase_network "$ENV_FILE")"
  if [ -n "$supa_net" ]; then
    set_env "$ENV_FILE" SUPABASE_NETWORK "$supa_net"
    say "  ✓ SUPABASE_NETWORK=$supa_net — web и monitor-agent получат доступ к Postgres («db»)"
    # Правильная ссылка для быстрого импорта каталога Spansh и замера размера
    # БД: с общей сетью имя `db` резолвится из web и monitor-agent. Значение
    # не печатаем (пароль), существующие ключи не трогаем.
    if [ -z "$(env_value "$ENV_FILE" SUPABASE_DB_URL)" ] && [ -z "$(env_value "$ENV_FILE" DATABASE_URL)" ]; then
      local db_pass
      db_pass="$(env_value "$ENV_FILE" SUPABASE_DB_PASSWORD)"
      [ -n "$db_pass" ] || db_pass="$(docker inspect supabase-db --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -E '^POSTGRES_PASSWORD=' | cut -d= -f2- || true)"
      if [ -n "$db_pass" ]; then
        set_env "$ENV_FILE" SUPABASE_DB_URL "postgresql://postgres:${db_pass}@db:5432/postgres"
        say "  ✓ SUPABASE_DB_URL — собран как postgresql://postgres:***@db:5432/postgres (сеть $supa_net)"
      else
        say "  ! SUPABASE_DB_URL пуст — для быстрого импорта каталога и замера размера БД задайте"
        say "    postgresql://postgres:ПАРОЛЬ@db:5432/postgres (пароль — POSTGRES_PASSWORD из стека Supabase)"
      fi
    fi
  else
    say "  ! стек Supabase в этой docker-сети не найден (нет контейнера supabase-db и сети *supabase*);"
    say "    если он на другой машине — укажите доступный адрес в SUPABASE_DB_URL/MONITOR_DB_URL"
  fi
  # Размер БД на панели: web-контейнер часто не видит Postgres напрямую
  # (Supabase живёт в своей сети), поэтому monitor-agent меряет сам.
  # Значение не секрет сверх DATABASE_URL — просто зеркалируем без вывода.
  if [ -z "$(env_value "$ENV_FILE" MONITOR_DB_URL)" ]; then
    local db_src
    db_src="$(env_value "$ENV_FILE" DATABASE_URL)"
    [ -n "$db_src" ] || db_src="$(env_value "$ENV_FILE" SUPABASE_DB_URL)"
    if [ -n "$db_src" ]; then
      set_env "$ENV_FILE" MONITOR_DB_URL "$db_src"
      say "  ✓ MONITOR_DB_URL — зеркалирован из DATABASE_URL/SUPABASE_DB_URL"
    else
      say "  ! MONITOR_DB_URL пуст: задайте DATABASE_URL или SUPABASE_DB_URL,"
      say "    иначе блок «Диск и размер базы данных» не посчитает размер БД"
    fi
  else
    say "  ✓ MONITOR_DB_URL — уже задан, оставляю"
  fi
  chmod 600 "$ENV_FILE"
  # Проверка БД на панели зависит от Supabase-ключей сайта; не генерируем их,
  # но предупреждаем, чтобы «Нет данных» в блоке БД не было сюрпризом.
  for k in NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
    [ -n "$(env_value "$ENV_FILE" "$k")" ] \
      || say "  ! $k пуст — блок «База данных» на панели покажет «Нет данных»"
  done
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker не найден; установите Docker или запускайте на сервере"
  docker compose version >/dev/null 2>&1 || die "нужен Docker Compose v2 (docker compose version)"
  docker info >/dev/null 2>&1 || die "нет доступа к Docker daemon (нужен root/sudo или группа docker)"
  cd "$REPO_ROOT"
  local extra=""
  if declare -F edrc_extra_compose_files >/dev/null 2>&1; then
    extra="$(edrc_extra_compose_files "$REPO_ROOT" "$ENV_FILE")"
  fi
  # Сборка без BuildKit (нет плагина buildx / DOCKER_BUILDKIT=0): web получает
  # автогенерируемый Dockerfile без кэш-маунтов — иначе legacy-билдер падает
  # на «the --mount option requires BuildKit».
  local legacy=""
  if declare -F edrc_prepare_legacy_build >/dev/null 2>&1; then
    legacy="$(edrc_prepare_legacy_build "$REPO_ROOT")"
    [ -n "$legacy" ] && say "⚠ BuildKit недоступен — web собирается без кэш-маунтов (медленнее, но работает)"
  fi
  COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml $extra $legacy --profile monitoring)
}

# Метаданные ревизии не секреты: попадут только в runtime-образ web и видны
# только админу. Вне Git-клона безопасное значение — unknown. Значения ещё и
# persist-ятся в env-файл: тогда «ручная» пересборка (docker compose up -d
# --build без этого скрипта) тоже подхватит их через ${APP_GIT_SHA:-unknown}
# из docker-compose.yml, и блок «Версия проекта» перестаёт показывать
# «Точную сверку нельзя выполнить».
export_build_metadata() {
  if git -C "$REPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
    APP_GIT_SHA="${APP_GIT_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
    APP_GIT_REF="${APP_GIT_REF:-$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)}"
  fi
  export APP_GIT_SHA="${APP_GIT_SHA:-unknown}"
  export APP_GIT_REF="${APP_GIT_REF:-unknown}"
  export APP_BUILD_TIME="${APP_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  edrc_persist_env "$ENV_FILE" APP_GIT_SHA    "$APP_GIT_SHA"
  edrc_persist_env "$ENV_FILE" APP_GIT_REF    "$APP_GIT_REF"
  edrc_persist_env "$ENV_FILE" APP_BUILD_TIME "$APP_BUILD_TIME"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  say "сборка: APP_GIT_SHA=${APP_GIT_SHA:0:12} APP_GIT_REF=$APP_GIT_REF (метаданные записаны и в $ENV_FILE)"
}

start_stack() {
  step "Запуск web + jobs + monitor-agent (профиль monitoring)"
  export_build_metadata
  local services=(web jobs monitor-agent)
  # Сторож сети Supabase живёт в update-agent: он раз в минуту переподключает
  # web/monitor-agent к сети `db`, если их пересоздал чужой `docker compose up`
  # без deploy/compose.supabase-net.yml (классическое «подключение срабатывает
  # пару раз и отваливается»). Привилегированный контейнер не поднимаем молча:
  # только когда апдейтер уже включён — задан UPDATE_AGENT_TOKEN.
  if [ -n "$(env_value "$ENV_FILE" UPDATE_AGENT_TOKEN)" ]; then
    services+=(update-agent)
    say "update-agent включён (UPDATE_AGENT_TOKEN задан) — поднимаю и его: сторож сети Supabase будет чинить потерю имени «db» автоматически"
  else
    say "⚠ UPDATE_AGENT_TOKEN пуст — update-agent не запускается, а с ним и сторож сети Supabase; включить: bash deploy/start-update-agent.sh"
  fi
  local up_args=(up -d)
  [ "$DO_BUILD" = 1 ] && up_args+=(--build)
  "${COMPOSE[@]}" "${up_args[@]}" "${services[@]}"
}

# Проверяет ровно тот путь, которым ходит вкладка: web → monitor-agent
# по внутренней сети с Bearer-токеном. Токен передаётся через stdin, чтобы
# не светиться в списке процессов хоста, и не выводится на экран.
verify_agent() {
  step "Проверка monitor-agent"
  local token health status i
  token="$(env_value "$ENV_FILE" MONITOR_AGENT_TOKEN)"
  [ -n "$token" ] || die "MONITOR_AGENT_TOKEN пуст — сначала запустите без --check"

  echo -n "жду ответа агента"
  for i in $(seq 1 30); do
    health="$("${COMPOSE[@]}" exec -T web wget -qO- --timeout=5 http://monitor-agent:8080/health 2>/dev/null || true)"
    case "$health" in *'"ok":true'*) break;; esac
    echo -n "."
    sleep 4
    [ "$i" = 30 ] && { echo; die "monitor-agent /health не ответил; смотрите: ${COMPOSE[*]} logs --tail=50 monitor-agent"; }
  done
  echo " — /health OK"

  status="$(printf '%s\n' "$token" | "${COMPOSE[@]}" exec -T web sh -c \
    'IFS= read -r MONITOR_CHECK_TOKEN; wget -qO- --timeout=8 --header="Authorization: Bearer $MONITOR_CHECK_TOKEN" http://monitor-agent:8080/status' \
    2>/dev/null || true)"
  case "$status" in
    *'"ok":true'*) say "  ✓ /status с токеном отвечает — цепочка web → monitor-agent работает";;
    *) die "/status не отвечает (токен не совпадает или агент не готов); пересоздайте сервисы без --no-build";;
  esac
}

# Проверяет не только DNS, а настоящее Postgres-рукопожатие + SELECT 1 из обоих
# процессов. Прежняя проверка считала один успешный dns.lookup доказательством
# «Postgres доступен», хотя порт мог быть закрыт, пароль неверен или `db`
# резолвился в посторонний адрес. Результат не фатален: сайт и PostgREST могут
# работать без прямого подключения, но оператор сразу видит точную причину.
verify_db_visibility() {
  step "Проверка прямого доступа к Postgres (импорт каталога, размер БД)"
  local svc result

  for svc in web monitor-agent; do
    result="$("${COMPOSE[@]}" exec -T "$svc" node -e '
      const service = process.argv[1];
      const url = service === "monitor-agent"
        ? process.env.MONITOR_DB_URL?.trim()
        : (process.env.DATABASE_URL?.trim() || process.env.SUPABASE_DB_URL?.trim());
      if (!url) { console.log("unconfigured"); process.exit(0); }
      const classify = (error) => {
        const code = String(error?.code || "");
        const text = String(error?.message || "");
        if (/EAI_AGAIN|ENOTFOUND|EAI_FAIL|getaddrinfo/i.test(code + " " + text)) return "dns";
        if (/ECONNREFUSED|ECONNRESET/i.test(code + " " + text)) return "refused";
        if (/timeout|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(code + " " + text)) return "timeout";
        if (/^28|^3D000|password authentication|pg_hba/i.test(code + " " + text)) return "auth";
        return "error";
      };
      import("pg").then(async (loaded) => {
        const pg = loaded.Client ? loaded : loaded.default;
        const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000, query_timeout: 4000 });
        try {
          await client.connect();
          await client.query("SELECT 1");
          console.log("ok");
        } catch (error) {
          console.log(classify(error));
        } finally {
          await client.end().catch(() => {});
        }
      }).catch(() => console.log("module"));
    ' "$svc" 2>/dev/null | tail -n1 || true)"

    case "$result" in
      ok)
        say "  ✓ $svc: подключение к Postgres и SELECT 1 работают"
        ;;
      unconfigured)
        say "  ! $svc: прямой DB-URL не задан"
        ;;
      dns)
        say "  ! $svc: имя хоста БД НЕ резолвится — контейнер не подключён к сети Supabase"
        say "    сеть: docker inspect supabase-db; исправление: bash deploy/start-monitoring.sh --no-build"
        ;;
      refused)
        say "  ! $svc: хост БД виден, но порт Postgres отклонил соединение"
        ;;
      timeout)
        say "  ! $svc: хост БД резолвится, но TCP/рукопожатие истекло по таймауту"
        ;;
      auth)
        say "  ! $svc: сеть работает, но Postgres отклонил пользователя/пароль/имя базы"
        ;;
      module)
        say "  ! $svc: модуль pg отсутствует в образе — пересоберите сервис"
        ;;
      *)
        say "  ! $svc: проверка Postgres завершилась неизвестной ошибкой"
        ;;
    esac
  done
}

stop_agent() {
  step "Остановка monitor-agent"
  "${COMPOSE[@]}" stop monitor-agent
  "${COMPOSE[@]}" rm -f monitor-agent
  say "агент остановлен; панель будет показывать «Агент недоступен», пока не выполните запуск снова"
}

case "$MODE" in
  keys-only)
    ensure_keys
    say "готово; запуск стека: bash deploy/start-monitoring.sh"
    ;;
  check)
    require_docker
    verify_agent
    verify_db_visibility
    ;;
  stop)
    require_docker
    stop_agent
    ;;
  up)
    ensure_keys
    require_docker
    start_stack
    verify_agent
    verify_db_visibility
    "${COMPOSE[@]}" ps
    cat <<EOF

Мониторинг запущен полностью:
  • ключи вставлены в $ENV_FILE (права 600, значения не выводятся);
  • web, jobs и monitor-agent подняты с профилем \`monitoring\`;
  • агент отвечает web'у по внутренней сети.

Откройте Админка → Мониторинг под пользователем с ролью admin.
Логи агента:  docker compose --env-file .env.production --profile monitoring logs -f monitor-agent
Смена ключа:  обнулите MONITOR_AGENT_TOKEN в env-файле и запустите скрипт снова.
EOF
    ;;
esac
