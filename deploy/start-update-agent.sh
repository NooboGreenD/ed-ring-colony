#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — включение ручного обновления проекта
# (Админка → Мониторинг → «Обновление проекта»).
#
# Кнопка «Обновить сейчас» физически не может выполняетсяться в контейнере
# сайта: там нет ни git, ни Docker. Поэтому поднимается отдельный приватный
# update-agent (scripts/update-agent.mjs), единственный, кому разрешено
# запускать deploy/update-project.sh. `web` ходит к нему по внутренней сети
# Compose (или по loopback) с ОТДЕЛЬНЫМ Bearer-токеном UPDATE_AGENT_TOKEN.
#
# Режим выбирается автоматически:
#   • Docker-стек (есть проект Compose с сервисом web) → сервис update-agent
#     в профиле monitoring;
#   • обычный systemd-сайт → хостовый unit ed-ring-colony-update.service.
# Принудительно: --compose / --host-unit.
#
# Идемпотентно: существующие ключи не перезаписываются, повторный запуск
# безопасен. Секреты в вывод не попадают.
#
# Использование (на сервере, из корня репозитория):
#   sudo bash deploy/start-update-agent.sh              # ключи + запуск + проверка
#   sudo bash deploy/start-update-agent.sh --keys-only  # только вставить ключи в env
#   sudo bash deploy/start-update-agent.sh --check      # только проверить связность
#   sudo bash deploy/start-update-agent.sh --status     # состояние сервиса
#   sudo bash deploy/start-update-agent.sh --stop       # остановить апдейтер
#   sudo bash deploy/start-update-agent.sh --compose|--host-unit
#   sudo bash deploy/start-update-agent.sh --no-migrations   # миграции только вручную
#   sudo bash deploy/start-update-agent.sh --env-file /path/.env.production
#   sudo bash deploy/start-update-agent.sh --project-dir /srv/ed-ring-colony
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.production"
PROJECT_DIR="$REPO_ROOT"
STATE_DIR=""
SERVICE_NAME="ed-ring-colony-update"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PORT=8092
MODE="auto"        # auto | compose | host
APPLY_MIGRATIONS="1"
ACTION="up"        # up | keys-only | check | status | stop

while [ $# -gt 0 ]; do
  case "$1" in
    --keys-only)  ACTION="keys-only"; shift;;
    --check)      ACTION="check"; shift;;
    --status)     ACTION="status"; shift;;
    --stop)       ACTION="stop"; shift;;
    --compose)    MODE="compose"; shift;;
    --host-unit|--host) MODE="host"; shift;;
    --no-migrations) APPLY_MIGRATIONS="0"; shift;;
    --env-file)   ENV_FILE="${2:?}"; shift 2;;
    --project-dir) PROJECT_DIR="${2:?}"; shift 2;;
    --state-dir)  STATE_DIR="${2:?}"; shift 2;;
    --port)       PORT="${2:?}"; shift 2;;
    -h|--help)    head -27 "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Неизвестный флаг: $1 (см. --help)" >&2; exit 1;;
  esac
done

[ -n "$STATE_DIR" ] || STATE_DIR="$(dirname "$PROJECT_DIR")/update-state"
[ -f "$ENV_FILE" ] || ENV_FILE="$PROJECT_DIR/.env.production"

say()  { printf '%s\n' "$*"; }
step() { printf '\n── %s ──\n' "$*"; }
die()  { echo "Ошибка: $*" >&2; exit 1; }

random_hex32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v node >/dev/null 2>&1; then
    node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  else
    die "нужен openssl или node для генерации токена"
  fi
}

