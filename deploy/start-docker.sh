#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — штатный запуск и восстановление Docker-стека.
#
# Скрипт поднимает или пересоздаёт контейнеры с правильными параметрами:
#   • публикация порта веб-приложения (по умолчанию 127.0.0.1:3000:3000
#     для работы за nginx/caddy; настраивается через PORT_BIND в env);
#   • автоматическое подключение к внешней сети Supabase (compose-lib.sh)
#     для исключения ошибки «getaddrinfo EAI_AGAIN db»;
#   • передача метаданных ревизии (APP_GIT_SHA / REF / BUILD_TIME);
#   • проверка живости (/api/health) и вывод активных портов.
#
# Если на сервере «слетели порты» (контейнер пересоздан без -p или без
# базового compose-файла) — запустите:
#   bash deploy/start-docker.sh --restart
#
# Использование:
#   bash deploy/start-docker.sh              # запуск / поднятие стека
#   bash deploy/start-docker.sh --restart    # пересоздать контейнеры (вернуть порты)
#   bash deploy/start-docker.sh --build      # пересобрать образы перед запуском
#   bash deploy/start-docker.sh --status     # статус и опубликованные порты
#   bash deploy/start-docker.sh --stop       # остановить контейнеры
#   bash deploy/start-docker.sh --down       # остановить и удалить контейнеры
#   bash deploy/start-docker.sh --logs       # хвост логов web и jobs
#   bash deploy/start-docker.sh --all        # поднять все сервисы (вкл. update-agent)
#   bash deploy/start-docker.sh --env-file /path/.env.production
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.production}"
WEB_URL="${WEB_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"

ACTION="up"           # up | restart | build | status | stop | down | logs
WITH_MONITORING=1
SERVICES="web jobs"
FORCE_RECREATE=0
DO_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --restart)        ACTION="restart"; FORCE_RECREATE=1; shift;;
    --build)          ACTION="build"; DO_BUILD=1; shift;;
    --status)         ACTION="status"; shift;;
    --stop)           ACTION="stop"; shift;;
    --down)           ACTION="down"; shift;;
    --logs)           ACTION="logs"; shift;;
    --all)            SERVICES="web jobs monitor-agent update-agent"; WITH_MONITORING=1; shift;;
    --no-monitoring)  WITH_MONITORING=0; shift;;
    --env-file)       ENV_FILE="${2:?}"; shift 2;;
    -h|--help)        head -26 "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Неизвестный параметр: $1 (см. --help)" >&2; exit 1;;
  esac
done

