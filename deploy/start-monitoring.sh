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
#   bash deploy/start-monitoring.sh --check      # только проверить агент
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

MODE="up"          # up | keys-only | check | stop
DO_BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --keys-only) MODE="keys-only"; shift;;
    --check)     MODE="check"; shift;;
    --stop)      MODE="stop"; shift;;
    --no-build)  DO_BUILD=0; shift;;
    --env-file)  ENV_FILE="${2:?}"; shift 2;;
    -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -34; exit 0;;
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
  COMPOSE=(docker compose --env-file "$ENV_FILE" --profile monitoring)
}

# Метаданные ревизии не секреты: попадут только в runtime-образ web и видны
# только админу. Вне Git-клона безопасное значение — unknown.
export_build_metadata() {
  if git -C "$REPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
    APP_GIT_SHA="${APP_GIT_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
    APP_GIT_REF="${APP_GIT_REF:-$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)}"
  fi
  export APP_GIT_SHA="${APP_GIT_SHA:-unknown}"
  export APP_GIT_REF="${APP_GIT_REF:-unknown}"
  export APP_BUILD_TIME="${APP_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  say "сборка: APP_GIT_SHA=${APP_GIT_SHA:0:12} APP_GIT_REF=$APP_GIT_REF"
}

start_stack() {
  step "Запуск web + jobs + monitor-agent (профиль monitoring)"
  export_build_metadata
  local up_args=(up -d)
  [ "$DO_BUILD" = 1 ] && up_args+=(--build)
  "${COMPOSE[@]}" "${up_args[@]}" web jobs monitor-agent
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