env_value() { grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

set_env() { # FILE KEY VALUE — перезапись без вывода значения
  local f="$1" k="$2" v="$3"
  if grep -qE "^${k}=" "$f"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

ensure_secret() { # существующее значение не трогаем
  local f="$1" k="$2"
  if [ -n "$(env_value "$f" "$k")" ]; then say "  ✓ $k — уже задан, оставляю"; return 0; fi
  set_env "$f" "$k" "$(random_hex32)"
  say "  ✓ $k — сгенерирован"
}

ensure_default() {
  local f="$1" k="$2" d="$3"
  if [ -n "$(env_value "$f" "$k")" ]; then say "  ✓ $k=$(env_value "$f" "$k")"; return 0; fi
  set_env "$f" "$k" "$d"; say "  ✓ $k=$d (по умолчанию)"
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else return 127
  fi
}

detect_mode() {
  [ "$MODE" != "auto" ] && return 0
  MODE="host"
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  # Проект Compose считается «нашим», только если в нём есть сервис web с этим
  # каталогом: иначе можно случайно пересобрать чужой стек.
  if compose_cmd -f "$PROJECT_DIR/docker-compose.yml" --env-file "$ENV_FILE" \
       ps --format '{{.Name}}' >/dev/null 2>&1; then
    MODE="compose"
  fi
}

ensure_keys() {
  step "Ключи апдейтера → $ENV_FILE"
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "$REPO_ROOT/.env.example" ] || die "нет ни $ENV_FILE, ни $REPO_ROOT/.env.example"
    cp "$REPO_ROOT/.env.example" "$ENV_FILE"
    say "создан $ENV_FILE из .env.example"
  fi
  # Отдельный секрет: CRON_SECRET и MONITOR_AGENT_TOKEN не переиспользуются.
  ensure_secret  "$ENV_FILE" UPDATE_AGENT_TOKEN
  ensure_default "$ENV_FILE" PROJECT_REPOSITORY       "NooboGreenD/ed-ring-colony"
  ensure_default "$ENV_FILE" PROJECT_UPDATE_BRANCH    "main"
  ensure_default "$ENV_FILE" PROJECT_DEPLOY_MODE      "auto"
  set_env        "$ENV_FILE" UPDATE_APPLY_MIGRATIONS  "$APPLY_MIGRATIONS"
  say "  ✓ UPDATE_APPLY_MIGRATIONS=$APPLY_MIGRATIONS $(
    [ "$APPLY_MIGRATIONS" = "1" ] && echo "(миграции из pull'а применяются автоматически, с бэкапом базы)" \
      || echo "(миграции — только кнопкой в панели)")"
  if [ "$MODE" = "compose" ]; then
    # Путь к репозиторию на хосте нужен контейнеру:BuildContext резолвится демоном.
    set_env "$ENV_FILE" PROJECT_HOST_DIR "$PROJECT_DIR"
    say "  ✓ PROJECT_HOST_DIR=$PROJECT_DIR"
    set_env "$ENV_FILE" UPDATE_AGENT_URL "http://update-agent:$PORT"
    say "  ✓ UPDATE_AGENT_URL=http://update-agent:$PORT (внутри сети Compose)"
  else
    set_env "$ENV_FILE" UPDATE_AGENT_URL "http://127.0.0.1:$PORT"
    say "  ✓ UPDATE_AGENT_URL=http://127.0.0.1:$PORT (сайт без Docker)"
  fi
  chmod 600 "$ENV_FILE" || true
  for k in PROJECT_REPOSITORY PROJECT_UPDATE_BRANCH; do
    [ -n "$(env_value "$ENV_FILE" "$k")" ] \
      || say "  ! $k пуст — панель не сможет сверить ревизию с GitHub"
  done
}

run_compose() {
  step "Сервис update-agent (профиль monitoring)"
  mkdir -p "$STATE_DIR"
  # `compose up --build update-agent` также собирает его dependency `web`.
  # На малом VPS это без необходимости повторяет долгий Next.js build. Сначала
  # собираем только маленький образ агента, затем запускаем стек без сборки:
  # существующий web при необходимости лишь пересоздастся с новым токеном.
  say "  · собираю только образ update-agent (web не пересобирается)"
  compose_cmd -f "$PROJECT_DIR/docker-compose.yml" --env-file "$ENV_FILE" \
    --profile monitoring build update-agent
  compose_cmd -f "$PROJECT_DIR/docker-compose.yml" --env-file "$ENV_FILE" \
    --profile monitoring up -d --no-build update-agent
  say "  ✓ контейнер $(compose_cmd -f "$PROJECT_DIR/docker-compose.yml" --env-file "$ENV_FILE" ps --format '{{.Name}}' 2>/dev/null | grep update-agent | head -n1 || echo 'update-agent') поднят"
  say "  · журнал апдейтов: $STATE_DIR/update.log (или docker logs <проект>-update-agent-1)"
}

run_host_unit() {
  step "Хостовый unit → $UNIT_PATH"
  command -v node >/dev/null 2>&1 || die "нужен Node.js 22+ на хосте"
  command -v systemctl >/dev/null 2>&1 || die "systemctl не найден: запускайте агента вручную —\n  sudo UPDATE_AGENT_TOKEN=*** -m1 ^UPDATE_AGENT_TOKEN= $ENV_FILE | cut -d= -f2) UPDATE_AGENT_HOST=127.0.0.1 PROJECT_DIR=$PROJECT_DIR node $PROJECT_DIR/scripts/update-agent.mjs &"
  [ -f "$REPO_ROOT/deploy/ed-ring-colony-update.service" ] || die "нет deploy/ed-ring-colony-update.service"
  mkdir -p "$STATE_DIR"
  sed -e "s|/opt/ed-ring-colony/src|$PROJECT_DIR|g" \
      -e "s|/opt/ed-ring-colony/update-state|$STATE_DIR|g" \
      -e "s|EnvironmentFile=-/opt/ed-ring-colony/.env.production|EnvironmentFile=-$ENV_FILE|" \
      "$REPO_ROOT/deploy/ed-ring-colony-update.service" > "$UNIT_PATH"
  chmod 600 "$UNIT_PATH"
  if [ "$(env_value "$ENV_FILE" UPDATE_AGENT_URL)" != "http://127.0.0.1:$PORT" ]; then
    set_env "$ENV_FILE" UPDATE_AGENT_URL "http://127.0.0.1:$PORT"
    say "  ✓ UPDATE_AGENT_URL=http://127.0.0.1:$PORT"
  fi
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || systemctl restart "$SERVICE_NAME"
  say "  ✓ сервис $SERVICE_NAME запущен (права 600 на unit: в EnvironmentFile лежит прод-секрет)"
}