say()  { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*"; }
die()  { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

cd "$REPO_ROOT"

# ── Проверка Docker и Compose ─────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker не найден; установите Docker (https://get.docker.com)"
compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else die "ни 'docker compose', ни 'docker-compose' не найдены"; fi
}

# ── Env-файл ──────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$REPO_ROOT/.env" ]; then
    ENV_FILE="$REPO_ROOT/.env"
  elif [ -f "$REPO_ROOT/.env.example" ]; then
    warn "$ENV_FILE не найден — копирую из .env.example"
    cp "$REPO_ROOT/.env.example" "$ENV_FILE"
  else
    die "не найден $ENV_FILE (и нет .env.example для шаблона)"
  fi
fi

# Поддерживаем актуальность симлинка .env -> .env.production (Compose читает build-args из .env)
if [ "$ENV_FILE" = "$REPO_ROOT/.env.production" ] && [ ! -e "$REPO_ROOT/.env" ]; then
  ln -sf .env.production "$REPO_ROOT/.env" 2>/dev/null || true
fi

# ── Сеть Supabase (compose-lib.sh) ────────────────────────────────────
EXTRA_FILES=""
if [ -f "$REPO_ROOT/deploy/compose-lib.sh" ]; then
  # shellcheck source=compose-lib.sh
  source "$REPO_ROOT/deploy/compose-lib.sh"
  EXTRA_FILES="$(edrc_extra_compose_files "$REPO_ROOT" "$ENV_FILE")"
fi

# ── Базовая команда Compose ───────────────────────────────────────────
PROFILES=()
if [ "$WITH_MONITORING" = 1 ]; then
  PROFILES+=(--profile monitoring)
fi

compose_run() {
  # $EXTRA_FILES разворачивается как слова (-f path)
  # shellcheck disable=SC2086
  compose --env-file "$ENV_FILE" -f "$REPO_ROOT/docker-compose.yml" $EXTRA_FILES "${PROFILES[@]}" "$@"
}

# ── Обработка действий ────────────────────────────────────────────────
if [ "$ACTION" = "status" ]; then
  say "▶ Статус контейнеров и опубликованные порты:"
  compose_run ps
  exit 0
fi

if [ "$ACTION" = "stop" ]; then
  say "▶ Остановка контейнеров:"
  compose_run stop
  say "Контейнеры остановлены."
  exit 0
fi

if [ "$ACTION" = "down" ]; then
  say "▶ Остановка и удаление контейнеров стека:"
  compose_run down
  say "Стек выключен."
  exit 0
fi

if [ "$ACTION" = "logs" ]; then
  # shellcheck disable=SC2086
  compose_run logs --tail=100 -f $SERVICES
  exit 0
fi

# ── Экспорт метаданных ревизии ────────────────────────────────────────
APP_GIT_SHA="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
APP_GIT_REF="$(git branch --show-current 2>/dev/null || printf 'main')"
APP_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export APP_GIT_SHA APP_GIT_REF APP_BUILD_TIME
if declare -F edrc_persist_env >/dev/null 2>&1; then
  edrc_persist_env "$ENV_FILE" APP_GIT_SHA    "$APP_GIT_SHA"
  edrc_persist_env "$ENV_FILE" APP_GIT_REF    "$APP_GIT_REF"
  edrc_persist_env "$ENV_FILE" APP_BUILD_TIME "$APP_BUILD_TIME"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi

# ── Проверка compose-конфигурации ─────────────────────────────────────
say "▶ Проверяю конфигурацию Compose"
compose_run config --quiet || die "ошибка в конфигурации docker-compose.yml или env-файле"

# ── Запуск / Пересоздание ─────────────────────────────────────────────
UP_ARGS=(-d)
if [ "$DO_BUILD" = 1 ]; then
  UP_ARGS+=(--build)
  say "▶ Сборка и запуск сервисов: $SERVICES"
elif [ "$FORCE_RECREATE" = 1 ]; then
  UP_ARGS+=(--force-recreate)
  say "▶ Принудительное пересоздание сервисов (восстановление портов): $SERVICES"
else
  say "▶ Запуск сервисов: $SERVICES"
fi

# $SERVICES разворачивается намеренно
# shellcheck disable=SC2086
compose_run up "${UP_ARGS[@]}" $SERVICES

# ── Проверка опубликованного порта и живости ──────────────────────────
say "▶ Проверяю доступность приложения на порту 3000..."
probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf --max-time 4 -o /dev/null "$WEB_URL"
  else
    wget -q -T 4 -O /dev/null "$WEB_URL"
  fi
}

HEALTH_OK=0
for i in $(seq 1 "$HEALTH_TRIES"); do
  if probe; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done

echo
if [ "$HEALTH_OK" = 1 ]; then
  say "✓ Сайт успешно отвечает на $WEB_URL"
else
  warn "Сайт не ответил на $WEB_URL за $((HEALTH_TRIES * 2)) с."
  warn "Хвост логов web:"
  compose_run logs --tail=40 web 2>/dev/null || true
fi

say "▶ Текущее состояние контейнеров:"
compose_run ps
say "─────────────────────────────────────────────────────────────────────"
say "Сайт слушает на хосте (порт из PORT_BIND / 127.0.0.1:3000:3000)."
say "Проверка: curl -I http://127.0.0.1:3000"
say "Логи:     bash deploy/start-docker.sh --logs"
