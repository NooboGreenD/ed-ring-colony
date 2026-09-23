#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — применение изменений .env.production (Админка → Мониторинг
# → «API-ключи» → «Применить»).
#
# Его запускает приватный update-agent (kind=env). Скрипт НЕ пересобирает
# образы: он только пересоздаёт сервисы, чтобы они подняли новые
# RUNTIME-ключи из env-файла. Ключи NEXT_PUBLIC_* вшиваются в бандл при
# сборке — для них нужно полное «Обновить сейчас».
#
# Прогресс сообщается машиночитаемыми строками в stdout (формат
# scripts/lib/update-state.mjs, стадии ENV_STAGES):
#   ::edrc::{"stage":"env_switch","percent":40,"message":"..."}
#
# Переменные:
#   PROJECT_DIR      каталог с клоном (default /opt/ed-ring-colony/src)
#   ENV_FILE         env-файл (default $PROJECT_DIR/.env.production)
#   APPLY_ENV_SCOPE  web (по умолчанию) | all (web jobs monitor-agent)
#   UPDATE_HEALTH_URL  что опрашивать после пересоздания
#   SYSTEMD_SERVICE  unit сайта для systemd-режима (default ed-ring-colony)
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env.production}"
SCOPE="${APPLY_ENV_SCOPE:-web}"
HEALTH_URL="${UPDATE_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
SYSTEMD_SERVICE="${SYSTEMD_SERVICE:-ed-ring-colony}"
HEALTH_TRIES="${HEALTH_TRIES:-45}"

json_safe() { printf '%s' "${1:-}" | tr -d '"\\' | tr '\n\r' '  ' | cut -c1-200; }
say()    { printf '%s\n' "$*"; }
report() { printf '::edrc::{"stage":"%s","percent":%s,"message":"%s"}\n' "$1" "$2" "$(json_safe "$3")"; }
die()    { printf '::edrc::{"message":"%s"}\n' "$(json_safe "$*")"; say "ОШИБКА: $*" >&2; exit 1; }
fail() {
  local code="$1" line="$2"
  printf '::edrc::{"message":"%s"}\n' "$(json_safe "применение ключей прервано: строка $line, код $code")"
  exit "$code"
}
trap 'fail $? $LINENO' ERR

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else return 127
  fi
}

# ── 1. режим: Docker-стек или systemd-сайт ───────────────────────────
report env_prepare 10 "Определяю режим применения"
COMPOSE_OK=0
if command -v docker >/dev/null 2>&1 && [ -f "$PROJECT_DIR/docker-compose.yml" ] && docker info >/dev/null 2>&1; then
  COMPOSE_OK=1
fi
if [ "$COMPOSE_OK" = 0 ] && command -v systemctl >/dev/null 2>&1 && systemctl cat "$SYSTEMD_SERVICE.service" >/dev/null 2>&1; then
  :
elif [ "$COMPOSE_OK" = 0 ]; then
  die "не определил режим: нет ни Docker-стека с docker-compose.yml, ни systemd-unit $SYSTEMD_SERVICE"
fi
say "режим применения: $([ "$COMPOSE_OK" = 1 ] && echo compose || echo systemd)"

wait_health() {
  # Как в update-project.sh: curl → wget → пропуск (чтобы не убивать
  # применение из-за отсутствия инструмента).
  if command -v curl >/dev/null 2>&1; then
    for _ in $(seq 1 "$HEALTH_TRIES"); do
      if curl -sf -o /dev/null --max-time 5 "$HEALTH_URL"; then return 0; fi
      sleep 4
    done
  elif command -v wget >/dev/null 2>&1; then
    for _ in $(seq 1 "$HEALTH_TRIES"); do
      if wget -q -T 5 -O /dev/null "$HEALTH_URL"; then return 0; fi
      sleep 4
    done
  else
    say "⚠ нет ни curl, ни wget — пропускаю проверку доступности"
    return 0
  fi
  die "сайт не ответил по $HEALTH_URL за $((HEALTH_TRIES * 4))с; docker logs <проект>-web-1 или journalctl -u $SYSTEMD_SERVICE"
}

# ── 2. пересоздание сервисов ─────────────────────────────────────────
if [ "$COMPOSE_OK" = 1 ]; then
  # Из каталога репозитория — то же имя Compose-проекта, которым работают
  # update-project.sh и start-monitoring.sh (имя берётся из имени каталога).
  cd "$PROJECT_DIR"
  SERVICES="web"
  if [ "$SCOPE" = "all" ]; then SERVICES="web jobs monitor-agent"; fi
  report env_switch 40 "Пересоздаю: $SERVICES (без пересборки образов)"
  if [ -f "$ENV_FILE" ]; then
    compose --env-file "$ENV_FILE" --profile monitoring up -d --force-recreate $SERVICES 2>&1 | sed -e 's/\r$//' | cut -c1-300
  else
    say "⚠ $ENV_FILE не найден — пересоздаю без --env-file"
    compose --profile monitoring up -d --force-recreate $SERVICES 2>&1 | sed -e 's/\r$//' | cut -c1-300
  fi
  report env_verify 90 "Жду, пока сайт ответит"
  wait_health
else
  report env_switch 40 "Перезапускаю $SYSTEMD_SERVICE"
  systemctl restart "$SYSTEMD_SERVICE"
  report env_verify 90 "Жду, пока сайт ответит"
  wait_health
fi

printf '::edrc::{"stage":"done","percent":100,"message":"ключи применены, сайт отвечает"}\n'
say "ПРИМЕНЕНИЕ КЛЮЧЕЙ ЗАВЕРШЕНО"