verify() {
  step "Проверка связности"
  local token status
  token="$(env_value "$ENV_FILE" UPDATE_AGENT_TOKEN)"
  [ -n "$token" ] || die "UPDATE_AGENT_TOKEN пуст — сначала выполните запуск без --check"

  echo -n "жду ответа апдейтера"
  local ok=0
  for _ in $(seq 1 15); do
    if compose-or-curl "$token"; then ok=1; break; fi
    echo -n "."; sleep 2
  done
  echo
  [ "$ok" = "1" ] || die "апдейтер не отвечает. См. journalctl -u $SERVICE_NAME -n 50 или docker logs <проект>-update-agent-1"
  say "  ✓ /status отвечает, токен принят"
  say "  ✓ GET  http://127.0.0.1:$PORT/health — без токена: 401"
  printf '%s\n' "$status" | grep -q '"ok":true' && say "  ✓ апдейтер считает, что всё в порядке" || true
}

# curl внутри контейнера апдейтера (там есть curl) или с хоста — как доступно.
compose-or-curl() { # $1 token → 0, если агент ответил
  local token="$1" out=""
  if [ "$MODE" = "compose" ] && docker info >/dev/null 2>&1; then
    out="$(compose_cmd -f "$PROJECT_DIR/docker-compose.yml" --env-file "$ENV_FILE" \
      exec -T update-agent sh -c "curl -sf -H 'Authorization: Bearer $token' http://127.0.0.1:$PORT/status" 2>/dev/null || true)"
  else
    out="$(curl -sf --max-time 3 -H "Authorization: Bearer $token" "http://127.0.0.1:$PORT/status" 2>/dev/null || true)"
  fi
  [ -n "$out" ] || return 1
  status="$out"
  return 0
}

case "$ACTION" in
  keys-only)
    detect_mode; ensure_keys
    say "готово; запуск: sudo bash deploy/start-update-agent.sh"
    ;;
  check)
    detect_mode; verify
    ;;
  status)
    detect_mode
    if [ "$MODE" = "host" ]; then systemctl status "$SERVICE_NAME" --no-pager -n 20 || true
    else compose_cmd -f "$PROJECT_DIR/docker-compose.yml" --env-file "$ENV_FILE" --profile monitoring ps update-agent || true; fi
    token="$(env_value "$ENV_FILE" UPDATE_AGENT_TOKEN)"
    compose-or-curl "$token" >/dev/null 2>&1 || true
    [ -n "${status:-}" ] && printf '%s\n' "$status"
    ;;
  stop)
    detect_mode
    if [ "$MODE" = "host" ]; then
      systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    else
      compose_cmd -f "$PROJECT_DIR/docker-compose.yml" --env-file "$ENV_FILE" stop update-agent 2>/dev/null || true
    fi
    say "апдейтер остановлен; в панели будет «Update-агент недоступен»"
    ;;
  up)
    detect_mode
    [ "$MODE" = "compose" ] && [ ! -f "$REPO_ROOT/deploy/Dockerfile.update-agent" ] \
      && die "нет deploy/Dockerfile.update-agent — запустите скрипт из корня репозитория"
    [ "$MODE" = "host" ] && [ ! -f "$PROJECT_DIR/scripts/update-agent.mjs" ] \
      && die "нет $PROJECT_DIR/scripts/update-agent.mjs"
    ensure_keys
    if [ "$MODE" = "compose" ]; then run_compose; else run_host_unit; fi
    verify
    cat <<EOF

Ручное обновление включено (режим: $MODE).
  • ключи в $ENV_FILE (права 600, значения не выводились);
  • состояние и журнал апдейтов: $STATE_DIR/update-state.json, $STATE_DIR/update.log;
  • перед первым апдейтом убедитесь, что $PROJECT_DIR — чистый git-клон (git status).

Откройте Админка → Мониторинг → «Обновление проекта» → «Обновить сейчас».
Выключить:  sudo bash deploy/start-update-agent.sh --stop
Смена ключа: обнулите UPDATE_AGENT_TOKEN в env-файле, перезапустите апдейтер
             и пересоздайте web (docker compose up -d web / systemctl restart ed-ring-colony).
EOF
    ;;
esac
